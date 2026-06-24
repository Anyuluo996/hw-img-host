#!/usr/bin/env node
/**
 * hw-img-host 命令行上传工具
 *
 * 绕过前端的 WebP 压缩，原样把文件传到 CNB，返回 EdgeOne 代理链接。
 * 图片走 imgs 端点（/img-api/ 代理），非图片走 files 端点（/file-api/ 代理）。
 * 单文件 ≤ 20MB。
 *
 * 用法:
 *   node scripts/upload.mjs <文件...> [选项]
 *
 * 选项:
 *   -H, --host <url>      图床域名（默认读 .upload.json 或 https://cdn.anyul.cn）
 *   -p, --password <pwd>  上传密码（默认读 .upload.json 或 UPLOAD_PASSWORD 环境变量）
 *   -m, --md              以 Markdown 语法输出（图片用 ![]()，其他用 []()）
 *   -q, --quiet           只输出链接，不输出过程信息
 *   -h, --help            显示帮助
 *
 * 配置文件: 项目根目录 .upload.json（已 gitignore），形如:
 *   { "host": "https://cdn.anyul.cn", "password": "xxxx" }
 *
 * 示例:
 *   node scripts/upload.mjs pic.jpg
 *   node scripts/upload.mjs a.png b.jpg doc.pdf --md
 *   node scripts/upload.mjs archive.zip -H https://img.example.com -p mypass
 */

import { readFile, stat } from 'node:fs/promises'
import { basename, resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MAX_SIZE = 20 * 1024 * 1024 // 20MB，与服务端 multer 限制一致

// ---------- 参数解析 ----------
function parseArgs(argv) {
  const opts = { files: [], md: false, quiet: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '-h' || a === '--help') opts.help = true
    else if (a === '-m' || a === '--md') opts.md = true
    else if (a === '-q' || a === '--quiet') opts.quiet = true
    else if (a === '-H' || a === '--host') opts.host = argv[++i]
    else if (a === '-p' || a === '--password') opts.password = argv[++i]
    else if (a.startsWith('-')) {
      console.error(`未知选项: ${a}`)
      process.exit(2)
    } else opts.files.push(a)
  }
  return opts
}

