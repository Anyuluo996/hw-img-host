import { Router } from 'express'
import jwt from 'jsonwebtoken'
import { reply } from '../_reply'
import {
  getSecret,
  verifyPassword,
  authMiddleware,
  getClientIp,
  checkRateLimit,
  recordFailedAttempt,
  clearRateLimit,
} from '../_auth'

const router = Router()

router.post('/login', (req, res) => {
  if (!process.env.UPLOAD_PASSWORD) {
    return res.status(400).json(reply(1, '服务器未配置上传密码'))
  }

  // 后端限速：基于 IP 的失败计数（前端 2s 冷却只挡浏览器，curl 无阻碍）
  const ip = getClientIp(req)
  const remaining = checkRateLimit(ip)
  if (remaining === 0) {
    res.set('Retry-After', '900') // 15 分钟
    return res.status(429).json(reply(1, '尝试过于频繁，请 15 分钟后再试'))
  }

  const { password } = req.body as { password?: string }

  if (!password || !verifyPassword(password)) {
    recordFailedAttempt(ip)
    const left = checkRateLimit(ip)
    return res.status(401).json(
      reply(1, left > 0 ? `密码错误，剩余 ${left} 次尝试` : '密码错误，已限速'),
    )
  }

  // 成功：清除限速计数
  clearRateLimit(ip)

  // JWT 用独立密钥签名（getSecret 优先 JWT_SECRET），与登录密码解耦：
  // 密码泄露不再能伪造 token，token 也不能反推密码。
  const token = jwt.sign({}, getSecret(), { expiresIn: '7d' })
  res.json(reply(0, '登录成功', { token }))
})

// GET /api/auth/login-path — 返回当前登录路径。
// KV 无路径时自动生成（首次初始化，无需 token）；
// KV 有路径时需 JWT（防止未登录用户探测）。前端透传 Authorization 头。
router.get('/login-path', async (req, res) => {
  try {
    const baseUrl = (process.env.BASE_IMG_URL || '').replace(/\/$/, '')
    const headers: Record<string, string> = {}
    // 透传调用方的 Authorization（边缘函数据此决定是否返回路径）
    const authHdr = req.headers.authorization
    if (authHdr) headers.Authorization = authHdr
    const r = await fetch(`${baseUrl}/kv-api/login-path`, { headers })
    const json = (await r.json()) as { code: number; msg?: string; data?: { loginPath: string } }
    // 边缘返回 403 时原样透传（未登录用户不给路径）
    return res.status(r.status).json(json)
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
