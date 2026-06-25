import { Router } from 'express'
import jwt from 'jsonwebtoken'
import { reply } from '../_reply'
import { getSecret, verifyPassword } from '../_auth'

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

export default router
