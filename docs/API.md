# hw-img-host API 文档

基于 **EdgeOne Pages Functions** + **CNB 对象存储** 的无服务器图床/文件托管服务。

本文档覆盖两类端点：

- **管理端点**（前端页面用，JWT 鉴权）：登录、上传、删除、图库索引、密钥管理
- **Assets 中转 API**（外部服务程序化调用，如 koishi bot / 脚本）：上传 / 下载 / 列举 / 删除文件，`X-API-Key` 鉴权

> 所有示例以 `https://cdn.anyul.cn` 为站点域名，实际替换为你的 `BASE_IMG_URL`。

---

## 目录

- [约定](#约定)
- [鉴权](#鉴权)
- [一、Assets 中转 API（外部服务用）](#一assets-中转-api外部服务用)
  - [1.1 上传文件（服务端生成 key）](#11-上传文件服务端生成-key)
  - [1.2 上传文件（指定 key）](#12-上传文件指定-key)
  - [1.3 PicGo / 图床客户端上传（multipart）](#13-picgo--图床客户端上传multipart)
  - [1.4 列举文件](#14-列举文件)
  - [1.5 删除文件](#15-删除文件)
  - [1.6 私有下载](#16-私有下载)
  - [1.7 TTL 自动过期](#17-ttl-自动过期)
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
| 413 | 文件超限（20MB） |
| 500 / 502 | 服务器错误 |

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

### 1.1 上传文件（服务端生成 key）

**POST** `/api/assets`

服务端自动生成 key（`原名-时间短哈希.ext`），适合一次性中转。

**Query 参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | string | 否 | 原始文件名（影响生成 key 与下载文件名）。缺省 `file-<ts>` |
| `public` | string | 否 | `1`/`true` 返回公开 URL；缺省为私有（只能经私有下载拉取） |
| `ttl` | string | 否 | 过期时间，见 [TTL](#17-ttl-自动过期)。缺省 1 天 |

**请求体**：任意 `Content-Type` 的原始字节（非 multipart）。

**示例**

```bash
curl -X POST "https://cdn.anyul.cn/api/assets?name=report.pdf&ttl=7d" \
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
    "expiresAt": "2026-07-04T12:00:00.000Z"
  }
}
```

### 1.2 上传文件（指定 key）

**PUT** `/api/assets/{service}/{key...}`

指定固定 key 上传（如按业务路径归档）。**key 已存在则 409**。

**路径**

| 段 | 说明 |
| --- | --- |
| `{service}` | 必须等于你的 key 绑定的 service |
| `{key...}` | 可含 `/` 分层，如 `ocr/2026/001.jpg` |

**Query 参数**：`ttl`（见 [TTL](#17-ttl-自动过期)）。指定 key 上传**不支持 public**（始终私有语义，URL 留空）。

**示例**

```bash
curl -X PUT "https://cdn.anyul.cn/api/assets/koishi/ocr/001.jpg?ttl=1w" \
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
| `ttl` | string | 否 | 过期时间，见 [TTL](#17-ttl-自动过期)。缺省 1 天，`0` 永久 |

> 该端点**强制公开**（图床本质即公开），返回的 URL 任何人可访问，无需 key。

**示例**

```bash
curl -X POST "https://cdn.anyul.cn/api/assets/upload" \
  -H "X-API-Key: k_xxxxxxxx" \
  -F "file=@cat.png"
```

**响应**

```jsonc
{
  "code": 0,
  "msg": "ok",
  "url": "https://cdn.anyul.cn/img-api/ID/uuid.png",   // 顶层 url（兼容简陋插件）
  "data": {
    "key": "koishi/cat-lq2j8a3f-a1b2c3d4.png",
    "url": "https://cdn.anyul.cn/img-api/ID/uuid.png",   // 与顶层一致
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
| API 地址 | `https://cdn.anyul.cn/api/assets/upload` |
| 自定义 Header | `{ "X-API-Key": "k_xxxxxxxx" }` |
| 表单字段名 | `file` |
| JSONPath（取 URL） | `data.url` 或 `url` |

### 1.4 列举文件

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
curl "https://cdn.anyul.cn/api/assets?prefix=ocr/&limit=20" \
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

### 1.5 删除文件

**DELETE** `/api/assets/{service}/{key...}`

删除实际文件（CNB 对象）+ 索引记录。

**示例**

```bash
curl -X DELETE "https://cdn.anyul.cn/api/assets/koishi/ocr/001.jpg" \
  -H "X-API-Key: k_xxxxxxxx"
```

**响应**

```jsonc
{ "code": 0, "msg": "ok" }
// 不存在
{ "code": 1, "msg": "不存在" }  // HTTP 404
```

### 1.6 私有下载

**GET** `/assets-api/{service}/{key...}`

经边缘函数流式转发 CNB 原始字节，不经 node 内存。**注意：这是根级边缘函数路径，不带 `/api` 前缀。**

**鉴权**：`X-API-Key`，且路径第一段必须等于 key 绑定的 service。
**支持**：`Range` 请求（大文件分段）、`Cache-Control: private, max-age=60`。

**示例**

```bash
# 下载文件
curl "https://cdn.anyul.cn/assets-api/koishi/ocr/001.jpg" \
  -H "X-API-Key: k_xxxxxxxx" -o 001.jpg

# 带 Range（断点续传）
curl "https://cdn.anyul.cn/assets-api/koishi/big.mp4" \
  -H "X-API-Key: k_xxxxxxxx" \
  -H "Range: bytes=1048576-" -o part.mp4
```

**行为**

- 图片：内联展示（`inline`）
- 非图片：附件下载（`Content-Disposition: attachment`），文件名取自记录的 `name`
- 记录已过期：触发懒删除（删 CNB 文件 + 索引）并返回 404

### 1.7 TTL 自动过期

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
curl "https://cdn.anyul.cn/api/assets-keys" \
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
curl -X POST "https://cdn.anyul.cn/api/assets-keys" \
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
    "key": "k_20a7395a54d998bbdefcc6bed1797c94a8fe51bee95c545e",  // 明文，仅返回一次！
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
curl -X PUT "https://cdn.anyul.cn/api/assets-keys/koishi?rotate=1" \
  -H "Authorization: Bearer <jwt>"

# 改备注
curl -X PUT "https://cdn.anyul.cn/api/assets-keys/koishi" \
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
curl -X DELETE "https://cdn.anyul.cn/api/assets-keys/koishi" \
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
curl -X POST "https://cdn.anyul.cn/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"password":"your-password"}'
```

```jsonc
{ "code": 0, "msg": "登录成功", "data": { "token": "eyJhbGc..." } }
```

Token 7 天有效。后续管理请求带 `Authorization: Bearer <token>`。

### 3.2 上传签名（客户端直传）

**GET** `/api/upload/sign`

获取 CNB 预签名上传 URL，客户端直接 `PUT` 到 CNB（不经服务端转发，省流量）。

**Query**：`name=文件名&size=文件字节数`（size ≤ 20MB）

```bash
curl "https://cdn.anyul.cn/api/upload/sign?name=cat.jpg&size=102400" \
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
curl -X POST "https://cdn.anyul.cn/api/upload/img" \
  -H "Authorization: Bearer <token>" \
  -F "file=@cat.jpg" \
  -F "thumbnail=@cat_thumb.jpg"
```

```jsonc
{
  "code": 0,
  "msg": "上传成功",
  "data": {
    "url": "https://cdn.anyul.cn/img-api/ID/uuid.jpg",
    "thumbnailUrl": "https://cdn.anyul.cn/img-api/ID/uuid_thumb.jpg",
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
curl -X DELETE "https://cdn.anyul.cn/api/delete" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"path":"/slug/-/imgs/ID/uuid.jpg"}'

# 批量
curl -X POST "https://cdn.anyul.cn/api/delete/batch" \
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
curl "https://cdn.anyul.cn/kv-api" \
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
curl "https://cdn.anyul.cn/img-api/ID/uuid.jpg" -o cat.jpg
```

> 私有文件（Assets API `public=0` 上传的）**不能**经此公开端点访问，只能经 [私有下载](#15-私有下载)。

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
| 413 | 空 body | 文件 > 20MB |
| 400 | 空 body | 路径段不足 / 空文件 |

> 出于安全，401/403/404/413 **不返回任何 body**，调用方按状态码处理。

### 其他端点

返回标准 `{ code, msg }`，`code: 1` 表示失败，`msg` 含可读原因。
