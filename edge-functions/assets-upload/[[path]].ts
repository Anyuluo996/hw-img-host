// PicGo 大文件上传边缘函数（实验性）。
//
// 背景：PicGo/PicList 客户端发 multipart/form-data，请求体超 ~6MB 时连 node-function
// 路由都进不了。本边缘函数直接接收大 multipart，用 Request.formData() 解析 file 字段，
// 申请 CNB 上传元数据 → 流式 PUT 到 CNB（经 asset.cnb.cool）→ 写 KV 索引。
//
// ⚠️ 实验性：EdgeOne 边缘函数对超大 multipart body 的内存承受能力未经实测。
//    若部署后大文件失败，PicGo 大文件回退不可用（小文件仍走 node POST /api/assets/upload）。
//
// 端点：POST /assets-upload
//   multipart/form-data:
//     file 或 image  —— 文件二进制（PicGo 两种字段名都兼容）
//   header 或 form 字段：
//     X-API-Key      —— assets 密钥（反查 service，强隔离）
//   可选 query：
//     ?public=1&ttl=7d
//
// 返回（与 node POST /api/assets/upload 同形状，含顶层 url 兼容简陋 PicGo 插件）：
//   { code:0, msg:'ok', url, data:{ key, url, public, size, hash, expiresAt } }

interface EdgeContext {
  request: Request
  env: Record<string, string | undefined>
  params: { path?: string | string[] }
}

const ALLOWED_ORIGIN = '*'

// 所有响应都带 Cache-Control: no-store —— 边缘函数是动态内容，
// 不能让 CDN 缓存（否则会命中旧 SPA fallback，边缘函数永不生效）。
const NO_STORE = { 'Cache-Control': 'no-store' }

function jsonRes(data: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      ...NO_STORE,
      ...(headers || {}),
    },
  })
}

function emptyRes(status: number): Response {
  return new Response(null, {
    status,
    headers: { 'Access-Control-Allow-Origin': ALLOWED_ORIGIN, ...NO_STORE },
  })
}

// ============ X-API-Key 校验（与 assets-api 同款：KV 库 + 环境变量 fallback）============

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

function getKV(): KvStore {
  if (typeof img_kv === 'undefined') throw new Error('KV Storage 未配置')
  return img_kv
}

function safeEqualStr(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a)
  const eb = new TextEncoder().encode(b)
  if (ea.length !== eb.length) return false
  let diff = 0
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i]
  return diff === 0
}

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

// 密钥索引（与 assets-api 完全同构，只读路径）
interface KeyRecord {
  name: string
  key: string
}
const KEY_INDEX = 'akidx_all'

async function getKeyIndex(): Promise<KeyRecord[]> {
  const v = (await getKV().get(KEY_INDEX, 'json').catch(() => null)) as
    | KeyRecord[]
    | { items?: KeyRecord[] }
    | null
  if (Array.isArray(v)) return v
  if (v && typeof v === 'object' && Array.isArray(v.items)) return v.items
  return []
}

async function resolveService(
  provided: string,
  env: Record<string, string | undefined>,
): Promise<string | null> {
  if (!provided) return null
  try {
    for (const kr of await getKeyIndex()) {
      if (safeEqualStr(provided, kr.key)) return kr.name
    }
  } catch {
    /* 落到 fallback */
  }
  for (const [knownKey, service] of parseKeys(env.ASSETS_KEYS)) {
    if (safeEqualStr(provided, knownKey)) return service
  }
  return null
}

