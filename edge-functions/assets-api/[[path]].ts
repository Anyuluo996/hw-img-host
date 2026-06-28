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
// 两级查询：KV 密钥库优先 → 环境变量 ASSETS_KEYS fallback。
async function checkApiKey(
  req: Request,
  env: Record<string, string | undefined>,
): Promise<string | null> {
  // fail-closed：KV 不可用且环境变量未配置时拒绝
  const provided = req.headers.get('x-api-key')
  if (!provided) return null
  return resolveService(provided, env)
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
  expiresAt?: string | null // ISO 时间戳；null/缺省=永不过期。懒删除据此清理
}

// ============ TTL 懒删除 ============

// 从 cnbPath（如 /slug/-/imgs|files/ID/uuid.ext）提取 CNB DELETE 需要的子路径。
// 逻辑与 node 端 _utils.extractImagePath 一致。
function extractCnbSubPath(cnbPath: string): string {
  const path = String(cnbPath).split(/[?#]/)[0]
  const match = path.match(/-\/(?:imgs|files)\/(.+)/)
  return match ? match[1] : path
}

// 调 CNB DELETE API 删除实际文件。token/slug 来自 env。
// 失败不抛（吞掉错误），因为懒删除不应因单个 CNB 删除失败而中断清理其他记录。
// 返回是否成功。
async function deleteCnbFile(
  cnbPath: string,
  env: Record<string, string | undefined>,
): Promise<boolean> {
  const token = env.TOKEN_DELETE
  const slug = env.SLUG_IMG
  if (!token || !slug) return false
  const subPath = extractCnbSubPath(cnbPath)
  const isImgs = cnbPath.includes('/-/imgs/')
  const deleteUrl = `https://api.cnb.cool/${slug}/-/${isImgs ? 'imgs' : 'files'}/${subPath}`
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 15000)
  try {
    const resp = await fetch(deleteUrl, {
      method: 'DELETE',
      signal: controller.signal,
      headers: { Authorization: `Bearer ${token}` },
    })
    return resp.ok
  } catch {
    return false
  } finally {
    clearTimeout(timeoutId)
  }
}

// 扫描某 service 的索引，删掉已过期的记录（KV 记录 + 索引项 + CNB 实际文件）。
// 返回清理条数。env 用于调 CNB DELETE（TOKEN_DELETE/SLUG_IMG）。
async function sweepExpired(
  service: string,
  env: Record<string, string | undefined>,
): Promise<number> {
  const idx = await getIndex(service)
  const now = Date.now()
  const expired: AssetRecord[] = []
  const keep: AssetRecord[] = []
  for (const r of idx) {
    if (r.expiresAt && new Date(r.expiresAt).getTime() < now) expired.push(r)
    else keep.push(r)
  }
  if (expired.length === 0) return 0
  // 删 KV 记录 + CNB 文件（并行，单个失败不影响其他）
  await Promise.all(
    expired.map(async (r) => {
      await getKV()
        .delete(recordKey(r.service, r.key))
        .catch(() => {})
      if (r.cnbPath) await deleteCnbFile(r.cnbPath, env).catch(() => {})
    }),
  )
  await setIndex(service, keep)
  return expired.length
}

// ============ 密钥管理（KV 存储，页面增删即时生效）============
//
// 密钥命名空间（与 asset_*/aidx_* 分离）：
//   akidx_all     全部密钥的聚合数组（唯一真相源）
//
// 设计说明：只用单 key 聚合数组，不维护 ak_{name} 单条记录。
// 原因：KV 是最终一致（<60s），单条与索引双写会出现写后读不一致，
// 导致"轮换后删不掉"（findKeyByName 读单条返回 null）。以索引为唯一真相源可彻底避免。

interface KeyRecord {
  name: string // = service 名，授权命名空间
  key: string // 明文密钥，k_ 前缀
  note?: string // 可选备注
  createdAt?: string
}

const KEY_INDEX = 'akidx_all'

async function getKeyIndex(): Promise<KeyRecord[]> {
  const v = (await getKV().get(KEY_INDEX, 'json')) as KeyRecord[] | null
  return Array.isArray(v) ? v : []
}

async function setKeyIndex(items: KeyRecord[]): Promise<void> {
  await getKV().put(KEY_INDEX, JSON.stringify(items))
}

// 在索引里按 name 查找。索引是唯一真相源。
async function findKeyByName(name: string): Promise<KeyRecord | null> {
  const idx = await getKeyIndex()
  return idx.find((it) => it.name === name) || null
}

// 写入/更新：直接更新索引数组中的对应项。
async function putKey(rec: KeyRecord): Promise<void> {
  const idx = await getKeyIndex()
  const i = idx.findIndex((it) => it.name === rec.name)
  if (i >= 0) idx[i] = rec
  else idx.push(rec)
  await setKeyIndex(idx)
}

async function removeKey(name: string): Promise<boolean> {
  const idx = await getKeyIndex()
  const before = idx.length
  const next = idx.filter((it) => it.name !== name)
  if (next.length === before) return false
  await setKeyIndex(next)
  return true
}

// 校验 X-API-Key：先查 KV 密钥库，再 fallback 到环境变量 ASSETS_KEYS。
// 返回绑定的 service（密钥 name）。失败返回 null。timing-safe 比较。
async function resolveService(
  provided: string,
  env: Record<string, string | undefined>,
): Promise<string | null> {
  if (!provided) return null
  // 1. KV 密钥库
  try {
    const idx = await getKeyIndex()
    for (const kr of idx) {
      if (safeEqualStr(provided, kr.key)) return kr.name
    }
  } catch {
    /* 落到 fallback */
  }
  // 2. 环境变量 fallback（兼容已部署的 ASSETS_KEYS）
  const envKeys = parseKeys(env.ASSETS_KEYS)
  for (const [knownKey, service] of envKeys) {
    if (safeEqualStr(provided, knownKey)) return service
  }
  return null
}

// ============ 主入口 ============

export async function onRequest(context: EdgeContext): Promise<Response> {
  const req = context.request
  const env = context.env

  // CORS 预检（索引操作 + 下载都需要）
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
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

  // 密钥管理子路由：keys / resolve-service（JWT 鉴权，node 内部调用）
  if (first === 'keys' || first === 'resolve-service') {
    return handleKeysOp(req, env, first, pathSegs.slice(1))
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
      // 懒删除：写完后顺手扫该 service 的过期记录（含 CNB 文件）
      await sweepExpired(rec.service, env).catch(() => {})
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
      // 懒删除：列举前先清理过期记录（含 CNB 文件，保持索引干净）
      await sweepExpired(service, env).catch(() => {})
      const prefix = url.searchParams.get('prefix') || ''
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10), 500)
      let items = await getIndex(service)
      // 双保险：再过滤一次已过期（防止 sweep 与 list 间的竞态）
      const now = Date.now()
      items = items.filter((it) => !it.expiresAt || new Date(it.expiresAt).getTime() >= now)
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
  const service = await checkApiKey(req, env)
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
  // TTL 懒删除：记录已过期 → 删 KV 记录 + CNB 文件 + 返回 404
  if (rec.expiresAt && new Date(rec.expiresAt).getTime() < Date.now()) {
    await removeRecord(service, keyPath).catch(() => {})
    if (rec.cnbPath) await deleteCnbFile(rec.cnbPath, env).catch(() => {})
    return emptyRes(404)
  }

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

// ============ 密钥管理（JWT 鉴权，node 路由调用）============
//
// GET    /assets-api/keys                列举所有密钥（node 脱敏后给前端）
// POST   /assets-api/keys                创建密钥 {name, note, key}（key 由 node 生成传入）
// DELETE /assets-api/keys?name=          删除密钥
// PUT    /assets-api/keys?name=          更新（轮换 key / 改 note）{key?, note?}
// POST   /assets-api/resolve-service     {key} → {service}（node 消费鉴权用）

async function handleKeysOp(
  req: Request,
  env: Record<string, string | undefined>,
  op: string,
  _subSegs: string[],
): Promise<Response> {
  // JWT 鉴权
  const authHeader = req.headers.get('Authorization')
  if (!authHeader || !authHeader.startsWith('Bearer ')) return emptyRes(401)
  const secret = env.JWT_SECRET || env.UPLOAD_PASSWORD
  if (!secret) return emptyRes(500)
  const ok = await verifyJwt(authHeader.slice(7), secret)
  if (!ok) return emptyRes(401)

  const url = new URL(req.url)

  try {
    // node 消费鉴权：传入 key，返回 service（或 null）
    if (op === 'resolve-service' && req.method === 'POST') {
      const body = (await req.json()) as { key?: string }
      if (!body.key) return jsonRes({ code: 1, msg: '缺少 key' }, 400)
      const service = await resolveService(body.key, env)
      return jsonRes({ code: 0, msg: 'ok', data: { service } })
    }

    if (op === 'keys' && req.method === 'GET') {
      const idx = await getKeyIndex()
      return jsonRes({ code: 0, msg: 'ok', data: { keys: idx } })
    }

    if (op === 'keys' && req.method === 'POST') {
      const body = (await req.json()) as KeyRecord
      if (!body.name || !body.key) return jsonRes({ code: 1, msg: '缺少 name/key' }, 400)
      // name 仅允许字母数字下划线横线（防 KV key 注入）
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(body.name)) {
        return jsonRes({ code: 1, msg: 'name 仅允许字母数字、下划线、横线（1-64 位）' }, 400)
      }
      if (await findKeyByName(body.name)) {
        return jsonRes({ code: 1, msg: 'name 已存在' }, 409)
      }
      const rec: KeyRecord = {
        name: body.name,
        key: body.key,
        note: body.note || '',
        createdAt: new Date().toISOString(),
      }
      await putKey(rec)
      return jsonRes({ code: 0, msg: 'ok', data: rec })
    }

    if (op === 'keys' && req.method === 'PUT') {
      const name = (url.searchParams.get('name') || '').trim()
      if (!name) return jsonRes({ code: 1, msg: '缺少 name' }, 400)
      const old = await findKeyByName(name)
      if (!old) return jsonRes({ code: 1, msg: '密钥不存在' }, 404)
      const body = (await req.json()) as { key?: string; note?: string }
      const updated: KeyRecord = {
        ...old,
        key: body.key || old.key,
        note: body.note !== undefined ? body.note : old.note,
      }
      await putKey(updated)
      return jsonRes({ code: 0, msg: 'ok', data: updated })
    }

    if (op === 'keys' && req.method === 'DELETE') {
      const name = (url.searchParams.get('name') || '').trim()
      if (!name) return jsonRes({ code: 1, msg: '缺少 name' }, 400)
      const removed = await removeKey(name)
      return jsonRes({ code: 0, msg: removed ? 'ok' : 'not found', data: { removed } })
    }

    return emptyRes(404)
  } catch {
    return jsonRes({ code: 1, msg: '密钥操作失败' }, 500)
  }
}
