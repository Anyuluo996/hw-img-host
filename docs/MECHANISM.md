# 机制实现文档

本文档记录 hw-img-host 中关键机制的实现原理与设计权衡，作为 API 文档的补充。
API 用法见 [API.md](./API.md)。

---

## 目录

- [大文件三阶段上传](#大文件三阶段上传)
- [孤儿自愈](#孤儿自愈)
- [TTL 懒删除](#ttl-懒删除)
- [索引乐观并发](#索引乐观并发)
- [强隔离模型](#强隔离模型)
- [登录路径安全模型](#登录路径安全模型)
- [登录限速](#登录限速)
- [Assets 哈希去重](#assets-哈希去重)
- [node ↔ 边缘函数 委托模式](#node--边缘函数-委托模式)
- [EdgeOne 平台约束](#edgeone-平台约束)

---

## 大文件三阶段上传

### 问题

EdgeOne Pages 的 **Node Function 有 ~6MB 请求体上限**（实测约 5-6MB）。assets 中转 API 原有路径（`POST /api/assets`、`PUT /api/assets/...`、`POST /api/assets/upload`）把整个文件读进 node 内存再转发 CNB，因此无法处理大文件（视频、大 PDF、归档包等）。

### 解决方案：三阶段协议

把"接收大 body"这一步从 node 挪到**边缘函数**（无 body 大小限制），node 只负责轻量的签名与索引操作。

```
阶段1  POST /api/assets/sign        node（无 body）    申请 CNB 元数据 + 预写 pending 索引
阶段2  PUT /upload-proxy/.../<token> 边缘函数（大 body）流式转发 CNB，不经 node
阶段3  POST /api/assets/complete     node（小 JSON body）查 pending + 复写索引为 ready
```

### 关键组件

| 组件 | 文件 | 职责 |
| --- | --- | --- |
| 三阶段路由 | `node-functions/api/routes/assets.ts` | `POST /sign` + `POST /complete` |
| 流式转发 | `edge-functions/upload-proxy/[[path]].ts` | 把 PUT body 流式透传到 `asset.cnb.cool/assets/t/<token>` |
| 索引读写 | `edge-functions/assets-api/[[path]].ts` | KV 索引（pending / ready 记录） |
| CNB 元数据申请 | `node-functions/api/_utils.ts` → `signUpload()` | `POST /{slug}/-/upload/{imgs|files}` 拿 `upload_url` |

### 阶段1 详解：sign

`POST /api/assets/sign?name=&size=&key=?`

1. 调 `signUpload({fileName, fileSize})` → CNB 返回 `{upload_url, assets.path, type}`
2. 从 `upload_url`（形如 `https://asset.cnb.cool/assets/t/<token>`）提取 token
3. 拼出客户端可用 URL：`/upload-proxy/assets/t/<token>`（边缘函数路径）
4. **预写 pending 索引**（带 `cnbPath` + 2h TTL，`status:"uploading"`）—— 见[孤儿自愈](#孤儿自愈)
5. 返回 `{sessionId, uploadUrl, cnbPath, ...}`

> 强隔离：`?key=` 携带时第一段必须等于 key 绑定的 service，否则 403。指定 key 已存在则 409。

### 阶段2 详解：直传

`PUT /upload-proxy/assets/t/<token>`

边缘函数 `upload-proxy/[[path]].ts` 的核心就一行：

```ts
const resp = await fetch(targetUrl, {
  method: 'PUT',
  body: req.body, // ReadableStream 直接转发，不缓存内存
})
```

`req.body` 是 `ReadableStream`，fetch 把它管道式喂给 CNB，边缘函数内存占用恒定（与文件大小无关）。**这是突破 6MB 限制的关键**。

### 阶段3 详解：complete

`POST /api/assets/complete` body `{sessionId, size, hash, ...}`

1. 按 `sessionId` 在边缘 list 里反查 pending 记录（防伪造）
2. 用最终 TTL 复写索引：补全 `size/hash/mime/name`，`status:"ready"`
3. 返回与单次上传一致的结果形状

> 幂等：同一 sessionId 可重复调用（已 ready 则直接复写）。

### 为什么不用 CNB 原生分片？

CNB 的 `asset.cnb.cool/assets/t/<token>` 是**单次 PUT 整文件**端点，没有 multipart/uploadId 协议（至少未公开）。三阶段方案在客户端层面把"准备"和"提交"拆开，但底层仍是单次 PUT —— 这已经能覆盖所有大小场景（CNB 单文件上限远大于 6MB），无需客户端分片。

### 客户端代码骨架

```typescript
// 1. sign
const signRes = await fetch(`/api/assets/sign?name=${name}&size=${file.size}`, {
  headers: { 'X-API-Key': KEY },
})
const { data: { sessionId, uploadUrl } } = await signRes.json()

// 2. 直传（带进度）
await new Promise((resolve, reject) => {
  const xhr = new XMLHttpRequest()
  xhr.open('PUT', uploadUrl)
  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) console.log(Math.round((e.loaded / e.total) * 100) + '%')
  }
  xhr.onload = () => (xhr.status < 300 ? resolve() : reject(new Error(xhr.status)))
  xhr.send(file)
})

// 3. complete
await fetch('/api/assets/complete', {
  method: 'POST',
  headers: { 'X-API-Key': KEY, 'Content-Type': 'application/json' },
  body: JSON.stringify({ sessionId, size: file.size, hash }),
})
```

> 前端图库 `FileUploader.vue` 的 `directUpload()` 已实现类似链路（`src/components/public/FileUploader.vue`），可参考。

---

## 孤儿自愈

### 问题

三阶段上传中，若客户端**完成阶段2（文件已落到 CNB）但没调阶段3**（崩溃、网络中断、用户取消），CNB 上会残留无索引的"孤儿文件"，占用存储且无人引用。

### 解决方案：pending 记录 + sweepExpired

sign 阶段预写的 pending 记录携带 **`cnbPath`**（CNB 文件路径）和 **2h TTL**。这复用了已有的 `sweepExpired()` 机制 —— 该函数在清理过期索引时**本来就会调 `deleteCnbFile()` 删 CNB 实际文件**。

```
sign 预写 pending（cnbPath + 2h TTL）
        │
        ├─ 客户端调 complete ──▶ 索引复写为 ready（TTL 改为真实值）✓ 正常
        │
        └─ 客户端没调 complete ──▶ 2h 后 pending 记录过期
                                      │
                                      ▼
                      该 service 下次 list / index 写入时触发 sweepExpired
                                      │
                      ┌───────────────┴───────────────┐
                      │ 删 KV 记录（asset_{service}_{key}）
                      │ 调 deleteCnbFile(cnbPath) 删 CNB 文件  ← 关键
                      └───────────────────────────────┘
```

### 触发点

`sweepExpired()` 在以下时机被调用（`edge-functions/assets-api/[[path]].ts`）：

| 时机 | 位置 | 说明 |
| --- | --- | --- |
| 写入索引后 | `handleIndexOp` POST /index 之后 | 任何 complete / 新 sign 都会触发该 service 的清理 |
| 列举前 | `handleIndexOp` GET /list 之前 | 每次列举先扫过期 |
| 下载命中过期记录时 | `handleDownload` | 单条即时清理 |

### 为什么这样设计

- **零新增基础设施**：复用 TTL 懒删除已有的"删索引 + 删 CNB 文件"双删逻辑，只需让 pending 记录带 `cnbPath`。
- **最终一致**：清理是惰性的，不保证 1h 精确清理，但保证最终清理（只要该 service 有活动）。极端静默 service 的孤儿会残留，但存储成本低可接受。
- **PENDING_TTL = 2h**：覆盖大文件上传窗口（含网络波动重试）。可调（`assets.ts` 的 `PENDING_TTL_MS`）。

### 手动清理

懒删除依赖 service 有流量才触发。低频/静默 service 的孤儿会残留。提供三个手动清理端点（**JWT 鉴权**，仅管理员可调）：

| 端点 | 作用 | 清理范围 |
| --- | --- | --- |
| `POST /api/assets/sweep?service=` | 单 service 清理过期记录 | KV 记录 + 聚合索引项 + CNB 文件 |
| `POST /api/assets/sweep-all` | 扫描所有 service（`aidx_*`）清理 | 同上，跨 service |
| `POST /api/assets/reconcile?mode=dry-run` | CNB 对账（只报告孤儿） | 不删，返回孤儿列表 |
| `POST /api/assets/reconcile?mode=delete` | CNB 对账（删孤儿文件） | 删 CNB 有但 KV 无的文件 |

**sweep / sweep-all**：复用 `sweepExpired`，扫描索引中 `expiresAt < now` 的记录，双删（KV + CNB）。

**reconcile（CNB 对账）**：最彻底的清理。拉 CNB `list-assets` 全量清单 vs KV 记录，找出 **CNB 有但 KV 无**的孤儿文件。比对数据源按模式区分：
- `dry-run`：从**聚合索引**比对（快，但可能 stale 有少量假阳性 → 只报告不删，无害）
- `delete`：从**每条独立记录**比对（真相源，准确但慢 → **绝不误删真实文件**）

> ⚠️ `rebuildAssetIndex` 曾有泄漏（从聚合索引移除过期项但不删 KV 记录和 CNB 文件），已修复为双删。reconcile 可清理历史泄漏残留。

```bash
# 全量清理（先 sweep 过期记录，再 reconcile CNB 孤儿）
curl -X POST "https://your-domain.com/api/assets/sweep-all" -H "Authorization: Bearer <jwt>"
curl -X POST "https://your-domain.com/api/assets/reconcile?mode=dry-run" -H "Authorization: Bearer <jwt>"
# 确认 orphans 列表合理后
curl -X POST "https://your-domain.com/api/assets/reconcile?mode=delete" -H "Authorization: Bearer <jwt>"
```

---

## TTL 懒删除

平台无 cron / KV TTL 能力，所有过期清理都是**懒删除**：记录写入时存 `expiresAt`，在读写路径上扫描并清理。

### 记录结构

```ts
interface AssetRecord {
  // ...
  expiresAt: string | null  // ISO 时间戳；null = 永不过期
  status?: 'uploading' | 'ready'
}
```

### 清理动作（双删）

`sweepExpired(service)` 扫描该 service 索引，对过期项：

1. **删 KV 记录**：`kv.delete(asset_{service}_{key})`
2. **删 CNB 文件**：`deleteCnbFile(cnbPath)` → `DELETE https://api.cnb.cool/{slug}/-/{imgs|files}/{subPath}`
3. **从索引移除**：`mutateIndex` 过滤掉过期项

单个 CNB 删除失败不阻塞其他项清理（`Promise.all` + `.catch()`）。

### 兜底重建

list 端点有 **1/20 随机概率**从真相源（每条独立 KV 记录）重建聚合索引，修正乐观并发挡不住的极端竞态（见[索引乐观并发](#索引乐观并发)）。

---

## 索引乐观并发

### 问题

EdgeOne KV 是**最终一致**（<60s），无 CAS / 条件写。两个并发请求可能同时读到同一版本，导致后写覆盖先写（丢更新）。

### 解决方案：版本号 + 读改写重试

```ts
interface IndexState {
  ver: number      // 单调递增版本号
  items: AssetRecord[]
}

async function mutateIndex(service, fn) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const state = await getIndexState(service)          // 读 (ver0, items0)
    const { items: next, result } = fn(state.items)      // 内存里算 next
    const fresh = await getIndexState(service)           // 再读一次
    if (fresh.ver !== state.ver) continue                // 期间有人写过 → 重试
    await setIndexState(service, { ver: ver0+1, items: next })  // 写
    return result
  }
  throw new Error('index 写冲突，重试耗尽')
}
```

### 局限

最终一致窗口内仍可能两人读到同一 `ver0`，版本号挡不住。所以 list 端点另有 **rebuild 兜底**（1/20 概率从真相源重建）保证最终一致。

---

## 强隔离模型

每个 `X-API-Key` 绑定一个 `service`（命名空间）。**所有操作只能触碰自己 service 下的资源**。

### 校验点

| 操作 | 校验 |
| --- | --- |
| 上传（PUT 指定 key） | 路径第一段 === callerService |
| 三阶段 sign（带 ?key=） | key 第一段 === callerService |
| 三阶段 complete | pending 记录的 service === callerService（反查校验） |
| 列举 | 强制 service = callerService（不传也用自己） |
| 删除 | 路径第一段 === callerService |
| 私有下载 | 路径第一段 === callerService（边缘函数层校验） |

### 失败响应

鉴权失败一律**空响应**（无 body），仅用 HTTP 状态码区分 401/403/404，**零信息泄露**（不暴露"key 存在但无权"等侧信道）。

---

## 登录路径安全模型

### 问题

登录页如果放在固定路径（如 `/login`），攻击者可以直接访问爆破。需要一个"秘密路径"机制：路径是随机的，不知道路径就看不到登录表单。

### 设计：KV 动态路径 + 三层防护

```
层级1: 秘密路径（16位随机，KV 存储）
       │  不知道路径 → 看不到登录表单
       ▼
层级2: 登录限速（IP 计数，5次/15min）
       │  知道路径也爆破不了
       ▼
层级3: 密码（常量时间比较）
       │  最终验证
```

### 首次初始化流程（由谁触发）

> ⚠️ **当前实现的实情**：前端**不会自动**调用 `GET /login-path` 触发初始化。

- 前端路由 `/`（`RootView`）是静态随机图说明页，不调登录路径 API。
- 路由守卫 `beforeEach` 只做两件事：受保护页无 token → 跳 `/`；已登录访问登录页 → 跳 `/home`。**不触发初始化**。
- 登录页路由是 `/:loginPath`（catch-all，匹配任意单段未知路径），**前端不校验这个值是否等于 KV 里的真实路径**——任何单段路径都能渲染登录表单。
- `POST /api/auth/login` 只验密码，**不校验**请求来自哪个路径。

也就是说，`login_path` 目前是个**可选的秘密值**，真实安全主要由层级 2（限速）+ 层级 3（密码）承担。`GET /login-path` 的"首次自动生成"只在有人**手动 curl** 该端点时才会发生：

```
首次（KV 无 login_path）：
  任何人 GET /api/auth/login-path（无需 token）
   → 边缘函数随机生成 16 位（crypto.randomUUID 去横线截前 16）
   → 写入 KV `login_path`
   → 返回 { loginPath: "a1b2c3..." }
   （一次性初始化；写入后该端点进入 403 模式）

后续（KV 已有 login_path）：
  GET /api/auth/login-path（无 token）→ 403（防止未登录探测）
  GET /api/auth/login-path（有 JWT）  → 返回当前路径
```

### 路径获取规则（`GET /api/auth/login-path`）

| KV 状态 | 鉴权要求 | 行为 |
| --- | --- | --- |
| 无 `login_path`（首次） | 无需 token | 随机生成 16 位 + 写入 KV + 返回（一次性初始化） |
| 有 `login_path` | **需要 JWT** | 有 token → 返回路径；无 token → **403** |

> 攻击者无法通过 API 发现路径。只有已登录的管理员能查看/重置路径。
> 未登录用户访问 `/home` → 重定向到 `/`（主页），**不自动跳转登录**。
> 用户需要**直接输入路径 URL** 才能访问登录表单。

### 重置路径

`PUT /api/auth/login-path`（JWT 鉴权）→ 生成新随机路径，旧的失效。

---

## 登录限速

### 机制

基于 IP 的内存计数限速（`node-functions/api/_auth.ts`）：

- **窗口**：15 分钟
- **上限**：5 次失败尝试
- **超限**：返回 `429` + `Retry-After: 900`
- **成功登录**：清除计数

### 局限

内存计数在 node-function 实例间不共享（多实例水平扩展时各算各的）。对低成本暴力爆破已是数量级提升，但无法防分布式攻击。前端另有 2s 冷却（只挡浏览器 UI，不挡 curl）。

### IP 提取

从 `eo-client-ip` → `x-real-ip` → `x-forwarded-for` 依次尝试。

---

## 通行密钥（WebAuthn）

通行密钥（passkey）用设备内置认证器（指纹/Face ID/PIN）或 USB 安全密钥替代密码登录，凭证（公钥）永不离开设备，钓鱼免疫。

### 信任模型：注册需登录，登录公开

通行密钥只能证明"持有某设备"，不能自举信任。所以：

- **注册端点需 JWT**（`authMiddleware`）：必须先用密码或已有通行密钥登录，再添加新设备。
- **登录端点公开**：任何人都能请求 `login/begin`，但没有已注册的设备就拿不出有效签名。

### 流程（两阶段 ceremony）

```
注册（已登录）：
  POST /passkey/register/begin {name}
    → 生成 challenge，存 KV `pkch_{nonce}`（TTL 5min）
    → 返回 PublicKeyCredentialCreationOptions（含 excludeExisting 防重复注册）
  浏览器 navigator.credentials.create(options)
  POST /passkey/register/verify {resp, nonce, name}
    → verifyRegistrationResponse：验签名 + attestation + challenge
    → 公钥持久化到 KV `passkeys` 聚合 key
    → 返回成功

登录（公开）：
  POST /passkey/login/begin
    → 生成 challenge，存 KV
    → allowCredentials = 全部已注册凭证
  浏览器 navigator.credentials.get(options)
  POST /passkey/login/verify {resp, nonce}
    → verifyAuthenticationResponse：用对应公钥验签名
    → 成功：签发与密码登录同款的 JWT（7d）
    → 失败：recordFailedAttempt（同一套 IP 限速）
```

### RP ID 与域名绑定

`rp.id` = `BASE_IMG_URL` 的 hostname。WebAuthn 规范要求认证器签名的凭证只能用于同 RP ID 的认证。**后果：换域名 = 所有已注册通行密钥失效**（密码登录不受影响，可作兜底重新注册）。

`expectedOrigin` 允许生产域名 + 本地 dev 端口（`http://localhost:5173`、`http://localhost:4173`），因为 WebAuthn 对 localhost 放行（http 也可用）。

### challenge 防重放

每次 ceremony 生成 32 字节随机 challenge，存 KV 单 key `pkch_{nonce}`，**验证时取出后立即删除（一次性消费）**，过期 5 分钟。KV 无原生 TTL，靠内嵌 `expiresAt` 时间戳 + 读时校验实现过期。

### counter 防克隆

每次认证响应携带 authenticator 计数器。`verifyAuthenticationResponse` 比对存储的 counter，若新值 ≤ 旧值则可能是克隆凭证（拒绝）。单用户场景 counter 更新走 `updateCounter`，用乐观并发写 KV，失败不阻断登录（非安全关键路径）。

### 与 JWT 的衔接

WebAuthn 只替换"证明身份"这一步，会话载体仍是 JWT：

- `login/verify` 成功后用 `getSecret()`（JWT_SECRET 优先）签发 7 天 JWT，与密码登录**完全一致**。
- 下游所有 `authMiddleware`（`/upload`、`/delete`、`/kv-api/*`、`/passkey/register/*`）零改动即接受通行密钥签发的 JWT。
- 401 拦截器、localStorage 存储、axios 请求头——全部复用，无需为通行密钥单独建会话。

### 凭证存储：单聚合 key

凭证总数极小（通常 2~10 个），用单 KV key `passkeys = {ver, items: PasskeyCredential[]}` 作为**唯一真相源**，避开最终一致性下的双写竞态（沿用 `akidx_all` 模式）。写入带 `ver` 乐观并发校验，冲突自动重试 reread-merge-rewrite（最多 5 次）。

### 验证库选择

用 `@simplewebauthn/server` 一键搞定 COSE/CBOR/签名验证。Edge runtime 理论可行（WebCrypto 支持 ECDSA P-256 verify）但需手写 COSE→JWK 转换和 CBOR 解码（约 500 行易出错），故验证逻辑全放在 Node Function。

### 多设备支持

每个通行密钥是 `items[]` 中独立一条记录（独立 credential id + 公钥 + counter）。注册时 `excludeCredentials` 列出已有凭证，防止同一 authenticator 重复注册；登录时 `allowCredentials` 列出全部，让用户选择。建议至少注册 2 个设备（主设备 + 备份），避免丢失后无法登录。密码登录始终保留作为最终兜底。

---

## Assets 哈希去重

### 机制

Assets API（`POST /api/assets`、`PUT`、`POST /upload`、三阶段 `complete`）上传前算 SHA-256，查同 service 内是否有相同 hash 的 `ready` 记录。命中则**不传 CNB**，直接复用已有记录的 `cnbPath`/`url`。

```
上传请求 → 算 SHA-256 → GET /assets-api/check-hash?service=&hash=
                           │
                           ├─ 命中（exists:true）→ 复用已有记录，返回 duplicate:true
                           │                       （三阶段 complete 额外删掉刚传的 CNB 文件）
                           │
                           └─ 未命中 → 正常上传 CNB + 写索引
```

### 与图库去重的区别

| | 图库（kv-api） | Assets（assets-api） |
| --- | --- | --- |
| 查重端点 | `GET /kv-api/check?hash=` | `GET /assets-api/check-hash?service=&hash=` |
| 扫描范围 | `img_*`（全局） | `asset_{service}_`（**同 service 内**） |
| 命中行为 | 复用链接，不上传 | 复用记录，不上传（三阶段删 CNB 文件） |

### 设计权衡

- **同 service 内去重**：Assets 强隔离，跨 service 去重无意义（不同 service 可能有意存同一文件的不同副本）
- **查重失败不阻塞**：网络/KV 异常时降级为正常上传（与图库 `checkDuplicateByHash` 同策略）
- **三阶段 complete 去重**：文件已传到 CNB（孤儿），命中时调 `deleteFromCnb` 清理
- **边缘函数 assets-upload 不去重**：算 SHA-256 需读完整文件到内存，与流式上传矛盾

---

## node ↔ 边缘函数 委托模式

Node Function **无法直接访问** EdgeOne 的 KV 绑定（`img_kv`）。所有 KV 读写都通过 HTTP 委托给边缘函数 `assets-api`。

### 机制

```
node 路由                        边缘 assets-api
  │                                │
  │── 自签 JWT（5min, HMAC-SHA256）─│
  │── HTTP 调 /assets-api/index ──▶│ verifyJwt → 操作 KV
  │◀── { code, data } ─────────────│
```

`callAssetsEdge(path, init)`（`assets.ts`）封装了这个调用：自签短期 JWT，附在 `Authorization: Bearer` 头上。边缘函数 `verifyJwt()` 校验签名 + 过期时间。

> ⚠️ **仅 node → 边缘函数方向可用**。边缘函数 → 自身域名的 HTTP 回环调用会失败（见 [EdgeOne 平台约束](#edgeone-平台约束)）。`assets-upload` 边缘函数因此改为直接操作 KV，不经 HTTP。

### 为什么自签 JWT 而非共享密钥头

- JWT 有过期时间（5min），即便被截获窗口也短
- 复用 `UPLOAD_PASSWORD` / `JWT_SECRET` 作为 HMAC 密钥，无需新增配置
- 与 `kv-api` 的内部调用机制完全一致

### 边缘函数 JWT 验签

`edge-functions/assets-api/[[path]].ts` 的 `verifyJwt()` 用 Web Crypto（边缘运行时无 Node `crypto`）：

```ts
const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
return crypto.subtle.verify('HMAC', key, signature, data)
```

---

## EdgeOne 平台约束

开发中踩过的坑，记录以免重蹈覆辙。

### 1. 边缘函数不能 HTTP 回环调用自身域名

**现象**：边缘函数内 `fetch('https://自己的域名/...')` 会失败（超时或连接错误）。

**根因**：EdgeOne 网络层不支持边缘函数 → 自身域名的回环请求。请求会路由回边缘层，但找不到出口。

**影响**：`assets-upload` 最初想通过 HTTP 调 `assets-api/index` 写索引，线上报"已上传但索引失败"。

**解法**：边缘函数之间共享 `img_kv` 绑定，**直接操作 KV**（单条记录 + 聚合索引），绕开 HTTP。node → 边缘函数方向不受影响（node 是 Cloud Function，走正常出站 HTTP）。

```
✅ node-function → fetch(边缘函数)     正常出站 HTTP
❌ edge-function → fetch(同域边缘函数)  回环，失败
✅ edge-function → 直接操作共享 KV      绕开 HTTP
```

### 2. `[[path]].ts` 不匹配根路径（无子段）

**现象**：`edge-functions/foo/[[path]].ts` 只匹配 `/foo/*`（**带子路径段**），不匹配 `/foo`（根路径）。

**根因**：`[[path]]` 是 catch-all 参数，必须有至少一个路径段才命中。根路径请求落到了 SPA fallback。

**影响**：`POST /assets-upload`（PicGo 客户端打根路径）返回 SPA index.html。

**解法**：加 `index.ts` 重新导出 `onRequest`，让 EdgeOne 注册精确路径 `/foo`：

```ts
// edge-functions/foo/index.ts
import { onRequest } from './[[path]]'
export { onRequest }
```

> `upload-proxy` 没 `index.ts` 但正常工作 —— 因为它的请求永远带子路径段（`/upload-proxy/assets/t/<token>`）。

### 3. 构建失败时边缘函数静默不注册

**现象**：边缘函数 TS 有语法错误，esbuild 构建报错，但 EdgeOne **不报错上线**，只是该函数不注册，请求落到 SPA fallback。线上表现为"返回 index.html"，容易被误判为路由或缓存问题。

**解法**：**本地 `edgeone pages dev` 验证**。构建错误会直接打印在 dev 日志里（`ERROR: Unexpected "export"` 等），比线上黑盒好排查得多。

```bash
PAGES_SOURCE=skills edgeone pages dev   # http://localhost:8088
```

### 4. 边缘函数响应默认可被 CDN 缓存

**现象**：边缘函数返回的响应如果没设 `Cache-Control`，EdgeOne CDN 可能缓存结果（`EO-Cache-Status: Cache Hit`），导致后续请求拿到旧响应。

**解法**：动态内容的边缘函数显式设 `Cache-Control: no-store`：

```ts
const NO_STORE = { 'Cache-Control': 'no-store' }
return new Response(body, { headers: { ...NO_STORE } })
```

> `assets-api` 的私有下载设 `private, max-age=60`（合理，同用户短缓存）。`assets-upload` 设 `no-store`（每次都不同）。

---

## 相关文件索引

| 文件 | 职责 |
| --- | --- |
| `node-functions/api/routes/assets.ts` | Assets 中转 API（含三阶段上传） |
| `node-functions/api/routes/assets-keys.ts` | 密钥管理 API |
| `node-functions/api/_utils.ts` | CNB 上传/删除/签名工具 |
| `node-functions/api/_assets_auth.ts` | X-API-Key 校验 |
| `node-functions/api/_passkey.ts` | WebAuthn 通行密钥注册/登录核心 |
| `edge-functions/assets-api/[[path]].ts` | KV 索引 + 私有下载 + 密钥库 |
| `edge-functions/upload-proxy/[[path]].ts` | 大文件流式转发 |
| `edge-functions/assets-upload/[[path]].ts` | PicGo 大文件 multipart（直接写 KV，不经 HTTP 回环） |
| `edge-functions/kv-api/[[path]].ts` | 图库索引（前端用）+ 通行密钥凭证/challenge 存储 |
