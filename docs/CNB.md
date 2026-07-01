# CNB 对象存储开发参考

CNB (cnb.cool / Cloud Native Build) 是腾讯云的 DevOps 平台。本项目用它作为文件/图片存储后端。

> ⚠️ **重要认知**:CNB 没有独立的"对象存储"产品。本项目的存储能力来自 **Git 仓库的 asset 端点**(`/-/upload/imgs`、`/-/upload/files`)—— 它是 issue/PR 附件功能的"免费副产物",不是 Artifact 制品库(后者是 docker/npm 包注册表,域名和 API 完全不同)。

---

## 目录

- [三域名分工](#三域名分工)
- [Token 与权限](#token-与权限)
- [上传流程](#上传流程)
- [imgs vs files](#imgs-vs-files)
- [删除](#删除)
- [访问与下载](#访问与下载)
- [路径格式](#路径格式)
- [已知限制与怪癖](#已知限制与怪癖)
- [本项目中的封装](#本项目中的封装)
- [Swagger 参考](#swagger-参考)

---

## 三域名分工

| 域名 | 角色 | 本项目用途 |
| --- | --- | --- |
| `api.cnb.cool` | **控制面** — REST API(Swagger 2.0) | 申请上传元数据、删除文件、列举 asset |
| `asset.cnb.cool` | **上传数据面** — 预签名 PUT 目标 | 接收文件字节流(`upload_url` 的 host) |
| `cnb.cool` | **内容面** — 公开读/下载 | 浏览器访问已上传文件的内容 |

```
申请上传 ──POST──▶ api.cnb.cool/<slug>/-/upload/imgs
                         │
                         ▼ 返回 upload_url
上传字节 ──PUT───▶ asset.cnb.cool/assets/t/<token>
                         │
                         ▼ 返回 assets.path
读取内容 ──GET───▶ cnb.cool<assets.path>   (公开,无需 auth)
删除文件 ─DELETE─▶ api.cnb.cool/<slug>/-/imgs/<subPath>
```

---

## Token 与权限

在 `cnb.cool/profile/token` 创建个人访问令牌,选择关联仓库 + 授权范围。

| Scope | 能做什么 | 本项目变量 |
| --- | --- | --- |
| `repo-contents:rw` | 上传**图片**(imgs 端点) | `TOKEN_IMG` |
| `repo-notes:rw` | 上传**任意文件**(files 端点) | `TOKEN_FILE` |
| `repo-manage:rw` | **删除** imgs 或 files | `TOKEN_DELETE` |

> 三个 token 可以是同一个(全权限),也可以分开(最小权限原则)。
> ⚠️ 创建令牌时,UI 的"制品库"预设只给 `registry-package` scope —— **不够**。必须手动选 `repo-*` scope。

---

## 上传流程

### 两阶段:申请元数据 → PUT 字节

#### 阶段 1:申请上传元数据

```http
POST https://api.cnb.cool/<slug>/-/upload/imgs    # 或 files
Authorization: Bearer <TOKEN_IMG>                   # 或 TOKEN_FILE
Content-Type: application/json

{ "name": "cat.jpg", "size": 102400 }
```

**响应**:

```jsonc
{
  "assets": {
    "content_type": "image/jpeg",
    "name": "cat.jpg",
    "path": "/user/repo/-/imgs/U3V9.../f869....jpg",   // ← 核心句柄
    "size": 102400
  },
  "upload_url": "https://asset.cnb.cool/assets/t/<opaque-token>"
}
```

> `assets.path` 是后续删除、URL 构造的唯一句柄,务必保存。

#### 阶段 2:PUT 文件字节

```http
PUT https://asset.cnb.cool/assets/t/<token>
Content-Type: application/octet-stream

<raw file bytes>
```

- **无需 Authorization 头**(token 嵌在 URL 里)
- **字节长度必须精确等于** 阶段 1 声明的 `size`,否则 CNB 拒绝 `file size not match`
- 成功返回 200,无响应体(或空)

### 大文件(本项目三阶段上传)

Node Function 有 ~6MB 请求体限制,大文件通过边缘函数 `upload-proxy` 流式转发:

```
客户端 → /api/assets/sign(申请元数据) → 客户端 PUT /upload-proxy/... → complete(写索引)
```

详见 [MECHANISM.md 大文件三阶段上传](./MECHANISM.md#大文件三阶段上传)。这是 EdgeOne 限制,不是 CNB 限制。

---

## imgs vs files

| 方面 | `imgs` | `files` |
| --- | --- | --- |
| **用途** | 图片 | 任意文件 |
| **Token scope** | `repo-contents:rw` | `repo-notes:rw` |
| **内容校验** | **内容嗅探** — 只接受真图片,非图片报错 | 无限制 |
| **path 格式** | `/<slug>/-/imgs/<ID>/<uuid>.<ext>` | `/<slug>/-/files/<ID>/<uuid>/<原始文件名>` |
| **下载 Content-Type** | 正确的图片 MIME | ⚠️ 非媒体文件一律返回 `text/plain` |

### 自动路由

本项目按扩展名自动选择(`_utils.ts:detectUploadType`):

```ts
const IMAGE_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif', 'tiff',
])
const type = IMAGE_EXTS.has(ext) ? 'imgs' : 'files'
```

### imgs 内容嗅探

CNB 的 imgs 端点会**读取文件头部字节验证是否为真图片**,不只看扩展名。传非图片数据:

```json
{ "errcode": 10402, "errmsg": ".xxx file format is not supported" }
```

### files MIME 怪癖

CNB files 端点对 js/css/font/pdf/json/xml/md 等**非媒体文件一律返回 `text/plain`**。本项目的 `file-api` 代理用扩展名查表(`_mime.ts`)覆盖 Content-Type,否则浏览器拒绝执行 js/css 或内联显示 pdf。

---

## 删除

```http
DELETE https://api.cnb.cool/<slug>/-/imgs/<subPath>     # 或 files
Authorization: Bearer <TOKEN_DELETE>
```

- `<subPath>` = `assets.path` 去掉 `/<slug>/-/imgs|files/` 前缀后的部分
- 需要 `repo-manage:rw` scope
- 本项目路径校验(`_validation.ts:isValidAssetPath`)确保 path 以 `/<slug>/-/imgs/` 或 `/<slug>/-/files/` 开头,防止跨仓库删除

```ts
// 从 assets.path 提取删除用的 subPath
const match = path.match(/-\/(?:imgs|files)\/(.+)/)
const subPath = match ? match[1] : path
const deleteUrl = `https://api.cnb.cool/${slug}/-/${isImgs ? 'imgs' : 'files'}/${subPath}`
```

---

## 访问与下载

`assets.path`(如 `/user/repo/-/imgs/ID/uuid.jpg`)有三种访问方式:

| 方式 | URL | 鉴权 | 说明 |
| --- | --- | --- | --- |
| **CNB 直链** | `https://cnb.cool<assets.path>` | 无(公开仓库) | 任何人可访问 |
| **图片代理** | `https://<站点>/img-api/<subPath>` | 无 | CORS `*`,30s 缓存,CSP 防 SVG XSS |
| **文件代理** | `https://<站点>/file-api/<subPath>` | 无 | MIME 修正,内联/附件智能判断 |

> 私有文件(Assets API `public=0`)不走公开代理,经 `assets-api/{service}/{key}` 鉴权下载(X-API-Key + 强隔离)。

### 内联 vs 附件

| 类型 | 行为 |
| --- | --- |
| 图片(`imgs`) | 始终内联(`inline`) |
| 视频/音频 | 内联 |
| pdf/js/css/font | 内联(代理修正 MIME 后) |
| 其他 | 附件下载(`Content-Disposition: attachment`) |

---

## 路径格式

### imgs

```
/<slug>/-/imgs/<ID>/<uuid>.<ext>
└── 示例: /anyuluo/imagescdn/-/imgs/U3V9LHH158HCMyxbKejujA/f869356b-...-cat.jpg
```

- `<ID>` = 仓库内短 ID(base64)
- `<uuid>` = CNB 生成的唯一 ID
- 文件名**不保留**(用 uuid 替代)

### files

```
/<slug>/-/files/<ID>/<uuid>/<原始文件名>
└── 示例: /anyuluo/imagescdn/-/files/U3V9.../a1b2.../report.pdf
```

- **保留原始文件名**(下载时用)
- 多了一层 uuid 目录

### 提取 subPath(代理/删除用)

```ts
// imgs:  /slug/-/imgs/ID/uuid.jpg  →  ID/uuid.jpg
// files: /slug/-/files/ID/uuid/f.pdf  →  ID/uuid/f.pdf
const match = path.match(/-\/(?:imgs|files)\/(.+)/)
const subPath = match ? match[1] : path
```

---

## 已知限制与怪癖

### 1. `size` 必须精确匹配

申请元数据时声明的 `size` 必须等于 PUT 的实际字节数,否则 CNB 拒绝。

### 2. imgs 内容嗅探

imgs 端点验证文件是否为真图片(读头部字节)。扩展名对但内容不对会报 `10402`。

### 3. files MIME 塌缩为 text/plain

非媒体文件(js/css/font/pdf/json)从 CNB 直接下载时 Content-Type 都是 `text/plain`。必须用代理(`file-api`)修正,否则浏览器不执行/不内联。

### 4. bare 端点可能迁移

Swagger 标注 `GET /{repo}/-/imgs/{path}` 和 `GET /{repo}/-/files/{path}` 只返回**未关联**(非 issue/PR)的 asset,"may be moved out of the Assets category in future versions"。这是本项目依赖的核心端点,需关注迁移风险。

### 5. 无公开 size/rate 限制文档

CNB 文档未记载上传大小或频率限制。实际限制来自 EdgeOne(Node Function ~6MB),不是 CNB。本项目代码层有 `MAX_FILE_SIZE=20MB`(可调)。

### 6. 无独立存储产品页面

CNB 的 `/docs/artifact/` 是**包注册表**(docker.cnb.cool / npm.cnb.cool),与本项目用的 repo asset 端点是**两套系统**。本项目用的端点只在 Swagger 里有文档,没有专门的介绍页。

---

## 本项目中的封装

| 封装 | 文件 | 职责 |
| --- | --- | --- |
| `requestUploadMeta` | `node-functions/api/_utils.ts` | POST 申请上传元数据 |
| `uploadToCnb` | `node-functions/api/_utils.ts` | 申请元数据 + PUT 字节(封装完整上传) |
| `signUpload` | `node-functions/api/_utils.ts` | 仅申请元数据(给客户端直传用) |
| `deleteFromCnb` | `node-functions/api/_utils.ts` | DELETE 删除文件 |
| `deleteCnbFile` | `edge-functions/assets-api/[[path]].ts` | DELETE(边缘函数版,懒删除用) |
| `detectUploadType` | `node-functions/api/_utils.ts` | 按扩展名判断 imgs/files |
| `buildAccessUrl` | `node-functions/api/_utils.ts` | 拼代理访问 URL |
| `extractImagePath` | `node-functions/api/_utils.ts` | 从 path 提取 subPath |
| `isValidAssetPath` | `node-functions/api/_validation.ts` | 校验 path 合法性(防跨仓库) |

---

## Swagger 参考

CNB Swagger 2.0 文档地址:`https://api.cnb.cool/swagger.json`(932KB,184 paths)。

### 本项目使用的端点

| 方法 | 路径 | Scope | 用途 |
| --- | --- | --- | --- |
| POST | `/{repo}/-/upload/imgs` | `repo-contents:rw` | 申请图片上传 |
| POST | `/{repo}/-/upload/files` | `repo-notes:rw` | 申请文件上传 |
| GET | `/{repo}/-/imgs/{imgPath}` | BearerAuth | 下载图片 |
| GET | `/{repo}/-/files/{filePath}` | BearerAuth | 下载文件 |
| DELETE | `/{repo}/-/imgs/{imgPath}` | `repo-manage:rw` | 删除图片 |
| DELETE | `/{repo}/-/files/{filePath}` | `repo-manage:rw` | 删除文件 |

### 可用但未使用的端点

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/{slug}/-/list-assets` | 分页列举仓库 asset 记录(`page`/`page_size`) |
| POST | `/{repo}/-/issues/.../asset-upload-url` | issue 附件上传(需 confirm 步骤) |
| POST | `/{repo}/-/releases/.../asset-upload-url` | release 附件上传(需 confirm 步骤) |

> `/-/upload/imgs|files` **不需要** confirm 步骤(与 issue/release 附件不同)。

### 关键 Schema

**`dto.UploadAssetsResponse`**(申请上传的响应):

```jsonc
{
  "assets": {              // dto.Assets
    "content_type": "string",
    "name": "string",
    "path": "string",      // 核心句柄
    "size": "integer"
  },
  "form": "object",        // 上传表单参数(本项目不用)
  "token": "string",       // confirm 用(本项目不用)
  "upload_url": "string"   // PUT 目标
}
```

**`dto.AssetRecords`**(list-assets 返回):

```jsonc
{
  "id": "string",
  "path": "string",
  "origin_path": "string",
  "record_type": "slug_img | slug_file",  // 只有这两种可删
  "size_in_byte": "integer",
  "created_at": "string"
}
```
