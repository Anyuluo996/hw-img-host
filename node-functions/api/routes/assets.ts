import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import multer from 'multer'
import jwt from 'jsonwebtoken'
import {
  uploadToCnb,
  deleteFromCnb,
  buildAccessUrl,
  computeSHA256,
  detectUploadType,
} from '../_utils'
import { reply } from '../_reply'
import { sanitizeFileName, MAX_FILE_SIZE } from '../_validation'
import { checkApiKey, deny } from '../_assets_auth'

// Assets 中转 API：供自己的服务（koishi 等）以程序化方式上传/下载/管理文件。
//
// 鉴权：X-API-Key 反查 service（多密钥，见 _assets_auth.ts）。
// 授权：URL 路径第一段必须等于 key 绑定的 service（强隔离）。
//
// 路由（挂载于 /api/assets）：
//   PUT    /:service/:key+  指定 key 上传（冲突 409，原始字节 body）
//   POST   /                服务端生成 key 上传（?name=&public=，原始字节 body）
//   POST   /upload          PicGo 等图床客户端（multipart/form-data 字段 file，公开链接）
//   GET    /                列举（?service=&prefix=&limit=）
//   DELETE /:service/:key+  删除
//
// 私有下载在边缘函数 assets-api/ 处理（不经 node 内存），本路由不参与读字节。
// KV 索引读写也委托给边缘 assets-api（node 无法直接访问 img_kv 绑定），
// 沿用现有 node→kv-api 的 HTTP 委托模式（见 _utils.checkDuplicateByHash）。

// 扩展 Express Request：携带已读入内存的原始文件 buffer 和鉴权得到的 service。
// multer 解析出的 multipart 文件也归一到 fileBuffer，让下游 doUpload 统一处理。
type AssetReq = Request & {
  fileBuffer?: Buffer
  callerService?: string
}

const router = Router()

// multer 实例：仅在 multipart/form-data 请求时介入。
// 字段兼容 PicGo/PicList 常见的 file 与 image 两种命名。
const multipartUpload = multer({
  limits: { fileSize: MAX_FILE_SIZE, fieldSize: MAX_FILE_SIZE },
})

// 接收任意 Content-Type 的原始 body（最大 MAX_FILE_SIZE），存到 req.fileBuffer。
// express.raw() 默认只接受有限 Content-Type，这里手动处理以支持任意二进制流。
function expressRawBody(req: AssetReq, res: Response, next: NextFunction) {
  if (req.method === 'GET' || req.method === 'DELETE') return next()
  const chunks: Buffer[] = []
  let size = 0
  let aborted = false
  req.on('data', (chunk: Buffer) => {
    if (aborted) return
    size += chunk.length
    if (size > MAX_FILE_SIZE) {
      aborted = true
      return deny(res, 413)
    }
    chunks.push(chunk)
  })
  req.on('end', () => {
    if (aborted) return
    req.fileBuffer = Buffer.concat(chunks)
    next()
  })
  req.on('error', () => {
    if (!aborted) deny(res, 400)
  })
}

// 内容协商前置中间件：按 Content-Type 分流 body 解析。
//   multipart/form-data → multer（解析字段，归一到 req.fileBuffer）
//   其他               → expressRawBody（原始字节，存 req.fileBuffer）
// 二者都消费请求流，必须互斥，不能同时跑。
function bodyRouter(req: AssetReq, res: Response, next: NextFunction) {
  if (req.method === 'GET' || req.method === 'DELETE') return next()
  const ct = String(req.headers['content-type'] || '').toLowerCase()
  if (ct.startsWith('multipart/form-data')) {
    // PicGo 等客户端：multipart 字段 file 或 image
    multipartUpload.fields([
      { name: 'file', maxCount: 1 },
      { name: 'image', maxCount: 1 },
    ])(req, res, (err) => {
      if (err) {
        const status =
          err.code === 'LIMIT_FILE_SIZE' || err.code === 'LIMIT_FIELD_SIZE' ? 413 : 400
        return deny(res, status)
      }
      // 归一到 fileBuffer，供下游 doUpload 统一处理
      const files = req.files as { file?: Express.Multer.File[]; image?: Express.Multer.File[] } | undefined
      const f = files?.file?.[0] || files?.image?.[0]
      req.fileBuffer = f?.buffer
      // 保留原始文件名（PicGo 靠它判扩展名），下游用 req.__multipartName 取
      ;(req as AssetReq & { __multipartName?: string }).__multipartName = f?.originalname
      next()
    })
    return
  }
  expressRawBody(req, res, next)
}

router.use(bodyRouter)

