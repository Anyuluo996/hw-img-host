# 命令行上传工具

`scripts/upload.mjs` —— 绕过前端的 WebP 压缩，原样把文件上传到 CNB，输出 EdgeOne 代理链接。支持任意文件类型：图片走 `imgs` 端点，其他走 `files` 端点。

## 环境要求

- Node.js `^20.19.0` 或 `>=22.12.0`（项目已要求，脚本用内置 `fetch`，无需装任何依赖）

## 快速开始

```sh
# 1. 配置密码（二选一）

#    方式 A：配置文件（推荐，已 gitignore 不会提交）
echo {"host":"https://cdn.anyul.cn","password":"你的密码"} > .upload.json

#    方式 B：环境变量
export UPLOAD_PASSWORD=你的密码

# 2. 上传
node scripts/upload.mjs pic.jpg
node scripts/upload.mjs doc.pdf
```

输出示例：

```
目标: https://cdn.anyul.cn

→ pic.jpg  2120.9 KB
  代理链接: https://cdn.anyul.cn/img-api/U3V9LHH.../f869356b-....jpg
  CNB 原链: https://cnb.cool/anyuluo/imagescdn/-/imgs/U3V9LHH.../f869356b-....jpg

→ doc.pdf  512.3 KB
  代理链接: https://cdn.anyul.cn/file-api/U3V9LHH.../a1b2c3d4-..../doc.pdf
  CNB 原链: https://cnb.cool/anyuluo/imagescdn/-/files/U3V9LHH.../a1b2c3d4-..../doc.pdf

完成: 2 成功 / 0 失败
```

## 用法

```
node scripts/upload.mjs <文件...> [选项]
```

| 选项 | 说明 |
| --- | --- |
| `-H, --host <url>` | 图床域名（默认读 `.upload.json` 或 `https://cdn.anyul.cn`） |
| `-p, --password <pwd>` | 上传密码（默认读 `.upload.json` 或 `UPLOAD_PASSWORD` 环境变量） |
| `-m, --md` | 以 Markdown 语法输出：图片 `![name](url)`，其他文件 `[name](url)` |
| `-q, --quiet` | 只输出链接（一行一个），不输出过程信息 |
| `-h, --help` | 显示帮助 |

## 示例

```sh
# 单文件
node scripts/upload.mjs pic.jpg

# 多文件（可混合图片和其他类型）
node scripts/upload.mjs a.png b.jpg doc.pdf archive.zip

# Markdown 格式输出（图片用 ![]()，其他用 []()）
node scripts/upload.mjs pic.jpg doc.pdf --md

# 静默模式，只拿链接（适合脚本管道）
node scripts/upload.mjs pic.jpg -q | clip     # Windows 复制到剪贴板

# 临时指定其他实例
node scripts/upload.mjs pic.jpg -H https://img.example.com -p mypass
```

## 配置优先级

密码和域名的查找顺序（前者覆盖后者）：

1. 命令行 `-H` / `-p`
2. `.upload.json` 文件
3. 环境变量 `UPLOAD_HOST` / `UPLOAD_PASSWORD`
4. 域名兜底 `https://cdn.anyul.cn`

## 支持的文件格式

支持**任意文件类型**，由后端按扩展名自动路由：

| 类型 | CNB 端点 | 代理路径 | 后端所需环境变量 |
| --- | --- | --- | --- |
| 图片（png/jpg/jpeg/webp/gif/bmp/svg/ico/avif/tiff） | `imgs` | `/img-api/` | `TOKEN_IMG` |
| 其他（pdf/zip/txt/mp4/docx/...） | `files` | `/file-api/` | `TOKEN_FILE`（需 `repo-notes:rw` scope） |

- 单文件上限 **20MB**（与服务端 multer 配置一致）。
- 非图片走 `files` 端点，要求后端配置 `TOKEN_FILE`（一个带 `repo-notes:rw` 权限的 CNB token）。若未配置，上传非图片会报"缺少环境变量 TOKEN_FILE"。
- **SVG 安全提示**：SVG 可内嵌脚本，上传恶意 SVG 构成存储型 XSS 风险。不要上传来源不明的 SVG。

## 工作原理

脚本复刻了前端 `FileUploader.vue` 的上传流程，但跳过了客户端 Canvas 压缩：

```
1. POST /api/auth/login { password }          → 拿 JWT token
2. GET  /api/upload/sign?name&size (Bearer)   → 拿 CNB 签名 upload_url + proxy_path
3. PUT  <upload_url> (octet-stream)           → 原文件直传 CNB
4. 拼接: <host><proxy_path>                   → 代理链接（含 img-api 或 file-api 前缀）
```

后端按文件扩展名自动判断走 `imgs` 还是 `files` 端点，并在 `proxy_path` 里返回正确的代理前缀。

## 退出码

| 退出码 | 含义 |
| --- | --- |
| `0` | 全部成功 |
| `1` | 至少一个文件失败（其余成功文件仍会上传） |
| `2` | 参数错误 / 缺少密码 |

## 常见问题

**报错 "登录失败"**
密码不对，检查 `.upload.json` 的 `password` 或 `-p` 参数。

**报错 "获取签名失败: 缺少环境变量 TOKEN_FILE"**
上传的是非图片文件，但后端没配置 `TOKEN_FILE`（需 `repo-notes:rw` 权限的 CNB token）。在部署环境配置该变量后重试。

**报错 "获取签名失败: .xxx file format is not supported."**
CNB 平台不接受该格式。仅图片端点会做此限制；非图片走 files 端点则无此问题。

**报错 "获取签名失败: ... file size not match" / "上传到 CNB 失败"**
签名时声明的 `size` 必须和实际上传字节一致，脚本已按真实大小签名，一般不会触发。若仍报错，确认文件在上传过程中没有被其他程序改动。

**画廊页面看不到命令行上传的文件**
前端画廊依赖 `/kv-api` 记录上传元信息，脚本只做直传未调用它，所以画廊里不显示，但链接可正常访问。若需在画廊管理，请用网页 UI 上传。

## 注意事项

- `.upload.json` 已被 `.gitignore` 排除，密码不会误提交。
- 该脚本与站点登录密码共用，泄漏等同站被未授权上传，请妥善保管。
