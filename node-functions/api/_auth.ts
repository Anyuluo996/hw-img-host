import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { reply } from './_reply'

// 取 JWT 签名密钥：优先用独立的 JWT_SECRET，避免与登录密码混用。
// 未配置 JWT_SECRET 时回退用 UPLOAD_PASSWORD（向后兼容），但应尽快补配独立密钥。
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

// ============ 登录限速（防爆破）============
//
// 基于 IP 的内存计数限速。node-function 实例可能在多节点间水平扩展，
// 内存限速是"尽力而为"（单实例内有效），但对低成本暴力爆破已是数量级提升。
// 窗口 15 分钟内允许 5 次失败尝试，超限返回 429。
// 成功登录不消耗额度。

const RATE_WINDOW_MS = 15 * 60 * 1000 // 15 分钟窗口
const RATE_MAX_FAILS = 5 // 窗口内最多 5 次失败
const rateMap = new Map<string, { count: number; resetAt: number }>()

// 定期清理过期条目，防内存泄漏
setInterval(() => {
  const now = Date.now()
  for (const [ip, entry] of rateMap) {
    if (entry.resetAt < now) rateMap.delete(ip)
  }
}, 5 * 60 * 1000)

// 从请求头提取客户端 IP
export function getClientIp(req: Request): string {
  return (
    (req.headers['eo-client-ip'] as string) ||
    (req.headers['x-real-ip'] as string) ||
    ((req.headers['x-forwarded-for'] as string) || '').split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    'unknown'
  )
}

// 检查是否被限速。返回剩余尝试次数，0 = 被限速。
export function checkRateLimit(ip: string): number {
  const now = Date.now()
  const entry = rateMap.get(ip)
  if (!entry || entry.resetAt < now) {
    return RATE_MAX_FAILS
  }
  return Math.max(0, RATE_MAX_FAILS - entry.count)
}

// 记录一次失败尝试
export function recordFailedAttempt(ip: string): void {
  const now = Date.now()
  const entry = rateMap.get(ip)
  if (!entry || entry.resetAt < now) {
    rateMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS })
  } else {
    entry.count++
  }
}

// 成功登录时清除计数
export function clearRateLimit(ip: string): void {
  rateMap.delete(ip)
}

export { RATE_WINDOW_MS, RATE_MAX_FAILS }
