# 开发指南

本文档面向 hw-img-host 的开发者,覆盖环境搭建、本地开发、代码规范、平台边界与调试技巧。
API 用法见 [API.md](./API.md),机制原理见 [MECHANISM.md](./MECHANISM.md)。

---

## 目录

- [技术栈](#技术栈)
- [环境搭建](#环境搭建)
- [常用命令](#常用命令)
- [本地开发](#本地开发)
- [项目结构](#项目结构)
- [代码规范](#代码规范)
- [平台边界与限制](#平台边界与限制)
- [调试技巧](#调试技巧)
- [部署](#部署)
- [测试](#测试)

---

## 技术栈

| 层 | 技术 | 说明 |
| --- | --- | --- |
| 前端 | Vue 3 + TypeScript | `<script setup>`,Composition API |
| 构建 | Vite 8 | HMR 开发,生产构建 |
| 样式 | Tailwind CSS v4 | `@tailwindcss/vite` 插件,无 PostCSS/tailwind.config |
| UI | shadcn-vue | `new-york` 风格,`neutral` 基色,CSS 变量主题 |
| 后端 (Node) | EdgeOne Node Cloud Functions | Express 5,有 npm,有 ~6MB body 限制 |
| 后端 (Edge) | EdgeOne Edge Functions | V8 运行时,无 Node 内建模块,有 KV |
| 存储 | CNB 对象存储 + EdgeOne KV | CNB 存文件字节,KV 存索引 |
| 包管理 | pnpm 11 | `packageManager` 锁定版本 |
| Node | ^20.19.0 \|\| >=22.12.0 | 见 `engines` |

---

## 环境搭建

### 前置要求

- **Node.js** ^20.19.0 或 >=22.12.0
- **pnpm** 11.0.9(`corepack enable` 自动启用,或 `npm i -g pnpm@11.0.9`)
- **EdgeOne CLI**(`npm i -g edgeone`)—— 用于本地 dev 和部署

### 安装

```bash
git clone https://github.com/Anyuluo996/hw-img-host.git
cd hw-img-host
pnpm install
```

### 环境变量

环境变量在 **EdgeOne 控制台配置**,不在代码或 `.env` 中(`.env` 仅本地 dev 用,已 gitignore)。

本地开发时,用 CLI 从线上拉取:

```bash
PAGES_SOURCE=skills edgeone pages link     # 首次:关联项目
PAGES_SOURCE=skills edgeone pages env pull # 拉取环境变量到 .env
```

所需变量(8 个):

| 变量 | 说明 | 示例 |
| --- | --- | --- |
| `BASE_IMG_URL` | 站点域名 | `https://cdn.anyul.cn/` |
| `SLUG_IMG` | CNB 图床仓库 | `user/repo` |
| `TOKEN_IMG` | CNB token(imgs 读写) | |
| `TOKEN_FILE` | CNB token(files,需 `repo-notes:rw`) | |
| `TOKEN_DELETE` | CNB token(删除,需 `repo-manage:rw`) | |
| `UPLOAD_PASSWORD` | 登录密码(兼 JWT 密钥 fallback) | |
| `JWT_SECRET` | JWT 签名密钥(**建议独立配置**)`openssl rand -hex 32` | |
| `KV_ALLOWED_ORIGINS` | kv-api CORS 白名单(逗号分隔) | |
| `ASSETS_KEYS` | Assets API 密钥 fallback(JSON) | `{"koishi":"k_xxx"}` |

> ⚠️ `.env` 含真实密钥,**切勿提交**。`.gitignore` 已排除。

---

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `pnpm dev` | Vite 前端开发服务器(`localhost:5173`) |
| `pnpm build` | type-check + 生产构建(并行) |
| `pnpm type-check` | `vue-tsc --build` 类型检查(仅 `src/`) |
| `pnpm lint` | `eslint . --fix` 全项目 lint |
| `pnpm format` | `prettier --write src/`(仅 src/) |
| `pnpm test` | `vitest run` 单次测试 |
| `pnpm test:watch` | `vitest` 监听模式 |
| `pnpm test:coverage` | `vitest run --coverage` 覆盖率 |
| `pnpm preview` | 预览生产构建 |

> `pnpm build` 可传参:`pnpm build -- --mode staging`

---

## 本地开发

### 前端 + 函数全栈本地开发

用 EdgeOne CLI 启动全栈 dev server(前端 + Node Function + Edge Function + KV,全部在 `localhost:8088`):

```bash
PAGES_SOURCE=skills edgeone pages dev
```

这会:
- 拉取环境变量到 `.env`
- 绑定 KV(本地 mock,与线上同名)
- 启动 Vite 前端(`:8088`)
- 启动 Node Function dev server(`:9000` 内部)
- 启动 Edge Function dev server

> ⚠️ 启动时会问"Sync environment variables?"——输 `y`。
> ⚠️ **不要**把 `edgeone pages dev` 配为 `edgeone.json` 的 `devCommand` 或 `package.json` 的 `dev` 脚本(会导致无限递归)。

### 仅前端开发

如果只改前端 UI,不涉及函数:

```bash
pnpm dev    # localhost:5173,纯 Vite HMR
```

但 API 请求会打到 `localhost:5173`(没有后端),需要配置代理或用全栈 dev。

### 本地测试函数

全栈 dev 启动后,所有端点在 `localhost:8088` 可用:

```bash
# 测小文件上传
curl -X POST "http://localhost:8088/api/assets?name=t.txt" \
  -H "X-API-Key: k_xxx" --data-binary @t.txt

# 测边缘函数
curl "http://localhost:8088/assets-api" -H "X-API-Key: k_xxx"

# 测大文件三阶段
curl -X POST "http://localhost:8088/api/assets/sign?name=big.bin&size=8000000" \
  -H "X-API-Key: k_xxx"
```

---

## 项目结构

```
hw-img-host/
├── src/                     # Vue 3 SPA 前端
│   ├── views/               # 页面(Home/Gallery/Tags/Keys/Login/Root)
│   ├── components/          # 组件(FileUploader + shadcn ui/)
│   ├── composables/         # useAuth(JWT + axios 拦截器)
│   ├── router/              # vue-router(含秘密登录路径)
│   ├── lib/utils.ts         # cn() helper
│   └── assets/main.css      # Tailwind v4 + shadcn 主题变量
│
├── node-functions/api/      # Node Cloud Functions(Express 5)
│   ├── [[default]].ts       # 入口:挂载路由(assets 在 json() 之前!)
│   ├── routes/              # auth/upload/delete/assets/assets-keys
│   ├── _auth.ts             # JWT 签发/验证
│   ├── _assets_auth.ts      # X-API-Key 校验(HTTP 委托边缘函数)
│   ├── _utils.ts            # CNB 上传/删除/签名工具
│   ├── _validation.ts       # 文件名净化 + MAX_FILE_SIZE
│   └── _reply.ts            # 统一响应 { code, msg, data }
│
├── edge-functions/          # Edge Functions(V8 运行时)
│   ├── assets-api/          # KV 索引 + 私有下载 + 密钥库
│   ├── assets-upload/       # PicGo 大文件 multipart(直接写 KV)
│   ├── upload-proxy/        # 大文件流式转发到 CNB
│   ├── img-api/             # 图片代理(CORS/Range/CSP)
│   ├── file-api/            # 文件代理(MIME 修正/下载)
│   ├── kv-api/              # 图库索引(前端用)
│   ├── img/                 # 随机图端点(302)
│   ├── _mime.ts             # 共享:扩展名→MIME
│   └── _security.ts         # 共享:SSRF 防护/文件名净化
│
├── tests/                   # Vitest + supertest 测试
│   ├── unit/                # 单元测试(auth/utils/mime/security/...)
│   └── regression/          # HTTP 回归测试(模拟 CNB)
│
├── scripts/                 # 辅助工具
│   ├── upload.mjs           # CLI 上传工具(Node,零依赖)
│   └── uploader.user.js     # Tampermonkey 油猴脚本
│
└── docs/                    # 文档
    ├── API.md               # HTTP API 参考
    ├── MECHANISM.md         # 机制原理(三阶段上传/孤儿自愈/...)
    └── DEVELOPMENT.md       # 本文档
```

### 三种运行时的职责划分

| 运行时 | 能做 | 不能做 |
| --- | --- | --- |
| **前端 (Vue)** | UI、客户端压缩、SHA-256 查重、直传 | 直接访问 KV/CNB token |
| **Node Function** | npm 包(Express/multer/jsonwebtoken)、复杂逻辑 | 请求体 >6MB、直接访问 KV |
| **Edge Function** | KV 读写、轻量 API、流式转发 | npm 包、Node 内建模块(fs/path/crypto)、HTTP 回环自身域名 |

---

## 代码规范

### Prettier

- 无分号
- 单引号
- 100 字符行宽
- 2 空格缩进
- LF 行尾(`.gitattributes` 强制)

```bash
pnpm format   # 仅格式化 src/
```

### ESLint

```bash
pnpm lint     # 全项目 --fix
```

- flat config(`eslint.config.ts`)
- Vue:`flat/essential` + TypeScript `recommended`
- `src/components/ui/**` 禁用 `vue/multi-word-component-names`(shadcn 组件名单字)

### TypeScript

- `<script setup lang="ts">`
- 路径别名 `@` → `./src`
- `pnpm type-check` 检查 `src/`(vue-tsc)
- Node/Edge Functions 不在 tsconfig 范围内,需独立验证:`npx tsc --noEmit <file>`

### 命名约定

- 文件:`PascalCase.vue`(组件)、`camelCase.ts`(工具)、`_underscore.ts`(内部 helper)
- Edge Function 目录 = URL 路径(如 `assets-api/` → `/assets-api/*`)
- `[[path]].ts` = catch-all 动态路由(EdgeOne 约定,**不要改名**)
- `[[default]].ts` = Express 入口(EdgeOne 约定,**不要改名**)

### Git 提交

- Conventional Commits:`feat(scope):`、`fix(scope):`、`docs:`、`chore:`
- 单分支 `main`,线性历史

---

## 平台边界与限制

### 请求体大小

| 端点 | 上限 | 超限行为 |
| --- | --- | --- |
| `POST /api/assets`、`PUT /api/assets/...` | **~6MB** | 500 崩溃(平台层,代码拦不住) |
| `POST /api/assets/upload` | **~6MB** | 同上 |
| 三阶段 `sign → upload-proxy → complete` | **无限制** | — |
| `POST /assets-upload` | **无限制**(实验性) | — |

> 实测:6MB 通过,8MB 崩溃。`MAX_FILE_SIZE=20MB` 是代码层校验,但平台层更早拦截。
> **大文件必须用三阶段上传或 `/assets-upload`**,详见 [API.md 上传端点选择](./API.md#上传端点选择)。

### Edge Function 不能用 Node 内建模块

V8 运行时**没有** `fs`、`path`、`crypto`(Node 版)、`process` 等。

```ts
// ❌ Edge Function 里不能用
import { createHash } from 'node:crypto'
import path from 'node:path'

// ✅ 用 Web API 替代
const hash = await crypto.subtle.digest('SHA-256', data)  // Web Crypto
const encoded = new TextEncoder().encode(str)
```

JWT 签名/验签用 Web Crypto 的 `crypto.subtle.importKey` + `sign`/`verify`(见 `assets-api/verifyJwt`)。

### Edge Function 不能 HTTP 回环调用自身域名

```ts
// ❌ 边缘函数里调自己的域名,会失败
await fetch('https://cdn.anyul.cn/assets-api/index', ...)

// ✅ 边缘函数之间共享 img_kv 绑定,直接操作 KV
await img_kv.put('asset_service_key', JSON.stringify(record))
```

> Node Function → 边缘函数的 HTTP 调用是正常的(node 是 Cloud Function,走出站 HTTP)。
> 详见 [MECHANISM.md EdgeOne 平台约束](./MECHANISM.md#edgeone-平台约束)。

### `[[path]].ts` 不匹配根路径

`edge-functions/foo/[[path]].ts` 只匹配 `/foo/*`(带子路径段)。根路径 `/foo` 需要额外加 `index.ts`:

```ts
// edge-functions/foo/index.ts
import { onRequest } from './[[path]]'
export { onRequest }
```

> 如果客户端打根路径(如 PicGo 的 `POST /assets-upload`),不加 `index.ts` 会落到 SPA fallback。

### Edge Function 构建失败静默不注册

TS 语法错误导致 esbuild 构建失败时,EdgeOne **线上不报错**,只是该函数不注册,请求落到 SPA fallback(返回 index.html)。**务必本地 `edgeone pages dev` 验证构建无错。**

### KV 最终一致性

EdgeOne KV 是最终一致的(<60s),无 CAS/条件写。并发写入需要乐观并发(版本号 + 重试),详见 [MECHANISM.md 索引乐观并发](./MECHANISM.md#索引乐观并发)。

### KV 无 TTL / 无 cron

平台没有 KV 自动过期或定时任务。所有过期清理都是**懒删除**(读写时扫描),详见 [MECHANISM.md TTL 懒删除](./MECHANISM.md#ttl-懒删除)。

---

## 调试技巧

### 边缘函数返回 SPA index.html?

按顺序排查:

1. **构建是否成功** → `edgeone pages dev` 看日志有无 `ERROR:`
2. **根路径是否匹配** → 需要加 `index.ts`(见上文)
3. **CDN 缓存** → 看响应头 `EO-Cache-Status: Cache Hit`,到 EdgeOne 控制台刷新缓存
4. **响应未设 Cache-Control** → 动态内容加 `Cache-Control: no-store`

### 本地 dev 验证

```bash
PAGES_SOURCE=skills edgeone pages dev

# 另一个终端测
curl -D - "http://localhost:8088/assets-upload" -o /dev/null
# 看 server 头:OpenEdge = 进了边缘函数;无 = SPA fallback
```

### Node Function 调试

Node Function 的 `console.log/error` 在 EdgeOne 控制台的"函数日志"里查看。本地 dev 会在终端直接输出。

### CNB API 调试

CNB 上传/删除失败时,`_utils.ts` 的 `uploadToCnb`/`deleteFromCnb` 会 `console.error` 完整错误(含上游响应体),但客户端只收到通用消息(M2 脱敏)。

---

## 部署

### 自动部署

推送到 `main` 分支 → EdgeOne 自动构建部署:

```bash
git push origin main
```

### 手动部署

用 Agent skill 或 CLI:

```bash
PAGES_SOURCE=skills edgeone pages deploy
```

详见 `.agents/skills/edgeone-pages-deploy/SKILL.md`。

### 部署后验证清单

1. **小文件回归**:`POST /api/assets` 上传小文件
2. **大文件三阶段**:`sign → upload-proxy → complete` 端到端
3. **边缘函数路由**:确认新函数被注册(不返回 SPA)
4. **CDN 缓存**:新端点首次部署后可能需要刷新缓存

---

## 测试

### 测试框架

- **Vitest** —— 单元测试 + 回归测试
- **supertest** —— HTTP 回归测试(模拟 CNB 响应)

### 运行测试

```bash
pnpm test              # 单次
pnpm test:watch        # 监听
pnpm test:coverage     # 覆盖率
```

### 测试结构

```
tests/
├── unit/                    # 纯函数单元测试
│   ├── auth.test.ts         # JWT 签发/验证/密码校验
│   ├── utils.test.ts        # CNB 工具(路径提取/类型检测)
│   ├── mime.test.ts         # MIME 映射
│   ├── security.test.ts     # SSRF 防护/文件名净化
│   ├── validation.test.ts   # 路径校验/文件名净化
│   └── kvapi-helpers.test.ts # KV list 解析
└── regression/
    └── api.test.ts          # HTTP 回归(POST/PUT/DELETE/查询)
```

### 写新测试

单元测试放 `tests/unit/`,用 Vitest 标准 `describe/it/expect`。
HTTP 回归用 supertest 挂载 Express app,mock CNB fetch。
