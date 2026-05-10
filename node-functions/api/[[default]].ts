import express from 'express'
import { uploadToCnb, signUpload } from './_utils'
import { reply } from './_reply'
import multer from 'multer'

const upload = multer({
  limits: {
    fileSize: 20 * 1024 * 1024, // 单文件最大 20MB
    fieldSize: 20 * 1024 * 1024, // 表单字段最大 20MB
  },
})
const app = express()
app.use(express.json())

// ── KV helpers ──
const RECORDS_KEY = 'img_kv'
const MAX_RECORDS = 500

interface KvStore {
  get(key: string, type?: string): Promise<unknown>
  put(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<void>
}

function getKV(): KvStore | null {
  const g = globalThis as Record<string, unknown>
  return (g['KV'] as KvStore | undefined) || null
}

async function getRecords() {
  const kv = getKV()
  if (!kv) {
    console.warn('KV not available')
    return []
  }
  try {
    const data = await kv.get(RECORDS_KEY, 'json')
    return Array.isArray(data) ? data : []
  } catch (e) {
    console.error('KV getRecords error:', (e as Error).message)
    return []
  }
}

async function addRecord(record: Record<string, unknown>) {
  const kv = getKV()
  if (!kv) throw new Error('KV 存储未绑定，请在 EdgeOne 控制台中绑定 KV 存储')
  const records = await getRecords()
  const newRecord = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    ...record,
    createdAt: new Date().toISOString(),
  }
  records.unshift(newRecord)
  if (records.length > MAX_RECORDS) records.length = MAX_RECORDS
  await kv.put(RECORDS_KEY, JSON.stringify(records))
  return newRecord
}

async function removeRecord(id: string) {
  const kv = getKV()
  if (!kv) return
  const records = await getRecords()
  await kv.put(RECORDS_KEY, JSON.stringify(records.filter((r: { id: string }) => r.id !== id)))
}

// ── Upload routes ──

app.get('/upload/sign', async (req, res) => {
  try {
    const fileName = req.query.name as string
    const fileSize = parseInt(req.query.size as string, 10)
    if (!fileName || !fileSize) {
      return res.status(400).json(reply(1, '缺少 name 或 size 参数'))
    }

    const uploadPassword = process.env.UPLOAD_PASSWORD
    if (uploadPassword) {
      const password = req.query.password as string
      if (!password || password !== uploadPassword) {
        return res.status(401).json(reply(1, '密码错误'))
      }
    }

    const result = await signUpload({ fileName, fileSize })
    res.json(reply(0, 'ok', result))
  } catch (e: unknown) {
    res.status(500).json(reply(1, '获取上传签名失败', { message: (e as Error).message }))
  }
})

app.post(
  '/upload/img',
  (req, res, next) => {
    upload.fields([
      { name: 'file', maxCount: 1 },
      { name: 'thumbnail', maxCount: 1 },
    ])(req, res, (err) => {
      if (err) {
        const status = err.code === 'LIMIT_FILE_SIZE' || err.code === 'LIMIT_FIELD_SIZE' ? 413 : 400
        return res.status(status).json(reply(1, `文件超出限制: ${err.message}`, ''))
      }
      next()
    })
  },
  async (req, res) => {
    try {
      const files = req.files as { [fieldname: string]: Express.Multer.File[] }
      if (!files || !files.file) {
        return res.status(400).json(reply(1, '未上传文件', ''))
      }

      const mainFile = files.file?.[0]
      const thumbnailFile = files.thumbnail?.[0]

      // 上传主图
      const mainResult = await uploadToCnb({
        fileBuffer: mainFile.buffer,
        fileName: mainFile.originalname,
      })

      const baseUrl = process.env.BASE_IMG_URL

      const mainImgPath = extractImagePath(mainResult.url)
      const mainUrl = baseUrl + 'img-api/' + mainImgPath

      let thumbnailUrl = null
      let thumbnailAssets = null

      // 上传缩略图
      if (thumbnailFile) {
        const thumbnailResult = await uploadToCnb({
          fileBuffer: thumbnailFile.buffer,
          fileName: thumbnailFile.originalname,
        })

        const thumbnailImgPath = extractImagePath(thumbnailResult.url)
        thumbnailUrl = baseUrl + 'img-api/' + thumbnailImgPath
        thumbnailAssets = thumbnailResult.assets
      }

      res.json(
        reply(0, '上传成功', {
          url: mainUrl,
          thumbnailUrl: thumbnailUrl,
          assets: mainResult.assets,
          thumbnailAssets: thumbnailAssets,
          hasThumbnail: !!thumbnailFile,
        }),
      )
    } catch (err: unknown) {
      const msg = (err as Error).message || '未知错误'
      const detail = getErrorDetail(err)
      console.error('上传失败:', msg, detail)
      res.status(500).json(
        reply(1, '上传失败', {
          message: msg,
          detail: detail || undefined,
        }),
      )
    }
  },
)

// ── Records routes (KV-backed gallery) ──

app.get('/records', async (_req, res) => {
  try {
    const records = await getRecords()
    res.json(reply(0, 'ok', { images: records, total: records.length }))
  } catch (e: unknown) {
    res.status(500).json(reply(1, (e as Error).message || '获取记录失败'))
  }
})

app.post('/records', async (req, res) => {
  try {
    const record = await addRecord(req.body as Record<string, unknown>)
    res.json(reply(0, 'ok', record))
  } catch (e: unknown) {
    res.status(500).json(reply(1, (e as Error).message || '保存记录失败'))
  }
})

app.delete('/records/:id', async (req, res) => {
  try {
    await removeRecord(req.params.id)
    res.json(reply(0, '删除成功'))
  } catch (e: unknown) {
    res.status(500).json(reply(1, (e as Error).message || '删除失败'))
  }
})

// ── Helpers ──

function getErrorDetail(err: unknown): string | undefined {
  const responseData = (err as { response?: { data?: unknown } }).response?.data
  if (!responseData) return undefined
  if (typeof responseData === 'string') return responseData
  if (Buffer.isBuffer(responseData)) return responseData.toString('utf8')
  if (responseData instanceof ArrayBuffer) return Buffer.from(responseData).toString('utf8')
  return undefined
}

function extractImagePath(rawPath: string): string {
  let path = rawPath
  const queryIdx = path.indexOf('?')
  if (queryIdx !== -1) path = path.substring(0, queryIdx)
  const hashIdx = path.indexOf('#')
  if (hashIdx !== -1) path = path.substring(0, hashIdx)

  const imgsIdx = path.indexOf('-/imgs/')
  if (imgsIdx !== -1) return path.substring(imgsIdx + 7)
  const filesIdx = path.indexOf('-/files/')
  if (filesIdx !== -1) return path.substring(filesIdx + 8)
  return path
}

export async function onRequest(context: { request: Request; env: Record<string, unknown> }) {
  const g = globalThis as Record<string, unknown>
  if (context.env) g['env'] = context.env
  if (context.env && context.env['KV']) g['KV'] = context.env['KV']
  return app.handle(context.request)
}

export default app
