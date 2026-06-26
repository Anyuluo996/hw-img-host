import { Router } from 'express'
import { reply } from '../_reply'

// 临时探索端点：验证 EdgeOne node-function 环境是否支持 sharp
// GET /api/explore/sharp-test
const router = Router()

router.get('/sharp-test', async (_req, res) => {
  try {
    // 动态 import，避免环境不支持时整个应用启动失败
    const sharp = (await import('sharp')).default

    // 生成一个 100x100 红色测试图，验证 sharp 能否运行
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
    // 失败说明 EdgeOne node-function 不支持 sharp 原生模块
    res.status(500).json(reply(1, `sharp 不可用: ${(e as Error).message}`))
  }
})

export default router
