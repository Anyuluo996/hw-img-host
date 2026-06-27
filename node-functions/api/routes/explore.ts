import { Router } from 'express'
import { reply } from '../_reply'

// 验证：EdgeOne node-function 加 linux 平台二进制后 sharp 能否运行
const router = Router()

router.get('/sharp-test', async (_req, res) => {
  try {
    const sharp = (await import('sharp')).default
    const png = await sharp({
      create: {
        width: 100,
        height: 100,
        channels: 4,
        background: { r: 255, g: 0, b: 0, alpha: 1 },
      },
    })
      .png()
      .toBuffer()

    res.set('Content-Type', 'image/png')
    res.send(png)
  } catch (e) {
    res.status(500).json(reply(1, `sharp 不可用: ${(e as Error).message}`))
  }
})

export default router
