import express from 'express'
import multer from 'multer'
import { uploadToCnb, signUpload } from './_utils'
import { reply } from './_reply'

interface KvStore {
  get(key: string, type?: 'text' | 'json' | 'arrayBuffer' | 'stream'): Promise<unknown>
  put(key: string, value: string | ArrayBuffer | ArrayBufferView | ReadableStream): Promise<void>
  delete(key: string): Promise<void>
}

declare let img_kv: KvStore | undefined

const app = express()
app.use(express.json())

const upload = multer({
  limits: {
    fileSize: 20 * 1024 * 1024,
    fieldSize: 20 * 1024 * 1024,
  },
})

const RECORDS_KEY = 'img_kv'
const MAX_RECORDS = 500

function getKV(): KvStore {
  if (typeof img_kv === 'undefined') {
    throw new Error('KV Storage 未配置，请在 EdgeOne Pages 控制台启用并绑定 KV 命名空间')
  }
  return img_kv
}

async function getRecords(): Promise<Record<string, unknown>[]> {
  try {
    const data = await getKV().get(RECORDS_KEY, 'json')
    return Array.isArray(data) ? data : []
  } catch (e) {
    console.error('KV getRecords error:', (e as Error).message)
    return []
  }
}

async function addRecord(record: Record<string, unknown>) {
  const kv = getKV()
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
  const records = await getRecords()
  await getKV().put(RECORDS_KEY, JSON.stringify(records.filter((r: { id: string }) => r.id !== id)))
}

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
        return res.status(status).json(reply(1, `文件超出限制: ${err.message}`))
      }
      next()
    })
  },
  async (req, res) => {
    try {
      const files = req.files as { [fieldname: string]: Express.Multer.File[] }
      if (!files?.file) {
        return res.status(400).json(reply(1, '未上传文件'))
      }

      const mainFile = files.file[0]
      const thumbnailFile = files.thumbnail?.[0]
      const baseUrl = process.env.BASE_IMG_URL!

      const mainResult = await uploadToCnb({
        fileBuffer: mainFile.buffer,
        fileName: mainFile.originalname,
      })

      let thumbnailResult: { assets: Record<string, unknown>; url: unknown } | null = null
      if (thumbnailFile) {
        thumbnailResult = await uploadToCnb({
          fileBuffer: thumbnailFile.buffer,
          fileName: thumbnailFile.originalname,
        })
      }

      res.json(
        reply(0, '上传成功', {
          url: buildImageUrl(baseUrl, mainResult.url as string),
          thumbnailUrl: thumbnailResult
            ? buildImageUrl(baseUrl, thumbnailResult.url as string)
            : null,
          assets: mainResult.assets,
          thumbnailAssets: thumbnailResult?.assets ?? null,
          hasThumbnail: !!thumbnailFile,
        }),
      )
    } catch (err: unknown) {
      const msg = (err as Error).message || '未知错误'
      const detail = getErrorDetail(err)
      console.error('上传失败:', msg, detail)
      res.status(500).json(reply(1, '上传失败', { message: msg, detail }))
    }
  },
)

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

function getErrorDetail(err: unknown): string | undefined {
  const data = (err as { response?: { data?: unknown } }).response?.data
  if (typeof data === 'string') return data
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  return undefined
}

function extractImagePath(rawPath: string): string {
  const path = String(rawPath).split(/[?#]/)[0]
  const match = path.match(/-\/(?:imgs|files)\/(.+)/)
  return match ? match[1] : path
}

function buildImageUrl(baseUrl: string, rawPath: string): string {
  return baseUrl + 'img-api/' + extractImagePath(rawPath)
}

export default app
