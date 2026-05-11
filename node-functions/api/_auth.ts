import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { reply } from './_reply'

export function getSecret(): string {
  const secret = process.env.UPLOAD_PASSWORD
  if (!secret) {
    throw new Error('UPLOAD_PASSWORD 未配置')
  }
  return secret
}

export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json(reply(1, '未授权'))
  }
  const token = authHeader.slice(7)
  try {
    jwt.verify(token, getSecret())
    next()
  } catch {
    return res.status(401).json(reply(1, 'token 无效或已过期'))
  }
}
