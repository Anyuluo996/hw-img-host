// Assets 中转 API 边缘函数 —— 同时承担两个职责：
//
// 1. KV 索引读写（node 路由调用，JWT 鉴权）
//    POST   /assets-api/index        写入记录
//    DELETE /assets-api/index        删除记录（?service=&key=）
//    GET    /assets-api/check        查询存在性（?service=&key=）
//    GET    /assets-api/list         列举（?service=&prefix=&limit=）
//
// 2. 私有下载（外部调用方，X-API-Key 鉴权 + 强隔离）
//    GET    /assets-api/{service}/{key}   流式返回 CNB 原始字节
//
// 两套鉴权路径：
//   - 索引操作：Bearer JWT（node 自签，与 kv-api 同机制）→ 只信 node 路由的内部调用
//   - 私有下载：X-API-Key → 反查 service，且路径第一段必须等于该 service（强隔离）
//
// KV 命名空间（与现有 img_/idx_all 完全分离，零干扰）：
//   asset_{service}_{key}   单条记录
//   aidx_{service}          该 service 的聚合索引（列举用）

interface EdgeContext {
  request: Request
  env: Record<string, string | undefined>
  params: { path?: string | string[] }
}

interface KvStore {
  get(key: string, type?: 'text' | 'json' | 'arrayBuffer' | 'stream'): Promise<unknown>
  put(key: string, value: string | ArrayBuffer | ArrayBufferView | ReadableStream): Promise<void>
  delete(key: string): Promise<void>
  list(options?: {
    prefix?: string
    limit?: number
    cursor?: string
  }): Promise<{ complete: boolean; cursor: string; keys: Array<{ name?: string; key?: string }> }>
}

declare let img_kv: KvStore | undefined

// EdgeOne 运行时全局注入的 KV 绑定（与 kv-api / img 同名，逐文件复制声明）。
function getKV(): KvStore {
  if (typeof img_kv === 'undefined') throw new Error('KV Storage 未配置')
  return img_kv
}

// ============ 响应辅助 ============

function jsonRes(data: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...(headers || {}) },
  })
}

// 空响应（零信息泄露，401/403/404）
function emptyRes(status: number): Response {
  return new Response(null, { status })
}

// ============ Web Crypto 工具（JWT 验签，从 kv-api 移植）============

function base64UrlDecode(b64: string): string {
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4))
  const b64u = b64.replace(/-/g, '+').replace(/_/g, '/') + pad
  const bin = atob(b64u)
  // 处理多字节 UTF-8
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

function base64UrlToBytes(b64: string): Uint8Array {
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4))
  const b64u = b64.replace(/-/g, '+').replace(/_/g, '/') + pad
  const bin = atob(b64u)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

async function verifyJwt(token: string, secret: string): Promise<boolean> {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return false
    const [headerB64, payloadB64, signatureB64] = parts
    const payload = JSON.parse(base64UrlDecode(payloadB64)) as { exp?: number }
    if (payload.exp && payload.exp * 1000 < Date.now()) return false
    const encoder = new TextEncoder()
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    )
    const signature = base64UrlToBytes(signatureB64)
    const data = encoder.encode(`${headerB64}.${payloadB64}`)
    // Uint8Array→BufferSource 的类型摩擦在 TS5.4+ lib 下是已知现象，运行时无碍
    return crypto.subtle.verify('HMAC', key, signature as BufferSource, data)
  } catch {
    return false
  }
}

// ============ X-API-Key 校验（多密钥 + timing-safe + 强隔离）============

// 解析 ASSETS_KEYS = {"service":"key",...}，返回 key→service 映射。
function parseKeys(raw: string | undefined): Map<string, string> {
  const map = new Map<string, string>()
  if (!raw) return map
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>
    for (const [service, key] of Object.entries(obj)) {
      if (typeof key === 'string' && key.length > 0 && service.length > 0) {
        map.set(key, service)
      }
    }
  } catch {
    /* fail-closed */
  }
  return map
}

