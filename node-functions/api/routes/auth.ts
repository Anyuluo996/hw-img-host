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
  extractLoginCandidate,
  verifyLoginPath,
} from '../_auth'
import {
  beginRegistration,
  verifyRegistration,
  addCredential,
  beginAuthentication,
  verifyAuthentication,
  updateCounter,
  listCredentials,
  removeCredential,
  consumeChallenge,
} from '../_passkey'

const router = Router()

router.post('/login', async (req, res) => {
  if (!process.env.UPLOAD_PASSWORD) {
    return res.status(400).json(reply(1, '服务器未配置上传密码'))
  }

  // 路径校验（在限速之前）：从 Referer 解析候选路径，回环 edge 比对 KV 中的真实路径。
  // 不消耗限速配额——路径错的人连试密码的资格都没有。失败直接 403。
  const candidate = extractLoginCandidate(req)
  const pathOk = await verifyLoginPath(candidate)
  if (!pathOk) {
    return res.status(403).json(reply(1, 'Forbidden'))
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

// ============ 通行密钥（WebAuthn）============
// 注册需登录（通行密钥证明身份，不能自举信任）；登录公开。
// 登录成功签发与密码登录同款的 JWT，下游 authMiddleware 零改动即接受。

// 开始注册（需登录）—— 前端拿 options 调 navigator.credentials.create
router.post('/passkey/register/begin', authMiddleware, async (req, res) => {
  try {
    const { name } = (req.body as { name?: string }) || {}
    const { options, nonce } = await beginRegistration(name)
    res.json(reply(0, 'ok', { options, nonce }))
  } catch (e) {
    res.status(500).json(reply(1, (e as Error).message || '注册初始化失败'))
  }
})

// 完成注册（需登录）—— 前端把 navigator.credentials.create 的结果回传验证 + 持久化
router.post('/passkey/register/verify', authMiddleware, async (req, res) => {
  try {
    const { resp, nonce, name } = req.body as {
      resp: unknown
      nonce: string
      name?: string
    }
    if (!resp || !nonce) return res.status(400).json(reply(1, '缺少参数'))
    const challenge = await consumeChallenge(nonce)
    if (!challenge) return res.status(400).json(reply(1, 'challenge 已过期或无效，请重新注册'))
    const cred = await verifyRegistration(resp, challenge)
    cred.name = name
    await addCredential(cred)
    res.json(reply(0, '注册成功', { id: cred.id }))
  } catch (e) {
    res.status(400).json(reply(1, (e as Error).message || '注册验证失败'))
  }
})

// 开始登录（公开）—— 前端拿 options 调 navigator.credentials.get
router.post('/passkey/login/begin', async (_req, res) => {
  try {
    const { options, nonce } = await beginAuthentication()
    res.json(reply(0, 'ok', { options, nonce }))
  } catch (e) {
    res.status(500).json(reply(1, (e as Error).message || '登录初始化失败'))
  }
})

// 完成登录（公开）—— 验证签名，成功签发 JWT，失败走限速
router.post('/passkey/login/verify', async (req, res) => {
  const ip = getClientIp(req)
  const remaining = checkRateLimit(ip)
  if (remaining === 0) {
    res.set('Retry-After', '900')
    return res.status(429).json(reply(1, '尝试过于频繁，请 15 分钟后再试'))
  }

  try {
    const { resp, nonce } = req.body as { resp?: unknown; nonce?: string }
    if (!resp || !nonce) return res.status(400).json(reply(1, '缺少参数'))
    const challenge = await consumeChallenge(nonce)
    if (!challenge) {
      recordFailedAttempt(ip)
      return res.status(400).json(reply(1, 'challenge 已过期或无效'))
    }
    const { credentialId, newCounter } = await verifyAuthentication(resp, challenge)
    await updateCounter(credentialId, newCounter)
    clearRateLimit(ip)
    const token = jwt.sign({}, getSecret(), { expiresIn: '7d' })
    res.json(reply(0, '登录成功', { token }))
  } catch (e) {
    recordFailedAttempt(ip)
    const left = checkRateLimit(ip)
    res
      .status(401)
      .json(reply(1, left > 0 ? `通行密钥验证失败，剩余 ${left} 次尝试` : '已限速'))
    void e
  }
})

// 列出全部通行密钥（需登录）—— 设备管理页用
router.get('/passkey/list', authMiddleware, async (_req, res) => {
  try {
    const items = await listCredentials()
    res.json(reply(0, 'ok', { items }))
  } catch (e) {
    res.status(500).json(reply(1, (e as Error).message || '获取列表失败'))
  }
})

// 删除通行密钥（需登录）—— 移除设备
router.delete('/passkey/:id', authMiddleware, async (req, res) => {
  try {
    const id = req.params.id
    const removed = await removeCredential(id)
    if (!removed) return res.status(404).json(reply(1, '未找到该通行密钥'))
    res.json(reply(0, '已删除'))
  } catch (e) {
    res.status(500).json(reply(1, (e as Error).message || '删除失败'))
  }
})

export default router