// 鉴权中间件：校验 X-API-Key（异步，走 edge 反查 service），挂到 req 上供后续授权用。
// 任何失败一律 401 空响应（零信息泄露）。
async function authGate(req: AssetReq, res: Response, next: NextFunction) {
  const service = await checkApiKey(req)
  if (!service) return deny(res, 401)
  req.callerService = service
  next()
}

// 路径通配段（来自 router 匹配 /api/assets/*splat）解析为 [service, ...keyParts]。
// key 可含 / 分层。形如 koishi/ocr/001.jpg → ["koishi","ocr","001.jpg"]
// path-to-regexp v8 在多段路径下可能返回 string 或 string[]，两者都兼容。
function splitKeyPath(wildcard: string | string[] | undefined): string[] {
  if (!wildcard) return []
  const raw = Array.isArray(wildcard) ? wildcard.join('/') : wildcard
  return raw
    .split('/')
    .map((s) => decodeURIComponent(s))
    .filter((s) => s.length > 0)
}

// key 段净化：禁止 .. 路径穿越、控制字符、超长串。
function sanitizeKeySegments(segs: string[]): string[] {
  return segs
    .map((s) =>
      s
        .replace(/\.\./g, '')
        .replace(/[\x00-\x1f\x7f]/g, '')
        .slice(0, 200),
    )
    .filter(Boolean)
}

// TTL 参数解析。支持 ?ttl=24h / 2d / 1w / 0(永不过期)。
// 不传 = 默认 1 天。返回过期时刻的 ISO 字符串，或 null 表示永不过期。
function parseTtl(ttlRaw: string | undefined): string | null {
  if (ttlRaw === undefined || ttlRaw === '') {
    // 默认 1 天
    return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
  }
  const trimmed = String(ttlRaw).trim()
  if (trimmed === '0') return null // 永不过期
  const m = trimmed.match(/^(\d+)\s*(h|d|w)$/i)
  if (!m) return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() // 无效格式回退默认 1 天
  const n = parseInt(m[1], 10)
  const unit = m[2].toLowerCase()
  const ms = unit === 'h' ? n * 3600_000 : unit === 'd' ? n * 86_400_000 : n * 7 * 86_400_000
  return new Date(Date.now() + ms).toISOString()
}