// 常量时间比较（Web Crypto subtle.timingSafeEqual 不存在，手写 XOR）。
function safeEqualStr(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a)
  const eb = new TextEncoder().encode(b)
  if (ea.length !== eb.length) return false
  let diff = 0
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i]
  return diff === 0
}

// 从请求校验 X-API-Key，返回绑定的 service。失败返回 null。
function checkApiKey(req: Request, env: Record<string, string | undefined>): string | null {
  const keys = parseKeys(env.ASSETS_KEYS)
  if (keys.size === 0) return null // fail-closed
  const provided = req.headers.get('x-api-key')
  if (!provided) return null
  for (const [knownKey, service] of keys) {
    if (safeEqualStr(provided, knownKey)) return service
  }
  return null
}

// ============ 索引操作（JWT 鉴权，node 内部调用）============

// 记录主键：asset_{service}_{key}。key 中的 / 保留（KV key 允许）。
function recordKey(service: string, key: string): string {
  return `asset_${service}_${key}`
}

// 聚合索引键：aidx_{service}
function indexKey(service: string): string {
  return `aidx_${service}`
}

async function getIndex(service: string): Promise<AssetRecord[]> {
  const v = (await getKV().get(indexKey(service), 'json')) as AssetRecord[] | null
  return Array.isArray(v) ? v : []
}

async function setIndex(service: string, items: AssetRecord[]): Promise<void> {
  await getKV().put(indexKey(service), JSON.stringify(items))
}

async function findRecord(service: string, key: string): Promise<AssetRecord | null> {
  const v = (await getKV().get(recordKey(service, key), 'json')) as AssetRecord | null
  return v || null
}

async function putRecord(rec: AssetRecord): Promise<void> {
  await getKV().put(recordKey(rec.service, rec.key), JSON.stringify(rec))
  // 维护聚合索引
  const idx = await getIndex(rec.service)
  const i = idx.findIndex((it) => it.service === rec.service && it.key === rec.key)
  if (i >= 0) idx[i] = rec
  else idx.push(rec)
  await setIndex(rec.service, idx)
}

async function removeRecord(service: string, key: string): Promise<boolean> {
  const exists = await findRecord(service, key)
  if (!exists) return false
  await getKV().delete(recordKey(service, key))
  const idx = await getIndex(service)
  const next = idx.filter((it) => !(it.service === service && it.key === key))
  await setIndex(service, next)
  return true
}

interface AssetRecord {
  service: string
  key: string
  public: boolean
  url: string
  cnbPath: string
  hash?: string
  name?: string
  size?: number
  mime?: string
  createdAt?: string
}

// ============ 主入口 ============

export async function onRequest(context: EdgeContext): Promise<Response> {
  const req = context.request
  const env = context.env

  // CORS 预检（索引操作 + 下载都需要）
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-API-Key',
        'Access-Control-Allow-Origin': '*',
      },
    })
  }

  const pathSegs = (
    (Array.isArray(context.params.path) ? context.params.path : [context.params.path]).filter(
      Boolean,
    ) as string[]
  ).map((s) => decodeURIComponent(s))

  // 索引操作子路由：第一段为 index/check/list
  const first = pathSegs[0] || ''
  if (first === 'index' || first === 'check' || first === 'list') {
    return handleIndexOp(req, env, first)
  }

  // 否则视为私有下载：/{service}/{key...}
  if (req.method === 'GET' && pathSegs.length >= 2) {
    return handleDownload(req, env, pathSegs)
  }

  return emptyRes(404)
}

// ============ 索引操作（JWT 鉴权）============

