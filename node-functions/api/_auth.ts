import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { reply } from './_reply'

// 取 JWT 签名密钥：优先用独立的 JWT_SECRET，避免与登录密码混用。
// 未配置 JWT_SECRET 时回退到 UPLOAD_PASSWORD（向后兼容），但应尽快补配独立密钥。
export function getSecret(): string {
  const secret = process.env.JWT_SECRET || process.env.UPLOAD_PASSWORD
  if (!secret) {
    throw new Error('JWT_SECRET（或 UPLOAD_PASSWORD）未配置')
  }
  return secret
}

// 登录密码校验，独立于 JWT 密钥。
export function verifyPassword(password: string): boolean {
  const pwd = process.env.UPLOAD_PASSWORD
  if (!pwd) return false
  // 长度先比，再做常量时间比较，避免时序侧信道
  if (password.length !== pwd.length) return false
  let diff = 0
  for (let i = 0; i < pwd.length; i++) {
    diff |= password.charCodeAt(i) ^ pwd.charCodeAt(i)
  }
  return diff === 0
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