// 调用边缘 assets-api 做 KV 索引读写（node 无法直接访问 img_kv 绑定）。
// 自签短期 JWT，与 _utils.checkDuplicateByHash 同机制，免登录调边缘函数。
// 返回值是 Fetch Response（全局），与 Express 的 Response 区分。
async function callAssetsEdge(path: string, init: RequestInit): Promise<globalThis.Response> {
  const baseUrl = (process.env.BASE_IMG_URL || '').replace(/\/$/, '')
  const secret = process.env.JWT_SECRET || process.env.UPLOAD_PASSWORD
  if (!baseUrl || !secret) throw new Error('BASE_IMG_URL 或 JWT_SECRET 未配置')
  const token = jwt.sign({}, secret, { expiresIn: '5m' })
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 15000)
  try {
    return await fetch(`${baseUrl}/assets-api${path}`, {
      ...init,
      headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` },
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeoutId)
  }
}

// ============ PUT /:service/:key+  指定 key 上传（冲突 409） ============
// Express 5 用 path-to-regexp v8，裸 /* 通配不再合法，必须命名：'/*splat'。
router.put('/*splat', authGate, async (req: AssetReq, res) => {
  try {
    const splat = (req.params as { splat?: string | string[] }).splat
    const segs = sanitizeKeySegments(splitKeyPath(splat))
    if (segs.length < 2) return deny(res, 400)
    const service = segs[0]
    const fileKey = segs.slice(1).join('/')

    // 强隔离：路径第一段必须等于 key 绑定的 service
    if (service !== req.callerService) return deny(res, 403)

    const buffer = req.fileBuffer
    if (!buffer || buffer.length === 0) return deny(res, 400)

    // 冲突检测：KV 里已存在同 service+key → 409
    const conflictRes = await callAssetsEdge(
      `/check?service=${encodeURIComponent(service)}&key=${encodeURIComponent(fileKey)}`,
      { method: 'GET' },
    )
    if (conflictRes.ok) {
      const conf = (await conflictRes.json()) as { code: number; data?: { exists: boolean } }
      if (conf.code === 0 && conf.data?.exists) {
        return res.status(409).json(reply(1, 'key 已存在'))
      }
    }

    return await doUpload(
      req,
      res,
      service,
      fileKey,
      false,
      undefined,
      parseTtl(req.query.ttl as string),
    )
  } catch (e) {
    console.error('assets PUT 失败:', (e as Error).message)
    return res.status(500).json(reply(1, '上传失败'))
  }
})

// ============ POST /  服务端生成 key 上传 ============
// ?name=原始文件名.ext  &public=0|1  &ttl=24h|2d|1w|0
router.post('/', authGate, async (req: AssetReq, res) => {
  try {
    const service = req.callerService!
    const name = sanitizeFileName((req.query.name as string) || `file-${Date.now()}`)
    const isPublic = req.query.public === '1' || req.query.public === 'true'

    const buffer = req.fileBuffer
    if (!buffer || buffer.length === 0) return deny(res, 400)

    // 服务端生成 key：原名-时间短哈希.ext（不含 service 前缀，doUpload 会拼）
    const hash = computeSHA256(buffer).slice(0, 8)
    const stamp = Date.now().toString(36)
    const extMatch = name.match(/\.([a-z0-9]+)$/i)
    const stem = extMatch ? name.slice(0, extMatch.index) : name
    const ext = extMatch ? extMatch[1] : 'bin'
    const fileKey = `${stem}-${stamp}-${hash}.${ext}`

    return await doUpload(
      req,
      res,
      service,
      fileKey,
      isPublic,
      name,
      parseTtl(req.query.ttl as string),
    )
  } catch (e) {
    console.error('assets POST 失败:', (e as Error).message)
    return res.status(500).json(reply(1, '上传失败'))
  }
})

// ============ POST /upload  PicGo/PicList 等图床客户端 ============
// multipart/form-data 字段 file（兼容 image）。鉴权走 X-API-Key（与 POST / 同）。
// 返回公开直链（/img-api/...），任何人可访问。TTL 默认 1 天，?ttl=0 永久。
// 返回体额外补顶层 url 字段（镜像 data.url），兼容只认顶层字段的 PicGo 插件。
router.post('/upload', authGate, async (req: AssetReq, res) => {
  try {
    const service = req.callerService!
    const multipartName = (req as AssetReq & { __multipartName?: string }).__multipartName
    const name = sanitizeFileName(multipartName || `file-${Date.now()}`)
    if (!req.fileBuffer || req.fileBuffer.length === 0) return deny(res, 400)

    // 服务端生成 key（同 POST / 逻辑：原名-时间短哈希.ext）
    const hash = computeSHA256(req.fileBuffer).slice(0, 8)
    const stamp = Date.now().toString(36)
    const extMatch = name.match(/\.([a-z0-9]+)$/i)
    const stem = extMatch ? name.slice(0, extMatch.index) : name
    const ext = extMatch ? extMatch[1] : 'bin'
    const fileKey = `${stem}-${stamp}-${hash}.${ext}`

    const result = await uploadAndIndex(
      req,
      service,
      fileKey,
      true, // PicGo 场景强制公开（图床本质即公开）
      name,
      parseTtl(req.query.ttl as string),
      // multipart 的 Content-Type 是表单头，用按文件名检测的真实类型记录
      detectUploadType(name) === 'imgs' ? `image/${ext === 'jpg' ? 'jpeg' : ext}` : 'application/octet-stream',
    )
    if (!result.ok) {
      return res.status(result.errorStatus).json(reply(1, result.msg))
    }

    const data = result.data as { url: string | null }
    // PicGo 兼容：除 data.url 外，根级补 url（部分插件只取顶层 url 字段）。
    // 这里不走 reply()，因为 reply 把所有数据包进 data，出不来真正的顶层字段。
    return res.json({
      code: 0,
      msg: 'ok',
      url: data.url, // 顶层 url（兼容简陋插件）
      data,
    })
  } catch (e) {
    console.error('assets /upload 失败:', (e as Error).message)
    return res.status(500).json(reply(1, '上传失败'))
  }
})

// 实际上传到 CNB + 记录索引的核心逻辑（不负责 HTTP 响应）。
// 返回 { ok, data }；ok=false 时 data 含 errorStatus 供调用方决定响应码。
// mimeOverride 用于 multipart 上传：req.headers['content-type'] 是 multipart 头而非文件类型，
// 调用方传真实文件类型（按文件名检测）进来覆盖。
async function uploadAndIndex(
  req: AssetReq,
  service: string,
  fileKey: string,
  isPublic: boolean,
  displayName: string,
  expiresAt: string | null,
  mimeOverride?: string,
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; errorStatus: number; msg: string }> {
  const buffer = req.fileBuffer
  if (!buffer || buffer.length === 0) {
    return { ok: false, errorStatus: 400, msg: '空文件' }
  }
  const type = detectUploadType(displayName)
  const hash = computeSHA256(buffer)
  const baseUrl = process.env.BASE_IMG_URL!

  // 上传到 CNB（复用现有逻辑：图片走 imgs，其余走 files）
  const result = await uploadToCnb({ fileBuffer: buffer, fileName: displayName, type })
  const cnbPath = String(result.url) // /slug/-/imgs|files/...
  const proxyUrl = buildAccessUrl(baseUrl, cnbPath)

  // public=1 时返回公开 URL；private 时 url 留空，只能经 assets-api 拉
  const recordUrl = isPublic ? proxyUrl : ''

  // 记录索引到边缘 KV
  const record = {
    service,
    key: fileKey,
    public: isPublic,
    url: recordUrl,
    cnbPath,
    hash,
    name: displayName,
    size: buffer.length,
    mime: mimeOverride || (req.headers['content-type'] as string) || 'application/octet-stream',
    createdAt: new Date().toISOString(),
    expiresAt, // TTL 过期时刻（ISO）或 null（永不过期）。懒删除据此清理
  }
  const idxRes = await callAssetsEdge('/index', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(record),
  })
  if (!idxRes.ok) {
    console.error('assets 索引写入失败:', idxRes.status)
    // 索引失败不回滚 CNB 文件（保留可用），但告知调用方
    return { ok: false, errorStatus: 500, msg: '已上传但索引失败' }
  }

  return {
    ok: true,
    data: {
      key: `${service}/${fileKey}`,
      url: recordUrl || null,
      public: isPublic,
      size: buffer.length,
      hash,
      expiresAt,
    },
  }
}

// doUpload：旧 POST/PUT 路由的薄封装（uploadAndIndex + 统一响应）。
async function doUpload(
  req: AssetReq,
  res: Response,
  service: string,
  fileKey: string,
  isPublic = false,
  displayName?: string,
  expiresAt: string | null = null,
) {
  const fileName = displayName || fileKey.split('/').pop() || fileKey
  const result = await uploadAndIndex(req, service, fileKey, isPublic, fileName, expiresAt)
  if (!result.ok) {
    return res.status(result.errorStatus).json(reply(1, result.msg))
  }
  return res.json(reply(0, 'ok', result.data))
}

// ============ GET /  列举 ============
// ?service=&prefix=&limit=  service 不传时默认用调用方自己的（强隔离：只能看自己的）
router.get('/', authGate, async (req: AssetReq, res) => {
  try {
    const service = (req.query.service as string) || req.callerService!
    // 强隔离：只能列举自己 service 命名空间
    if (service !== req.callerService) return deny(res, 403)

    const prefix = (req.query.prefix as string) || ''
    const limit = Math.min(parseInt((req.query.limit as string) || '100', 10), 500)
    const qs = `?service=${encodeURIComponent(service)}&prefix=${encodeURIComponent(prefix)}&limit=${limit}`
    const r = await callAssetsEdge(`/list${qs}`, { method: 'GET' })
    if (!r.ok) return res.status(502).json(reply(1, '列举失败'))
    const data = (await r.json()) as { code: number; data?: unknown; msg?: string }
    return res.json(data)
  } catch (e) {
    console.error('assets GET list 失败:', (e as Error).message)
    return res.status(500).json(reply(1, '列举失败'))
  }
})

// ============ DELETE /:service/:key+  删除 ============
router.delete('/*splat', authGate, async (req: AssetReq, res) => {
  try {
    const splat = (req.params as { splat?: string | string[] }).splat
    const segs = splitKeyPath(splat)
    if (segs.length < 2) return deny(res, 400)
    const service = segs[0]
    if (service !== req.callerService) return deny(res, 403)
    const fileKey = sanitizeKeySegments(segs.slice(1)).join('/')
    if (!fileKey) return deny(res, 400)

    // 先查索引拿 cnbPath，删 CNB 文件，再删索引
    const getRes = await callAssetsEdge(
      `/check?service=${encodeURIComponent(service)}&key=${encodeURIComponent(fileKey)}`,
      { method: 'GET' },
    )
    if (!getRes.ok) return res.status(502).json(reply(1, '查询失败'))
    const got = (await getRes.json()) as {
      code: number
      data?: { exists: boolean; record?: { cnbPath?: string } }
    }
    if (got.code !== 0 || !got.data?.exists) {
      return res.status(404).json(reply(1, '不存在'))
    }

    // 删 CNB 文件（复用现有逻辑）
    if (got.data.record?.cnbPath) {
      try {
        await deleteFromCnb(got.data.record.cnbPath)
      } catch (e) {
        console.error('assets 删除 CNB 文件失败:', (e as Error).message)
        // CNB 删除失败不阻塞索引清理，但告知调用方
      }
    }

    // 删索引
    const delRes = await callAssetsEdge(
      `/index?service=${encodeURIComponent(service)}&key=${encodeURIComponent(fileKey)}`,
      { method: 'DELETE' },
    )
    if (!delRes.ok) return res.status(502).json(reply(1, '删除索引失败'))

    return res.json(reply(0, 'ok'))
  } catch (e) {
    console.error('assets DELETE 失败:', (e as Error).message)
    return res.status(500).json(reply(1, '删除失败'))
  }
})

export default router
