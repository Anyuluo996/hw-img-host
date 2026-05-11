import { Router } from 'express'
import jwt from 'jsonwebtoken'
import { reply } from '../_reply'
import { getSecret } from '../_auth'

const router = Router()

router.post('/login', (req, res) => {
  const uploadPassword = process.env.UPLOAD_PASSWORD

  if (!uploadPassword) {
    return res.status(400).json(reply(1, '服务器未配置上传密码'))
  }

  const { password } = req.body as { password?: string }

  if (!password || password !== uploadPassword) {
    return res.status(401).json(reply(1, '密码错误'))
  }

  const token = jwt.sign({}, getSecret(), { expiresIn: '7d' })
  res.json(reply(0, '登录成功', { token }))
})

export default router
