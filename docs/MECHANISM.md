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
4. **预写 pending 索引**（带 `cnbPath` + 1h TTL，`status:"uploading"`）—— 见[孤儿自愈](#孤儿自愈)
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

sign 阶段预写的 pending 记录携带 **`cnbPath`**（CNB 文件路径）和 **1h TTL**。这复用了已有的 `sweepExpired()` 机制 —— 该函数在清理过期索引时**本来就会调 `deleteCnbFile()` 删 CNB 实际文件**。

```
sign 预写 pending（cnbPath + 1h TTL）
        │
        ├─ 客户端调 complete ──▶ 索引复写为 ready（TTL 改为真实值）✓ 正常
        │
        └─ 客户端没调 complete ──▶ 1h 后 pending 记录过期
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
- **PENDING_TTL = 1h**：覆盖大多数大文件上传窗口（几百 MB 视频在普通带宽下几分钟完成）。可调（`assets.ts` 的 `PENDING_TTL_MS`）。

### 手动清理

懒删除依赖 service 有流量才触发。低频/静默 service 的孤儿会残留。提供三个手动清理端点（**JWT 鉴权**，仅管理员可调）：

| 端点 | 作用 | 清理范围 |
| --- | --- | --- |
| `POST /api/assets/sweep?service=` | 单 service 清理过期记录 | KV 记录 + 聚合索引项 + CNB 文件 |
| `POST /api/assets/sweep-all` | 扫描所有 service（`aidx_*`）清理 | 同上，跨 service |
| `POST /api/assets/reconcile?mode=dry-run` | CNB 对账（只报告孤儿） | 不删，返回孤儿列表 |
| `POST /api/assets/reconcile?mode=delete` | CNB 对账（删孤儿文件） | 删 CNB 有但 KV 无的文件 |

**sweep / sweep-all**：复用 `sweepExpired`，扫描索引中 `expiresAt < now` 的记录，双删（KV + CNB）。

**reconcile（CNB 对账）**：最彻底的清理。拉 CNB `list-assets` 全量清单 vs KV `asset_*` 记录，找出 **CNB 有但 KV 无**的孤儿文件（包括 `rebuildAssetIndex` 历史泄漏的、手动删了索引但没删 CNB 的等）。`dry-run` 只报告，`delete` 删除。

> ⚠️ `rebuildAssetIndex` 曾有泄漏（从聚合索引移除过期项但不删 KV 记录和 CNB 文件），已修复为双删。reconcile 可清理历史泄漏残留。

```bash
# 全量清理（先 sweep 过期记录，再 reconcile CNB 孤儿）
curl -X POST "https://cdn.anyul.cn/api/assets/sweep-all" -H "Authorization: Bearer <jwt>"
curl -X POST "https://cdn.anyul.cn/api/assets/reconcile?mode=dry-run" -H "Authorization: Bearer <jwt>"
# 确认 orphans 列表合理后
curl -X POST "https://cdn.anyul.cn/api/assets/reconcile?mode=delete" -H "Authorization: Bearer <jwt>"
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
| `edge-functions/assets-api/[[path]].ts` | KV 索引 + 私有下载 + 密钥库 |
| `edge-functions/upload-proxy/[[path]].ts` | 大文件流式转发 |
| `edge-functions/assets-upload/[[path]].ts` | PicGo 大文件 multipart（直接写 KV，不经 HTTP 回环） |
| `edge-functions/kv-api/[[path]].ts` | 图库索引（前端用） |
