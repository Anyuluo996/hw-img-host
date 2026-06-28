import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
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
//   PUT  /:service/:key+    指定 key 上传（冲突 409）
//   POST /                  服务端生成 key 上传（?name=&public=）
//   GET  /                  列举（?service=&prefix=&limit=）
//   DELETE /:service/:key+  删除
//
// 私有下载在边缘函数 assets-api/ 处理（不经 node 内存），本路由不参与读字节。
// KV 索引读写也委托给边缘 assets-api（node 无法直接访问 img_kv 绑定），
// 沿用现有 node→kv-api 的 HTTP 委托模式（见 _utils.checkDuplicateByHash）。

// 扩展 Express Request：携带已读入内存的原始文件 buffer 和鉴权得到的 service。
type AssetReq = Request & {
  fileBuffer?: Buffer
  callerService?: string
}

const router = Router()

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

// 鉴权中间件：校验 X-API-Key，把 service 挂到 req 上供后续授权用。
// 任何失败一律 401 空响应（零信息泄露）。
function authGate(req: AssetReq, res: Response, next: NextFunction) {
  const service = checkApiKey(req)
  if (!service) return deny(res, 401)
  req.callerService = service
  next()
}

router.use(expressRawBody)

// 路径通配段（来自 router 匹配 /api/assets/*）解析为 [service, ...keyParts]。
// key 可含 / 分层。形如 koishi/ocr/001.jpg → ["koishi","ocr","001.jpg"]
function splitKeyPath(wildcard: string | undefined): string[] {
  if (!wildcard) return []
  return wildcard
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
router.put('/*', authGate, async (req: AssetReq, res) => {
  try {
    const segs = sanitizeKeySegments(splitKeyPath(req.params[0]))
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

    return await doUpload(req, res, service, fileKey)
  } catch (e) {
    console.error('assets PUT 失败:', (e as Error).message)
    return res.status(500).json(reply(1, '上传失败'))
  }
})

// ============ POST /  服务端生成 key 上传 ============
// ?name=原始文件名.ext  &public=0|1
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

    return await doUpload(req, res, service, fileKey, isPublic, name)
  } catch (e) {
    console.error('assets POST 失败:', (e as Error).message)
    return res.status(500).json(reply(1, '上传失败'))
  }
})

// 实际上传到 CNB + 记录索引的共用逻辑。
async function doUpload(
  req: AssetReq,
  res: Response,
  service: string,
  fileKey: string,
  isPublic = false,
  displayName?: string,
) {
  const buffer = req.fileBuffer!
  const fileName = displayName || fileKey.split('/').pop() || fileKey
  const type = detectUploadType(fileName)
  const hash = computeSHA256(buffer)
  const baseUrl = process.env.BASE_IMG_URL!

  // 上传到 CNB（复用现有逻辑：图片走 imgs，其余走 files）
  const result = await uploadToCnb({ fileBuffer: buffer, fileName, type })
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
    name: fileName,
    size: buffer.length,
    mime: (req.headers['content-type'] as string) || 'application/octet-stream',
    createdAt: new Date().toISOString(),
  }
  const idxRes = await callAssetsEdge('/index', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(record),
  })
  if (!idxRes.ok) {
    console.error('assets 索引写入失败:', idxRes.status)
    // 索引失败不回滚 CNB 文件（保留可用），但告知调用方
    return res.status(500).json(reply(1, '已上传但索引失败'))
  }

  return res.json(
    reply(0, 'ok', {
      key: `${service}/${fileKey}`,
      url: recordUrl || null,
      public: isPublic,
      size: buffer.length,
      hash,
    }),
  )
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
router.delete('/*', authGate, async (req: AssetReq, res) => {
  try {
    const segs = splitKeyPath(req.params[0])
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