// 从 cnbPath 提取 CNB DELETE 需要的子路径（与 assets-api 同逻辑）
function extractCnbSubPath(cnbPath: string): string {
  const path = String(cnbPath).split(/[?#]/)[0]
  const match = path.match(/-\/(?:imgs|files)\/(.+)/)
  return match ? match[1] : path
}

// 调 CNB DELETE API 删除文件（KV 失败回滚用）。失败不抛，返回是否成功。
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

// ============ 主入口 ============

export async function onRequest(context: EdgeContext): Promise<Response> {
  const req = context.request
  const env = context.env

  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
        'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      },
    })
  }

  if (req.method !== 'POST') return emptyRes(405)

  try {
    // 解析 multipart（Request.formData 是标准 API，边缘运行时支持）
    const form = await req.formData()
    const file = (form.get('file') as File | null) || (form.get('image') as File | null)
    if (!file) return jsonRes({ code: 1, msg: '未上传 file/image 字段' }, 400)

    // 鉴权：X-API-Key（header 优先，其次 form 字段）
    const apiKey =
      req.headers.get('x-api-key') || (form.get('X-API-Key') as string | null) || (form.get('x-api-key') as string | null)
    if (!apiKey) return emptyRes(401)
    const service = await resolveService(apiKey, env)
    if (!service) return emptyRes(401)

    const baseUrl = (env.BASE_IMG_URL || '').replace(/\/$/, '')
    const slug = env.SLUG_IMG
    const tokenImg = env.TOKEN_IMG
    const tokenFile = env.TOKEN_FILE
    if (!baseUrl || !slug || (!tokenImg && !tokenFile)) {
      return jsonRes({ code: 1, msg: '服务端未配置' }, 500)
    }

    // 按扩展名判定类型（与 node detectUploadType 一致）
    const ext = (file.name.toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || ''
    const IMAGE_EXTS = new Set([
      'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif', 'tiff',
    ])
    const type = IMAGE_EXTS.has(ext) ? 'imgs' : 'files'
    const cnbToken = type === 'files' ? tokenFile : tokenImg
    if (!cnbToken) return jsonRes({ code: 1, msg: `缺少 ${type === 'files' ? 'TOKEN_FILE' : 'TOKEN_IMG'}` }, 500)

    // 1. 申请 CNB 上传元数据
    const metaUrl = `https://api.cnb.cool/${slug}/-/upload/${type}`
    const metaResp = await fetch(metaUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cnbToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: file.name, size: file.size }),
    })
    if (!metaResp.ok) {
      return jsonRes({ code: 1, msg: `获取上传元数据失败: ${metaResp.status}` }, 502)
    }
    const meta = (await metaResp.json()) as { assets: Record<string, unknown>; upload_url: string }

    // 2. 流式 PUT 文件到 CNB（不经 node 内存）
    const uploadResp = await fetch(meta.upload_url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file.stream(),
    })
    if (!uploadResp.ok) {
      return jsonRes({ code: 1, msg: `上传到 CNB 失败: ${uploadResp.status}` }, 502)
    }

    const cnbPath = String(meta.assets.path)
    // public=1 公开链接（PicGo 图床本质即公开）
    const isPublic = req.url.includes('public=1') || req.url.includes('public=true')
    const proxyPrefix = cnbPath.includes('/-/imgs/') ? 'img-api' : 'file-api'
    const subPath = (cnbPath.match(/-\/(?:imgs|files)\/(.+)/) || [])[1] || ''
    const recordUrl = isPublic ? `${baseUrl}/${proxyPrefix}/${subPath}` : ''

    // 生成服务端 key（与 node POST / 同逻辑）
    const stamp = Date.now().toString(36)
    const extMatch = file.name.match(/\.([a-z0-9]+)$/i)
    const stem = extMatch ? file.name.slice(0, extMatch.index) : file.name
    const extFinal = extMatch ? extMatch[1] : 'bin'
    const fileKey = `${stem}-${stamp}.${extFinal}`

    // TTL：默认 1d，?ttl=0 永久
    let expiresAt: string | null = new Date(Date.now() + 86400000).toISOString()
    const ttlMatch = req.url.match(/[?&]ttl=([^&]+)/)
    if (ttlMatch) {
      const ttl = decodeURIComponent(ttlMatch[1])
      if (ttl === '0') expiresAt = null
      else {
        const m = ttl.match(/^(\d+)\s*(h|d|w)$/i)
        if (m) {
          const n = parseInt(m[1], 10)
          const ms = m[2].toLowerCase() === 'h' ? n * 3600000 : m[2].toLowerCase() === 'd' ? n * 86400000 : n * 7 * 86400000
          expiresAt = new Date(Date.now() + ms).toISOString()
        }
      }
    }

    const record = {
      service,
      key: fileKey,
      public: isPublic,
      url: recordUrl,
      cnbPath,
      hash: '',
      name: file.name,
      size: file.size,
      mime: file.type || 'application/octet-stream',
      status: 'ready' as const,
      createdAt: new Date().toISOString(),
      expiresAt,
    }

    // 3. 直接写 KV 索引（共享 img_kv 绑定，不经 HTTP 回环）
    //    单条记录 asset_{service}_{key} + 聚合索引 aidx_{service}（append）。
    //    聚合索引用乐观并发（读→改→重读校验 ver→写），与 assets-api.mutateIndex 同构。
    //    KV 完全不可用时回滚：删掉已上传的 CNB 文件（避免静默孤儿）。
    try {
      const kv = getKV()
      await kv.put(`asset_${service}_${fileKey}`, JSON.stringify(record))
      // 聚合索引：乐观并发 append（ver 校验 + 3 次重试）
      let appended = false
      for (let attempt = 0; attempt < 3; attempt++) {
        const idxRaw = (await kv.get(`aidx_${service}`, 'json').catch(() => null)) as
          | unknown[]
          | { ver?: number; items?: unknown[] }
          | null
        let state: { ver: number; items: unknown[] }
        if (Array.isArray(idxRaw)) state = { ver: Date.now(), items: idxRaw }
        else if (idxRaw && typeof idxRaw === 'object' && Array.isArray(idxRaw.items))
          state = idxRaw as { ver: number; items: unknown[] }
        else state = { ver: 0, items: [] }

        // 写前重读校验 ver：变了说明有人写过，放弃本次重读
        const fresh = (await kv.get(`aidx_${service}`, 'json').catch(() => null)) as
          | { ver?: number }
          | null
        if (fresh && typeof fresh.ver === 'number' && fresh.ver !== state.ver) {
          continue // 版本变了，重试
        }

        const next = [...state.items, record]
        await kv.put(`aidx_${service}`, JSON.stringify({ ver: state.ver + 1, items: next }))
        appended = true
        break
      }
      if (!appended) {
        // 聚合索引写失败不阻塞（rebuild 兜底会自愈），但单条记录已落 KV
        console.error('assets-upload: 聚合索引 append 重试耗尽，单条记录已写入')
      }
    } catch {
      // KV 完全不可用：回滚已上传的 CNB 文件，避免静默孤儿
      await deleteCnbFile(cnbPath, env).catch(() => {})
      return jsonRes({ code: 1, msg: '索引写入失败，已回滚' }, 500)
    }

    const data = {
      key: `${service}/${fileKey}`,
      url: recordUrl || null,
      public: isPublic,
      size: file.size,
      hash: '',
      expiresAt,
    }
    // PicGo 兼容：顶层 url + data（同 node POST /api/assets/upload）
    return jsonRes({ code: 0, msg: 'ok', url: data.url, data })
  } catch {
    return jsonRes({ code: 1, msg: '上传失败' }, 500)
  }
}