// ---------- 读取配置 ----------
async function loadConfig() {
  const cfgPath = join(__dirname, '..', '.upload.json')
  try {
    const raw = await readFile(cfgPath, 'utf8')
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

// ---------- 登录获取 JWT ----------
async function login(host, password) {
  const resp = await fetch(`${host}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  })
  const data = await resp.json()
  if (!resp.ok || data.code !== 0) {
    throw new Error(`登录失败: ${data.msg || resp.statusText}`)
  }
  return data.data.token
}

// ---------- 获取上传签名 ----------
async function signUpload(host, token, name, size) {
  const url = new URL(`${host}/api/upload/sign`)
  url.searchParams.set('name', name)
  url.searchParams.set('size', String(size))
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  const data = await resp.json()
  if (!resp.ok || data.code !== 0) {
    // CNB 平台拒绝时，原始信息里通常带 JSON 形如 {"errcode":10402,"errmsg":".xxx file format is not supported"}
    const rawDetail = data.data?.message || data.msg || resp.statusText
    const inner = extractErrmsg(rawDetail) // 解析出 errmsg 友好提示
    throw new Error(`获取签名失败: ${inner}`)
  }
  return data.data // { assets:{path}, upload_url }
}

// 从 CNB 嵌套错误信息里提取 errmsg，找不到就返回原文
function extractErrmsg(raw) {
  if (typeof raw !== 'string') return String(raw ?? '')
  const m = raw.match(/"errmsg"\s*:\s*"([^"]+)"/)
  return m ? m[1] : raw
}

// ---------- 直传 CNB ----------
async function putToCnb(uploadUrl, bytes) {
  const resp = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: bytes,
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`上传到 CNB 失败: ${resp.status} ${text}`)
  }
}

// ---------- 从 assets.path 提取代理路径 ----------
function extractImagePath(rawPath) {
  const path = String(rawPath).split(/[?#]/)[0]
  const m = path.match(/-\/(?:imgs|files)\/(.+)/)
  return m ? m[1] : path
}

// 图片扩展名白名单（决定 md 输出用图片语法还是链接语法）
const IMAGE_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif', 'tiff',
])
function getExt(name) {
  const m = String(name).toLowerCase().match(/\.([a-z0-9]+)$/)
  return m ? m[1] : ''
}

// ---------- 上传单个文件 ----------
async function uploadOne(host, token, filePath, md, quiet) {
  const abs = resolve(filePath)
  const name = basename(abs)
  const st = await stat(abs)
  if (!st.isFile()) throw new Error(`不是文件: ${abs}`)
  if (st.size > MAX_SIZE) throw new Error(`文件超过 20MB 限制 (${name})`)

  const bytes = await readFile(abs)
  if (!quiet) console.log(`→ ${name}  ${(st.size / 1024).toFixed(1)} KB`)

  const signed = await signUpload(host, token, name, st.size)
  await putToCnb(signed.upload_url, bytes)

  // 后端返回 proxy_path 已含正确前缀（img-api 或 file-api），优先用；
  // 兜底用旧逻辑（老后端只返回 assets.path）
  const proxyPath = signed.proxy_path || '/img-api/' + extractImagePath(signed.assets.path)
  const proxyUrl = `${host}${proxyPath}`
  const originUrl = `https://cnb.cool${signed.assets.path}`
  const isImage = IMAGE_EXTS.has(getExt(name))

  if (md) {
    // 图片用图片语法，其他文件用链接语法
    console.log(isImage ? `![${name}](${proxyUrl})` : `[${name}](${proxyUrl})`)
  } else if (quiet) {
    console.log(proxyUrl)
  } else {
    console.log(`  代理链接: ${proxyUrl}`)
    console.log(`  CNB 原链: ${originUrl}`)
  }
  return proxyUrl
}

// ---------- main ----------
async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help || opts.files.length === 0) {
    console.log(USAGE)
    process.exit(opts.help ? 0 : 2)
  }

  const cfg = await loadConfig()
  const host = (opts.host || cfg.host || process.env.UPLOAD_HOST || 'https://cdn.anyul.cn')
    .replace(/\/$/, '')
  const password = opts.password || cfg.password || process.env.UPLOAD_PASSWORD
  if (!password) {
    console.error('错误: 缺少上传密码。用 -p 传入，或配置 .upload.json，或设置 UPLOAD_PASSWORD 环境变量。')
    process.exit(2)
  }

  if (!opts.quiet) console.log(`目标: ${host}\n`)

  const token = await login(host, password)
  const results = []
  let failed = 0
  for (const f of opts.files) {
    try {
      const url = await uploadOne(host, token, f, opts.md, opts.quiet)
      results.push({ file: f, url, ok: true })
    } catch (e) {
      failed++
      results.push({ file: f, ok: false, error: e.message })
      console.error(`✗ ${f}: ${e.message}`)
    }
  }

  if (!opts.quiet && !opts.md) {
    console.log(`\n完成: ${results.length - failed} 成功 / ${failed} 失败`)
  }
  process.exit(failed > 0 ? 1 : 0)
}

const USAGE = `hw-img-host 命令行上传工具

用法:
  node scripts/upload.mjs <文件...> [选项]

选项:
  -H, --host <url>      图床域名（默认读 .upload.json 或 https://cdn.anyul.cn）
  -p, --password <pwd>  上传密码（默认读 .upload.json 或 UPLOAD_PASSWORD 环境变量）
  -m, --md              以 Markdown 图片语法输出
  -q, --quiet           只输出链接，不输出过程信息
  -h, --help            显示帮助

配置文件（项目根 .upload.json，已 gitignore）:
  { "host": "https://cdn.anyul.cn", "password": "xxxx" }

示例:
  node scripts/upload.mjs pic.jpg
  node scripts/upload.mjs a.png b.jpg doc.pdf --md
  node scripts/upload.mjs archive.zip -H https://img.example.com -p mypass

支持格式: 任意文件类型（图片走 imgs，其他走 files 端点），单文件 ≤ 20MB。
注意: files 端点需后端配置带 repo-notes:rw 权限的 TOKEN_FILE。`

main().catch((e) => {
  console.error(`致命错误: ${e.message}`)
  process.exit(1)
})
