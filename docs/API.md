# hw-img-host API 文档

基于 **EdgeOne Pages Functions** + **CNB 对象存储** 的无服务器图床/文件托管服务。

本文档覆盖两类端点：

- **管理端点**（前端页面用，JWT 鉴权）：登录、上传、删除、图库索引、密钥管理
- **Assets 中转 API**（外部服务程序化调用，如 koishi bot / 脚本）：上传 / 下载 / 列举 / 删除文件，`X-API-Key` 鉴权

> 所有示例以 `https://your-domain.com` 为站点域名，实际替换为你的 `BASE_IMG_URL`。

---

## 目录

- [约定](#约定)
- [鉴权](#鉴权)
- [一、Assets 中转 API（外部服务用）](#一assets-中转-api外部服务用)
  - [1.1 上传文件（服务端生成 key）](#11-上传文件服务端生成-key)
  - [1.2 上传文件（指定 key）](#12-上传文件指定-key)
  - [1.3 PicGo / 图床客户端上传（multipart）](#13-picgo--图床客户端上传multipart)
  - [1.4 大文件三阶段上传（突破 6MB 限制）](#14-大文件三阶段上传突破-6mb-限制)
  - [1.5 PicGo / 图床客户端大文件上传（边缘函数，实验性）](#15-picgo--图床客户端大文件上传边缘函数实验性)
  - [1.6 列举文件](#16-列举文件)
  - [1.7 删除文件](#17-删除文件)
  - [1.8 私有下载](#18-私有下载)
  - [1.9 TTL 自动过期](#19-ttl-自动过期)
  - [1.10 孤儿文件清理（管理员维护）](#110-孤儿文件清理管理员维护)
- [二、密钥管理 API](#二密钥管理-api)
- [三、图床管理 API（前端用）](#三图床管理-api前端用)
  - [3.1 登录](#31-登录)
  - [3.2 上传签名（客户端直传）](#32-上传签名客户端直传)
  - [3.3 服务端上传](#33-服务端上传)
  - [3.4 删除文件](#34-删除文件)
  - [3.5 图库索引](#35-图库索引)
- [四、公开访问端点](#四公开访问端点)
- [五、环境变量](#五环境变量)
- [六、错误码](#六错误码)

---

## 约定

### 路径前缀

| 类型 | 前缀 | 运行时 |
| --- | --- | --- |
| Node 路由 | `/api/*` | EdgeOne Pages Node Functions（Express） |
| 边缘函数 | `/{name}/*` | EdgeOne Edge Functions（无 Express） |

### 统一响应格式

所有 JSON 响应遵循：

```jsonc
{
  "code": 0,        // 0 = 成功，1 = 失败
  "msg": "ok",      // 人类可读消息
  "data": { ... }   // 业务数据（失败时可能缺省）
}
```

> **注意**：Assets 中转 API 的鉴权失败一律返回**空响应**（无 body），HTTP 状态码区分 401/403/404，**零信息泄露**。

### HTTP 状态码

| 状态码 | 含义 |
| --- | --- |
| 200 | 成功 |
| 400 | 参数缺失/非法 |
| 401 | 未授权（缺/错 token 或 API Key） |
| 403 | 越权（如访问不属于自己的 service） |
| 404 | 资源不存在 |
| 409 | 冲突（key 已存在） |
| 413 | 文件超 20MB（代码层校验；实际更早被平台 ~6MB 限制拦截） |
| 429 | 登录限速（15min 内 5 次失败，`Retry-After: 900`） |
| 500 / 502 | 服务器错误（**请求体超 ~6MB 平台限制时 500 崩溃**，见[上传端点选择](#上传端点选择)） |

---

## 鉴权

本服务有**三套独立鉴权**：

| 鉴权方式 | 请求头 | 用于 | 说明 |
| --- | --- | --- | --- |
| **JWT**（Bearer） | `Authorization: Bearer <token>` | 管理端点（上传/删除/密钥/图库） | 登录后获取，7 天有效 |
| **X-API-Key** | `X-API-Key: <key>` | Assets 中转 API | 每个服务一把 key，绑定 service |
| 内部 JWT（自签） | `Authorization: Bearer <jwt>` | node ↔ 边缘函数内部调用 | 5 分钟有效，自动生成，调用方无需关心 |

### 获取 JWT（管理端点用）

见 [3.1 登录](#31-登录)。

### 获取 X-API-Key（Assets API 用）

在图床管理页面 `/assets-keys` 创建密钥（见[密钥管理](#二密钥管理-api)），或由管理员配置 `ASSETS_KEYS` 环境变量。每个 key 绑定一个 `service`（授权命名空间）。

---

## 一、Assets 中转 API（外部服务用）

供你自己的服务（koishi bot、脚本等）以程序化方式上传/下载/管理文件。

**鉴权**：`X-API-Key` 请求头。
**强隔离**：URL 路径第一段必须等于 key 绑定的 `service`，否则 403。

#### 上传端点选择

| 端点 | 请求体上限 | 适用场景 | 章节 |
| --- | --- | --- | --- |
| `POST /api/assets` | **~6MB** | 程序化上传，原始字节 | [1.1](#11-上传文件服务端生成-key) |
| `PUT /api/assets/{service}/{key}` | **~6MB** | 程序化上传，指定 key | [1.2](#12-上传文件指定-key) |
| `POST /api/assets/upload` | **~6MB** | PicGo 小文件（图片） | [1.3](#13-picgo--图床客户端上传multipart) |
| 三阶段 `sign` → `upload-proxy` → `complete` | **无限制** | 程序化大文件 | [1.4](#14-大文件三阶段上传突破-6mb-限制) |
| `POST /assets-upload` | **无限制**（实验性） | PicGo 大文件 | [1.5](#15-picgo--图床客户端大文件上传边缘函数实验性) |

> ⚠️ **~6MB 是 EdgeOne 平台对 Node Function 请求体的硬限制**（实测：6MB 通过，8MB 崩溃）。
> 超限不会返回 413，而是 **500 Cloud Function 崩溃**（`INTERNAL_CLOUD_FUNCTION_INVOCATION_FAILED`），
> 因为请求体在代码执行前就被平台层拒绝。**超 6MB 的文件必须用 1.4 或 1.5。**

### 1.1 上传文件（服务端生成 key）

**POST** `/api/assets`

服务端自动生成 key（`原名-时间短哈希.ext`），适合一次性中转。

**Query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | string | 否 | 原始文件名（影响生成 key 与下载文件名）。缺省 `file-<ts>` |
| `public` | string | 否 | `1`/`true` 返回公开 URL；缺省为私有（只能经私有下载拉取） |
| `ttl` | string | 否 | 过期时间，见 [TTL](#19-ttl-自动过期)。缺省 1 天 |

**请求体**：任意 `Content-Type` 的原始字节（非 multipart）。

> ⚠️ **请求体上限 ~6MB**（EdgeOne Node Function 平台限制）。超限会 500 崩溃，不会返回 413。
> 大文件请用[三阶段上传](#14-大文件三阶段上传突破-6mb-限制)。

**示例**

```bash
curl -X POST "https://your-domain.com/api/assets?name=report.pdf&ttl=7d" \
  -H "X-API-Key: k_xxxxxxxx" \
  -H "Content-Type: application/pdf" \
  --data-binary @report.pdf
```

**响应**

```jsonc
{
  "code": 0,
  "msg": "ok",
  "data": {
    "key": "koishi/report-lq2j8a3f-a1b2c3d4.pdf",  // {service}/{key}
    "url": null,                                    // private 时为 null
    "public": false,
    "size": 102400,
    "hash": "sha256...",
    "expiresAt": "2026-07-04T12:00:00.000Z",
    "duplicate": false                              // true = 哈希命中，复用了已有记录
  }
}
```

> **哈希去重**：同 service 内已有相同 SHA-256 的 `ready` 记录时，不重复上传 CNB，直接复用已有记录。响应中 `duplicate: true` 表示命中。三阶段上传的 `complete` 阶段也支持去重（命中时删掉刚传的 CNB 文件）。

### 1.2 上传文件（指定 key）

**PUT** `/api/assets/{service}/{key...}`

指定固定 key 上传（如按业务路径归档）。**key 已存在则 409**。

**路径**

| 段 | 说明 |
| --- | --- |
| `{service}` | 必须等于你的 key 绑定的 service |
| `{key...}` | 可含 `/` 分层，如 `ocr/2026/001.jpg` |

**Query 参数**：`ttl`（见 [TTL](#19-ttl-自动过期)）。指定 key 上传**不支持 public**（始终私有语义，URL 留空）。

> ⚠️ **请求体上限 ~6MB**（同 [1.1](#11-上传文件服务端生成-key)）。大文件请用[三阶段上传](#14-大文件三阶段上传突破-6mb-限制)。

**示例**

```bash
curl -X PUT "https://your-domain.com/api/assets/koishi/ocr/001.jpg?ttl=1w" \
  -H "X-API-Key: k_xxxxxxxx" \
  -H "Content-Type: image/jpeg" \
  --data-binary @001.jpg
```

**响应**：同 [1.1](#11-上传文件服务端生成-key)。冲突时返回 `409 {"code":1,"msg":"key 已存在"}`。

### 1.3 PicGo / 图床客户端上传（multipart）

**POST** `/api/assets/upload`

供 PicGo / PicList 等标准图床客户端直接使用。发 `multipart/form-data`，返回**公开可访问**的图片直链。

**鉴权**：`X-API-Key`（同其他 assets 端点）。
**字段**：`file`（也兼容 `image`），单文件。

**Query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `ttl` | string | 否 | 过期时间，见 [TTL](#19-ttl-自动过期)。缺省 1 天，`0` 永久 |

> 该端点**强制公开**（图床本质即公开），返回的 URL 任何人可访问，无需 key。

**示例**

```bash
curl -X POST "https://your-domain.com/api/assets/upload" \
  -H "X-API-Key: k_xxxxxxxx" \
  -F "file=@cat.png"
```

**响应**

```jsonc
{
  "code": 0,
  "msg": "ok",
  "url": "https://your-domain.com/img-api/ID/uuid.png",   // 顶层 url（兼容简陋插件）
  "data": {
    "key": "koishi/cat-lq2j8a3f-a1b2c3d4.png",
    "url": "https://your-domain.com/img-api/ID/uuid.png",   // 与顶层一致
    "public": true,
    "size": 102400,
    "hash": "sha256...",
    "expiresAt": "2026-06-28T12:00:00.000Z"
  }
}
```

> 响应同时提供**根级 `url`** 与 `data.url`，兼容不同 PicGo 插件的取值方式。

**PicGo 配置示例**

| 配置项 | 值 |
| --- | --- |
| API 地址 | `https://your-domain.com/api/assets/upload` |
| 自定义 Header | `{ "X-API-Key": "k_xxxxxxxx" }` |
| 表单字段名 | `file` |
| JSONPath（取 URL） | `data.url` 或 `url` |

> ⚠️ 该端点受 node-function ~6MB 请求体限制。**大文件请用 [1.5](#15-picgo--图床客户端大文件上传边缘函数实验性)。**

### 1.4 大文件三阶段上传（突破 6MB 限制）

Node Function 有 ~6MB 请求体上限。超过此限制的文件，用**三阶段上传**绕开：客户端直传到边缘函数 `upload-proxy`（流式转发 CNB），不经 node 内存。

**流程**

```
客户端                    node /api/assets              边缘 upload-proxy           CNB
  │                            │                            │                       │
  │── POST /sign ─────────────▶│ 申请上传元数据              │                       │
  │◀── uploadUrl + sessionId ──│ 预写 pending 索引(2h TTL)   │                       │
  │                            │                            │                       │
  │── PUT uploadUrl (大 body) ─────────────────────────────▶│ 流式转发 ────────────▶│
  │◀── 200 ──────────────────────────────────────────────────│                       │
  │                            │                            │                       │
  │── POST /complete ─────────▶│ 复写索引为 ready            │                       │
  │◀── 最终结果 ───────────────│                            │                       │
```

#### 阶段 1：申请上传签名

**POST** `/api/assets/sign`

**Query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | string | 否 | 原始文件名（影响生成 key）。缺省 `file-<ts>` |
| `size` | number | **是** | 文件字节数（用于申请 CNB 上传配额） |
| `key` | string | 否 | 指定 key（PUT 场景）。第一段必须等于你的 service，否则 403。不传则服务端生成 |
| `public` | string | 否 | `1`/`true`（仅服务端生成 key 场景；指定 key 始终私有） |
| `ttl` | string | 否 | 最终记录 TTL，见 [TTL](#19-ttl-自动过期) |

**响应**

```jsonc
{
  "code": 0,
  "msg": "ok",
  "data": {
    "sessionId": "uuid-...",                           // 三阶段会话 ID
    "uploadUrl": "/upload-proxy/assets/t/<token>",     // 客户端 PUT 到此（相对路径）
    "token": "<cnb-token>",
    "cnbPath": "/slug/-/files/ID/uuid.pdf",
    "assets": { "path": "/slug/-/files/ID/uuid.pdf" },
    "type": "files",
    "key": "koishi/report-xxx.pdf"
  }
}
```

> 指定 key 场景若已存在，返回 `409 {"code":1,"msg":"key 已存在"}`。
> sign 阶段会**预写一条 pending 索引**（`status:"uploading"`，2h TTL）。若客户端 2h 内未调 complete，该记录及 CNB 文件会被自动清理（见[机制文档](./MECHANISM.md#孤儿自愈)）。

#### 阶段 2：客户端直传

**PUT** `<uploadUrl>`（即 `/upload-proxy/assets/t/<token>`）

请求体为文件原始字节，`Content-Type: application/octet-stream`。边缘函数流式转发到 CNB，**不经 node 内存**。

```bash
curl -X PUT "https://your-domain.com/upload-proxy/assets/t/<token>" \
  --data-binary @big-file.mp4
```

#### 阶段 3：完成上传

**POST** `/api/assets/complete`

**Body**（JSON）

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `sessionId` | string | **是** | 阶段 1 返回的 sessionId |
| `size` | number | **是** | 实际文件字节数 |
| `hash` | string | 否 | 文件 SHA-256（用于校验/去重） |
| `mime` | string | 否 | MIME 类型，缺省 `application/octet-stream` |
| `displayName` | string | 否 | 展示文件名 |
| `public` | boolean | 否 | 是否公开，缺省 false |
| `ttl` | string | 否 | 最终 TTL，见 [TTL](#19-ttl-自动过期)。缺省 1 天 |

```bash
curl -X POST "https://your-domain.com/api/assets/complete" \
  -H "X-API-Key: k_xxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"uuid-...","size":52428800,"hash":"sha256...","public":false,"ttl":"7d"}'
```

**响应**：同 [1.1](#11-上传文件服务端生成-key) 的 data 结构。

> 幂等：同一 sessionId 重复调用会复写索引（不重复上传）。会话不存在或超时返回 404。

### 1.5 PicGo / 图床客户端大文件上传（边缘函数，实验性）

**POST** `/assets-upload`

> ⚠️ **实验性端点**：EdgeOne 边缘函数对超大 multipart body 的内存承受能力未经实测。若大文件失败，回退到小文件端点 [1.3](#13-picgo--图床客户端上传multipart)。

边缘函数直接接收大 multipart（不经 node-function 的 6MB 限制），解析 `file` 字段后流式 PUT 到 CNB。

**鉴权**：`X-API-Key`（请求头 **或** form 字段均可，方便 PicGo 客户端配置）。
**字段**：`file`（也兼容 `image`），单文件。
**Query**：`public=1`、`ttl=7d`（同 [1.3](#13-picgo--图床客户端上传multipart)）。

```bash
curl -X POST "https://your-domain.com/assets-upload?public=1" \
  -H "X-API-Key: k_xxxxxxxx" \
  -F "file=@big-video.mp4"
```

**响应**：与 [1.3](#13-picgo--图床客户端上传multipart) 同形状（含顶层 `url` + `data`）。

**PicGo 大文件配置示例**

| 配置项 | 值 |
| --- | --- |
| API 地址 | `https://your-domain.com/assets-upload` |
| 自定义 Header | `{ "X-API-Key": "k_xxxxxxxx" }` |
| 表单字段名 | `file` |
| JSONPath | `data.url` 或 `url` |

### 1.6 列举文件

**GET** `/api/assets`

列举**当前 service** 命名空间下的文件（强隔离：只能看自己的）。

**Query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `service` | string | 否 | 缺省取调用方自己的 service |
| `prefix` | string | 否 | key 前缀过滤 |
| `limit` | number | 否 | 上限 500，缺省 100 |

**示例**

```bash
curl "https://your-domain.com/api/assets?prefix=ocr/&limit=20" \
  -H "X-API-Key: k_xxxxxxxx"
```

**响应**

```jsonc
{
  "code": 0,
  "msg": "ok",
  "data": {
    "items": [
      {
        "service": "koishi",
        "key": "ocr/001.jpg",
        "public": false,
        "url": "",
        "cnbPath": "/slug/-/imgs/ID/uuid.jpg",
        "hash": "sha256...",
        "name": "001.jpg",
        "size": 204800,
        "mime": "image/jpeg",
        "createdAt": "2026-06-27T10:00:00.000Z",
        "expiresAt": "2026-07-04T10:00:00.000Z"
      }
    ],
    "total": 1
  }
}
```

> 列举会自动清理已过期记录（懒删除），并随机以一定概率从真相源重建索引，保证最终一致。

### 1.7 删除文件

**DELETE** `/api/assets/{service}/{key...}`

删除实际文件（CNB 对象）+ 索引记录。

**示例**

```bash
curl -X DELETE "https://your-domain.com/api/assets/koishi/ocr/001.jpg" \
  -H "X-API-Key: k_xxxxxxxx"
```

**响应**

```jsonc
{ "code": 0, "msg": "ok" }
// 不存在
{ "code": 1, "msg": "不存在" }  // HTTP 404
```

### 1.8 私有下载

**GET** `/assets-api/{service}/{key...}`

经边缘函数流式转发 CNB 原始字节，不经 node 内存。**注意：这是根级边缘函数路径，不带 `/api` 前缀。**

**鉴权**：`X-API-Key`，且路径第一段必须等于 key 绑定的 service。
**支持**：`Range` 请求（大文件分段）、`Cache-Control: private, max-age=60`。

**示例**

```bash
# 下载文件
curl "https://your-domain.com/assets-api/koishi/ocr/001.jpg" \
  -H "X-API-Key: k_xxxxxxxx" -o 001.jpg

# 带 Range（断点续传）
curl "https://your-domain.com/assets-api/koishi/big.mp4" \
  -H "X-API-Key: k_xxxxxxxx" \
  -H "Range: bytes=1048576-" -o part.mp4
```

**行为**

- 图片：内联展示（`inline`）
- 非图片：附件下载（`Content-Disposition: attachment`），文件名取自记录的 `name`
- 记录已过期：触发懒删除（删 CNB 文件 + 索引）并返回 404

### 1.9 TTL 自动过期

平台无 cron/TTL 能力，采用**懒删除**：记录写入时存 `expiresAt`，在上传/列举/下载时扫描并清理（删 KV 索引 + CNB 实际文件）。

**`ttl` 参数格式**

| 值 | 含义 |
| --- | --- |
| 不传 | 默认 **1 天** |
| `24h` | 24 小时（`h` = 小时） |
| `2d` | 2 天（`d` = 天） |
| `1w` | 1 周（`w` = 周） |
| `0` | **永不过期** |

> 格式非法时回退默认 1 天。

### 1.10 孤儿文件清理（管理员维护）

手动清理孤儿文件（CNB 上有文件但无索引/已过期）。**JWT 鉴权**（图床登录态，非 X-API-Key）。

> 懒删除依赖 service 有流量才触发。低频 service 的孤儿可用这些端点主动清理。
> 详见 [MECHANISM.md 孤儿自愈](./MECHANISM.md#孤儿自愈)。

#### 单 service 清理

**POST** `/api/assets/sweep?service=<name>`

清理指定 service 的过期记录（删 KV 记录 + CNB 文件）。

```bash
curl -X POST "https://your-domain.com/api/assets/sweep?service=koishi" \
  -H "Authorization: Bearer <jwt>"
```

```jsonc
{ "code": 0, "msg": "ok", "data": { "service": "koishi", "cleaned": 3 } }
```

#### 全 service 清理

**POST** `/api/assets/sweep-all`

扫描所有 service（`aidx_*` 聚合索引键），逐个清理过期记录。

```bash
curl -X POST "https://your-domain.com/api/assets/sweep-all" \
  -H "Authorization: Bearer <jwt>"
```

```jsonc
{
  "code": 0, "msg": "ok",
  "data": {
    "services": 5, "cleaned": 12,
    "details": [{ "service": "koishi", "cleaned": 3 }, /* ... */ ]
  }
}
```

#### CNB 对账

**POST** `/api/assets/reconcile?mode=dry-run|delete`

拉取 CNB 全量文件清单，与 KV 索引比对，找出 **CNB 有但 KV 无**的孤儿文件。

| mode | 行为 |
| --- | --- |
| `dry-run`（默认） | 只报告孤儿列表，不删除 |
| `delete` | 删除孤儿 CNB 文件 |

```bash
# 先 dry-run 看有哪些孤儿
curl -X POST "https://your-domain.com/api/assets/reconcile?mode=dry-run" \
  -H "Authorization: Bearer <jwt>"
```

```jsonc
{
  "code": 0, "msg": "对账完成（dry-run）",
  "data": {
    "cnbTotal": 150,      // CNB 侧文件总数
    "kvTotal": 145,       // KV 索引记录总数
    "orphans": [           // CNB 有但 KV 无的孤儿路径
      "/slug/-/imgs/ID/uuid.jpg",
      "/slug/-/files/ID/uuid/report.pdf"
    ],
    "deleted": 0           // dry-run 不删
  }
}
```

```bash
# 确认 orphans 合理后，执行删除
curl -X POST "https://your-domain.com/api/assets/reconcile?mode=delete" \
  -H "Authorization: Bearer <jwt>"
# → { ..., "deleted": 5 }
```

> ⚠️ `reconcile` 需分页拉取 CNB 全量清单，文件多时较慢（数十秒）。`mode=delete` 前建议先 `dry-run` 确认。
>
> **数据源差异**：`dry-run` 从聚合索引比对（快，但可能 stale 有少量假阳性）；`delete` 从每条独立记录比对（真相源，准确但慢，**绝不误删真实文件**）。

---

## 二、密钥管理 API

管理 Assets 中转 API 用的密钥（每服务一把 key）。**JWT 鉴权**（图床登录态）。

> 也可在管理页面 `/assets-keys` 可视化操作。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/assets-keys` | 列举所有密钥（脱敏） |
| POST | `/api/assets-keys` | 创建密钥（返回明文，仅一次） |
| PUT | `/api/assets-keys/:name?rotate=1` | 轮换密钥 / 改备注 |
| DELETE | `/api/assets-keys/:name` | 删除密钥 |

### 列举密钥

**GET** `/api/assets-keys`

```bash
curl "https://your-domain.com/api/assets-keys" \
  -H "Authorization: Bearer <jwt>"
```

```jsonc
{
  "code": 0,
  "msg": "ok",
  "data": {
    "keys": [
      {
        "name": "koishi",
        "keyMasked": "k_20a73954...c94a",  // 脱敏：前 10 + 后 4
        "note": "koishi bot 用",
        "createdAt": "2026-06-27T10:00:00.000Z"
      }
    ]
  }
}
```

### 创建密钥

**POST** `/api/assets-keys`

**Body**：`{ "name": string, "note"?: string }`

- `name`：仅允许字母数字、下划线、横线（1-64 位），即 service 名
- `name` 已存在 → 409

```bash
curl -X POST "https://your-domain.com/api/assets-keys" \
  -H "Authorization: Bearer <jwt>" \
  -H "Content-Type: application/json" \
  -d '{"name":"koishi","note":"koishi bot 用"}'
```

```jsonc
{
  "code": 0,
  "msg": "ok",
  "data": {
    "name": "koishi",
    "key": "k_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",  // 明文，仅返回一次！
    "keyMasked": "k_20a73954...545e"
  }
}
```

> ⚠️ **明文密钥仅此一次返回**，请立即保存到密码管理器。后续只能看到脱敏值或轮换。

### 轮换 / 改备注

**PUT** `/api/assets-keys/:name`

**Query**：`rotate=1` 轮换密钥（生成新 key，旧 key 立即失效）。
**Body**：`{ "note"?: string }`（仅改备注可不带 rotate）

```bash
# 轮换密钥
curl -X PUT "https://your-domain.com/api/assets-keys/koishi?rotate=1" \
  -H "Authorization: Bearer <jwt>"

# 改备注
curl -X PUT "https://your-domain.com/api/assets-keys/koishi" \
  -H "Authorization: Bearer <jwt>" \
  -H "Content-Type: application/json" \
  -d '{"note":"新备注"}'
```

```jsonc
// 轮换成功（返回新明文，仅一次）
{ "code": 0, "msg": "ok", "data": { "key": "k_new...", "keyMasked": "k_new12...abcd" } }
// 仅改备注（不返回 key）
{ "code": 0, "msg": "ok", "data": {} }
```

### 删除密钥

**DELETE** `/api/assets-keys/:name`

```bash
curl -X DELETE "https://your-domain.com/api/assets-keys/koishi" \
  -H "Authorization: Bearer <jwt>"
```

```jsonc
{ "code": 0, "msg": "ok" }
// 不存在
{ "code": 1, "msg": "密钥不存在" }  // HTTP 404
```

---

## 三、图床管理 API（前端用）

前端页面使用的端点，**JWT 鉴权**（`Authorization: Bearer <token>`）。

### 3.1 登录

**POST** `/api/auth/login`

**Body**：`{ "password": string }`

```bash
curl -X POST "https://your-domain.com/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"password":"your-password"}'
```

```jsonc
{ "code": 0, "msg": "登录成功", "data": { "token": "eyJhbGc..." } }
```

Token 7 天有效。后续管理请求带 `Authorization: Bearer <token>`。

> **后端限速**：基于 IP 的失败计数，15 分钟窗口内最多 5 次失败尝试。超限返回 `429`（`Retry-After: 900`）。前端另有 2s 冷却。成功登录清除计数。
> **登录路径**：登录页不在固定 URL，而是动态随机路径（16 位）。首次部署自动生成，管理员可通过 `PUT /api/auth/login-path` 重置。详见[登录路径安全模型](./MECHANISM.md#登录路径安全模型)。

#### 登录路径管理

**GET** `/api/auth/login-path`

返回当前登录路径。鉴权规则：
- KV 无路径（首次）→ 自动随机生成 + 返回（无需 token，一次性初始化）
- KV 已有路径 → **需要 JWT**，否则返回 `403`（防止未登录用户探测路径）

```bash
# 已登录（查看当前路径）
curl "https://your-domain.com/api/auth/login-path" -H "Authorization: Bearer <jwt>"
# → { "code": 0, "data": { "loginPath": "a1b2c3d4e5f6g7h8" } }

# 未登录（KV 已有路径）
curl "https://your-domain.com/api/auth/login-path"
# → 403 Forbidden
```

**PUT** `/api/auth/login-path` — 重置登录路径（生成新随机路径，旧的失效）。**JWT 鉴权**。

```bash
curl -X PUT "https://your-domain.com/api/auth/login-path" -H "Authorization: Bearer <jwt>"
# → { "code": 0, "data": { "loginPath": "新随机路径" } }
```

> 未登录用户访问 `/home` 等受保护页会被重定向到 `/`（主页），不会自动跳转登录页。用户需要**直接输入登录路径 URL** 才能访问登录表单。

### 3.2 上传签名（客户端直传）

**GET** `/api/upload/sign`

获取 CNB 预签名上传 URL，客户端直接 `PUT` 到 CNB（不经服务端转发，省流量）。

**Query**：`name=文件名&size=文件字节数`（size ≤ 20MB）

```bash
curl "https://your-domain.com/api/upload/sign?name=cat.jpg&size=102400" \
  -H "Authorization: Bearer <token>"
```

```jsonc
{
  "code": 0,
  "msg": "ok",
  "data": {
    "upload_url": "https://...cnb.cool/...",   // 客户端 PUT 到此 URL
    "assets": { "path": "/slug/-/imgs/ID/uuid.jpg", "__type": "imgs" },
    "type": "imgs",                              // imgs 图片 / files 其他文件
    "proxy_path": "/img-api/ID/uuid.jpg"         // 访问用的代理路径
  }
}
```

**直传**：`PUT <upload_url>`，请求体为文件字节，`Content-Type: application/octet-stream`。

> 服务端会按文件哈希查重，命中已有文件直接复用链接（见 [3.3](#33-服务端上传) 的 `duplicate` 字段）。

### 3.3 服务端上传

**POST** `/api/upload/img`

由服务端接收（multer，≤ 20MB）后转发到 CNB。**multipart/form-data**。

**字段**

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `file` | 是 | 主文件 |
| `thumbnail` | 否 | 缩略图 |

```bash
curl -X POST "https://your-domain.com/api/upload/img" \
  -H "Authorization: Bearer <token>" \
  -F "file=@cat.jpg" \
  -F "thumbnail=@cat_thumb.jpg"
```

```jsonc
{
  "code": 0,
  "msg": "上传成功",
  "data": {
    "url": "https://your-domain.com/img-api/ID/uuid.jpg",
    "thumbnailUrl": "https://your-domain.com/img-api/ID/uuid_thumb.jpg",
    "assets": { "path": "/slug/-/imgs/ID/uuid.jpg" },
    "type": "imgs",
    "hash": "sha256...",
    "duplicate": false    // true = 命中查重，复用了已有链接
  }
}
```

### 3.4 删除文件

**DELETE** `/api/delete` — 删除单个
**POST** `/api/delete/batch` — 批量删除

**Body**（单个）：`{ "path": "/slug/-/imgs/ID/uuid.jpg" }`（`assets.path`）
**Body**（批量）：`{ "paths": ["...", "..."] }`

```bash
# 单个
curl -X DELETE "https://your-domain.com/api/delete" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"path":"/slug/-/imgs/ID/uuid.jpg"}'

# 批量
curl -X POST "https://your-domain.com/api/delete/batch" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"paths":["/slug/-/imgs/ID/a.jpg","/slug/-/imgs/ID/b.jpg"]}'
```

> 路径必须指向本仓库的 `imgs`/`files`，跨 repo 或非法路径整体拒绝（400）。

### 3.5 图库索引

**GET** `/kv-api` — 列出全部图片（聚合索引，按创建时间倒序）
**GET** `/kv-api/check?hash=<sha256>` — 按哈希查重

> `kv-api` 是 JWT 鉴权的管理端点，CORS 收紧到白名单域名。前端画廊、查重走这里。

```bash
curl "https://your-domain.com/kv-api" \
  -H "Authorization: Bearer <token>"
```

```jsonc
{
  "code": 0,
  "msg": "ok",
  "data": { "images": [ /* RecordItem[]，按 createdAt 倒序 */ ], "total": 42 }
}
```

**维护子路由**（管理员用）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/kv-api/rebuild-idx` | 从每条独立记录重建聚合索引 |
| POST | `/kv-api/rebuild-buckets` | 重建 tag 桶索引（顺带刷新聚合索引） |
| POST | `/assets-api/index?rebuild=1&service=<name>` | 重建某 service 的 assets 索引（内部 JWT） |

---

## 四、公开访问端点

这些端点**无需鉴权**（CORS `*` 开放），用于跨站引用已上传的图片/文件。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/img-api/<path>` | 图片代理 → CNB imgs（透传 Range，30s 缓存，防 SVG XSS） |
| GET | `/file-api/<path>` | 文件代理 → CNB files（自动修正 MIME，视频/音频/图片内联，其余下载） |
| GET | `/img` | 随机图端点（从 tag 桶索引取，1 次 KV get） |

**路径来源**：上传返回的 `proxy_path`（如 `/img-api/ID/uuid.jpg`）或 `url` 字段。

```bash
# 直接访问图片（无需 token）
curl "https://your-domain.com/img-api/ID/uuid.jpg" -o cat.jpg
```

> 私有文件（Assets API `public=0` 上传的）**不能**经此公开端点访问，只能经 [私有下载](#18-私有下载)。

---

## 五、环境变量

在 EdgeOne 控制台配置（不在 `.env` 中）。

### 基础

| 变量 | 说明 |
| --- | --- |
| `BASE_IMG_URL` | 站点域名（**结尾带斜杠**） |
| `SLUG_IMG` | CNB 图床仓库名（如 `user/repo`） |
| `TOKEN_IMG` | CNB 访问令牌（imgs 读写） |
| `TOKEN_FILE` | CNB 访问令牌（files 读写，需 `repo-notes:rw`） |
| `TOKEN_DELETE` | CNB 删除令牌（需 `repo-manage:rw`） |
| `UPLOAD_PASSWORD` | 登录密码（未设则登录不可用） |
| `JWT_SECRET` | JWT 签名密钥（**强烈建议独立配置**，`openssl rand -hex 32`） |
| `KV_ALLOWED_ORIGINS` | `kv-api` CORS 白名单（逗号分隔） |

### Assets 中转 API

| 变量 | 说明 | 示例 |
| --- | --- | --- |
| `ASSETS_KEYS` | 密钥 fallback（JSON），优先用页面创建的密钥库 | `{"koishi":"k_xxx","script":"k_yyy"}` |

> 密钥查询顺序：**KV 密钥库**（页面创建的）→ `ASSETS_KEYS` 环境变量 fallback。

---

## 六、错误码

### Assets 中转 API（零信息泄露）

| HTTP | 含义 | 场景 |
| --- | --- | --- |
| 401 | 空 body | 缺失 / 错误的 `X-API-Key` |
| 403 | 空 body | 路径第一段 ≠ key 绑定的 service |
| 404 | 空 body | 文件不存在 / 已过期 |
| 413 | 空 body | 文件 > 20MB（仅代码层校验，实际更早被平台限制拦截，见下） |
| 400 | 空 body | 路径段不足 / 空文件 |
| 500 | HTML 错误页 | **请求体超 ~6MB 平台限制**（`INTERNAL_CLOUD_FUNCTION_INVOCATION_FAILED`），node-function 崩溃 |

> 出于安全，401/403/404/413 **不返回任何 body**，调用方按状态码处理。
>
> ⚠️ **500 崩溃无法在代码层规避**：请求体在 node 代码执行前就被 EdgeOne 平台层拒绝。
> 实测阈值 ~6-8MB 之间。超限请改用[三阶段上传](#14-大文件三阶段上传突破-6mb-限制)或[/assets-upload](#15-picgo--图床客户端大文件上传边缘函数实验性)。

### 其他端点

返回标准 `{ code, msg }`，`code: 1` 表示失败，`msg` 含可读原因。
