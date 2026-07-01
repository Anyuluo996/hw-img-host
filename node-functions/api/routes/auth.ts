import { Router } from 'express'
import jwt from 'jsonwebtoken'
import { reply } from '../_reply'
import { getSecret, verifyPassword, authMiddleware } from '../_auth'

const router = Router()

router.post('/login', (req, res) => {
  if (!process.env.UPLOAD_PASSWORD) {
    return res.status(400).json(reply(1, '服务器未配置上传密码'))
  }

  const { password } = req.body as { password?: string }

  if (!password || !verifyPassword(password)) {
    return res.status(401).json(reply(1, '密码错误'))
  }

  // JWT 用独立密钥签名（getSecret 优先 JWT_SECRET），与登录密码解耦：
  // 密码泄露不再能伪造 token，token 也不能反推密码。
  const token = jwt.sign({}, getSecret(), { expiresIn: '7d' })
  res.json(reply(0, '登录成功', { token }))
})

// GET /api/auth/login-path — 公开端点：返回当前登录路径（前端路由守卫跳转用）
// 无需鉴权（主页公开，需获取 login-path 才能跳转登录）。代理到边缘 kv-api。
router.get('/login-path', async (_req, res) => {
  try {
    const baseUrl = (process.env.BASE_IMG_URL || '').replace(/\/$/, '')
    const r = await fetch(`${baseUrl}/kv-api/login-path`)
    const json = (await r.json()) as { code: number; msg?: string; data?: { loginPath: string } }
    return res.json(json)
  } catch {
    return res.status(500).json(reply(1, '获取登录路径失败'))
  }
})

// PUT /api/auth/login-path — 管理员重置登录路径（生成新随机路径，旧的失效）
router.put('/login-path', authMiddleware, async (_req, res) => {
  try {
    const baseUrl = (process.env.BASE_IMG_URL || '').replace(/\/$/, '')
    const secret = process.env.JWT_SECRET || process.env.UPLOAD_PASSWORD
    if (!baseUrl || !secret) return res.status(500).json(reply(1, '配置缺失'))
    const token = jwt.sign({}, secret, { expiresIn: '5m' })
    const r = await fetch(`${baseUrl}/kv-api/login-path`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}` },
    })
    const json = (await r.json()) as { code: number; msg?: string; data?: { loginPath: string } }
    return res.json(json)
  } catch {
    return res.status(500).json(reply(1, '重置登录路径失败'))
  }
})

export default router
