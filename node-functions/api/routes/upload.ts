import { Router } from 'express'
import multer from 'multer'
import { uploadToCnb, signUpload, buildImageUrl, getErrorDetail } from '../_utils'
import { reply } from '../_reply'
import { authMiddleware } from '../_auth'

const router = Router()

const upload = multer({
  limits: {
    fileSize: 20 * 1024 * 1024,
    fieldSize: 20 * 1024 * 1024,
  },
})

router.get('/sign', authMiddleware, async (req, res) => {
  try {
    const fileName = req.query.name as string
    const fileSize = parseInt(req.query.size as string, 10)
    if (!fileName || !fileSize) {
      return res.status(400).json(reply(1, '缺少 name 或 size 参数'))
    }

    const result = await signUpload({ fileName, fileSize })
    res.json(reply(0, 'ok', result))
  } catch (e: unknown) {
    res.status(500).json(reply(1, '获取上传签名失败', { message: (e as Error).message }))
  }
})

router.post(
  '/img',
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

export default router
