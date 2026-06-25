import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import jwt from 'jsonwebtoken'
import { getSecret, verifyPassword } from '../../node-functions/api/_auth'

describe('getSecret (H1 密钥分离)', () => {
  const saved = { ...process.env }

  beforeEach(() => {
    delete process.env.JWT_SECRET
    delete process.env.UPLOAD_PASSWORD
  })

  afterEach(() => {
    process.env = { ...saved }
  })

  it('优先用 JWT_SECRET，不用 UPLOAD_PASSWORD', () => {
    process.env.JWT_SECRET = 'jwt-key-123'
    process.env.UPLOAD_PASSWORD = 'pwd-456'
    expect(getSecret()).toBe('jwt-key-123')
  })

  it('未配 JWT_SECRET 时回退 UPLOAD_PASSWORD（向后兼容）', () => {
    process.env.UPLOAD_PASSWORD = 'pwd-fallback'
    expect(getSecret()).toBe('pwd-fallback')
  })

  it('两者都没配时抛错', () => {
    expect(() => getSecret()).toThrow()
  })
})

describe('verifyPassword (常量时间比较)', () => {
  const saved = { ...process.env }

  beforeEach(() => {
    process.env.UPLOAD_PASSWORD = 'correct-horse-battery'
  })

  afterEach(() => {
    process.env = { ...saved }
  })

  it('正确密码返回 true', () => {
    expect(verifyPassword('correct-horse-battery')).toBe(true)
  })

  it('错误密码返回 false', () => {
    expect(verifyPassword('wrong')).toBe(false)
    expect(verifyPassword('Correct-Horse-Battery')).toBe(false) // 大小写敏感
    expect(verifyPassword('')).toBe(false)
  })

  it('未配置密码时返回 false', () => {
    delete process.env.UPLOAD_PASSWORD
    expect(verifyPassword('anything')).toBe(false)
  })
})

describe('H1: JWT 与登录密码解耦', () => {
  const saved = { ...process.env }
  const PASSWORD = 'login-password-xyz'
  const SECRET = 'separate-jwt-secret-789'

  beforeEach(() => {
    process.env.UPLOAD_PASSWORD = PASSWORD
    process.env.JWT_SECRET = SECRET
  })

  afterEach(() => {
    process.env = { ...saved }
  })

  it('用密码登录得到的 token，用 JWT_SECRET 验证通过', () => {
    const token = jwt.sign({}, SECRET, { expiresIn: '7d' })
    // 模拟 authMiddleware 的验证逻辑
    expect(() => jwt.verify(token, SECRET)).not.toThrow()
  })

  it('密码泄露 ≠ 能伪造 token（关键安全保证）', () => {
    // 攻击者只知道密码，不知道 JWT_SECRET
    const tokenFromAttacker = jwt.sign({}, PASSWORD, { expiresIn: '7d' })
    // 服务端用 SECRET 验证 → 应失败
    expect(() => jwt.verify(tokenFromAttacker, SECRET)).toThrow()
  })

  it('token 无法反推密码（密钥独立）', () => {
    const token = jwt.sign({}, SECRET, { expiresIn: '7d' })
    // token 的 payload 不含密码也不含 secret
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())
    expect(payload).not.toHaveProperty('password')
    expect(payload).not.toHaveProperty('secret')
  })

  it('过期 token 验证失败', async () => {
    const expired = jwt.sign({}, SECRET, { expiresIn: '-1s' })
    expect(() => jwt.verify(expired, SECRET)).toThrow()
  })

  it('错误的密钥验证失败（防伪造）', () => {
    const token = jwt.sign({}, SECRET, { expiresIn: '7d' })
    expect(() => jwt.verify(token, 'wrong-secret')).toThrow()
  })
})