async function handleIndexOp(
  req: Request,
  env: Record<string, string | undefined>,
  op: string,
): Promise<Response> {
  // JWT 鉴权（node 路由自签的内部调用）
  const authHeader = req.headers.get('Authorization')
  if (!authHeader || !authHeader.startsWith('Bearer ')) return emptyRes(401)
  const secret = env.JWT_SECRET || env.UPLOAD_PASSWORD
  if (!secret) return emptyRes(500)
  const ok = await verifyJwt(authHeader.slice(7), secret)
  if (!ok) return emptyRes(401)

  const url = new URL(req.url)
  const service = (url.searchParams.get('service') || '').trim()
  const key = (url.searchParams.get('key') || '').trim()

  try {
    if (op === 'index' && req.method === 'POST') {
      const rec = (await req.json()) as AssetRecord
      if (!rec.service || !rec.key || !rec.cnbPath) {
        return jsonRes({ code: 1, msg: '缺少 service/key/cnbPath' }, 400)
      }
      await putRecord(rec)
      return jsonRes({ code: 0, msg: 'ok', data: { service: rec.service, key: rec.key } })
    }

    if (op === 'index' && req.method === 'DELETE') {
      if (!service || !key) return jsonRes({ code: 1, msg: '缺少 service/key' }, 400)
      const removed = await removeRecord(service, key)
      return jsonRes({ code: 0, msg: removed ? 'ok' : 'not found', data: { removed } })
    }

    if (op === 'check') {
      if (!service || !key) return jsonRes({ code: 1, msg: '缺少 service/key' }, 400)
      const rec = await findRecord(service, key)
      return jsonRes({ code: 0, msg: 'ok', data: { exists: !!rec, record: rec || null } })
    }

    if (op === 'list') {
      if (!service) return jsonRes({ code: 1, msg: '缺少 service' }, 400)
      const prefix = url.searchParams.get('prefix') || ''
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10), 500)
      let items = await getIndex(service)
      if (prefix) items = items.filter((it) => it.key.startsWith(prefix))
      items = items.slice(0, limit)
      return jsonRes({ code: 0, msg: 'ok', data: { items, total: items.length } })
    }

    return emptyRes(404)
  } catch (e) {
    return jsonRes({ code: 1, msg: '索引操作失败' }, 500)
  }
}

// ============ 私有下载（X-API-Key 鉴权 + 强隔离 + 流式转发）============

async function handleDownload(
  req: Request,
  env: Record<string, string | undefined>,
  pathSegs: string[],
): Promise<Response> {
  const service = checkApiKey(req, env)
  if (!service) return emptyRes(401)

  const pathService = pathSegs[0]
  const keyPath = pathSegs.slice(1).join('/')
  // 强隔离：路径第一段必须等于 key 绑定的 service
  if (!safeEqualStr(pathService, service) || !keyPath) return emptyRes(403)

  let rec: AssetRecord | null
  try {
    rec = await findRecord(service, keyPath)
  } catch {
    return emptyRes(500)
  }
  if (!rec) return emptyRes(404)

  const slug = env.SLUG_IMG
  if (!slug) return emptyRes(500)

  // 推导 CNB 直链。cnbPath 形如 /slug/-/imgs|files/...，直接拼到 cnb.cool。
  // imgs 内联展示，files 视类型决定 inline/attachment。
  const isImgs = rec.cnbPath.includes('/-/imgs/')
  const target = `https://cnb.cool${rec.cnbPath}`

  try {
    const headers: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    }
    const range = req.headers.get('Range')
    if (range) headers['Range'] = range

    const upstream = await fetch(target, { headers })
    if (!upstream.ok || !upstream.body) return emptyRes(502)

    const respHeaders: Record<string, string> = {
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'private, max-age=60',
      'Content-Type': upstream.headers.get('Content-Type') || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
    }
    // 透传 Range 相关
    const ar = upstream.headers.get('Accept-Ranges')
    const cr = upstream.headers.get('Content-Range')
    const cl = upstream.headers.get('Content-Length')
    if (ar) respHeaders['Accept-Ranges'] = ar
    if (cr) respHeaders['Content-Range'] = cr
    if (cl) respHeaders['Content-Length'] = cl
    // files（非图片）默认附件下载，用记录里的 name
    if (!isImgs && rec.name) {
      const dn = encodeURIComponent(rec.name)
      respHeaders['Content-Disposition'] = `attachment; filename="${dn}"; filename*=UTF-8''${dn}`
    }

    return new Response(upstream.body, { status: upstream.status, headers: respHeaders })
  } catch {
    return emptyRes(502)
  }
}
