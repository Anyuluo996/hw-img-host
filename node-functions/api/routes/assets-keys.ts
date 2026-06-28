import { Router } from 'express'
import { randomBytes } from 'node:crypto'
import jwt from 'jsonwebtoken'
import { authMiddleware } from '../_auth'
import { reply } from '../_reply'

// Assets 密钥管理 API（前端页面用，JWT 鉴权）。
//
// 密钥存 KV（ak_{name} / akidx_all），经 edge assets-api 增删改查，即时生效。
// node 不能直接访问 img_kv，故通过 HTTP 委托（与 assets.ts 的 callAssetsEdge 同机制）。
//
// 路由（挂载于 /api/assets-keys，在 express.json() 之后）：
//   GET    /              列举所有密钥（脱敏：key 只返回前缀+后缀）
//   POST   /              创建密钥 {name, note} → 返回明文（仅此一次）
//   PUT    /:name         轮换密钥 / 改备注 {note?}  → 轮换后返回新明文
//   DELETE /:name         删除密钥

const router = Router()

// 所有操作都需 JWT 鉴权（复用图床登录态）
router.use(authMiddleware)

// 调用边缘 assets-api 的密钥管理端点（JWT 自签）。
async function callEdge(path: string, init: RequestInit): Promise<globalThis.Response> {
  const baseUrl = (process.env.BASE_IMG_URL || '').replace(/\/$/, '')
  const secret = process.env.JWT_SECRET || process.env.UPLOAD_PASSWORD
  if (!baseUrl || !secret) throw new Error('BASE_IMG_URL 或 JWT_SECRET 未配置')
  const token = jwt.sign({}, secret, { expiresIn: '5m' })
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 10000)
  try {
    return await fetch(`${baseUrl}/assets-api${path}`, {
      ...init,
      headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` },
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeoutId)
  }
}

// 生成随机密钥：k_ + 48 hex（192 bit 熵）。
function genKey(): string {
  return 'k_' + randomBytes(24).toString('hex')
}

// 脱敏：明文 → k_前8位...后4位。前端列表展示用，不暴露完整密钥。
function maskKey(key: string): string {
  if (key.length <= 12) return key.slice(0, 4) + '***'
  return key.slice(0, 10) + '...' + key.slice(-4)
}

interface KeyRecord {
  name: string
  key: string
  note?: string
  createdAt?: string
}

// ============ GET /  列举 ============
router.get('/', async (_req, res) => {
  try {
    const r = await callEdge('/keys', { method: 'GET' })
    if (!r.ok) return res.status(502).json(reply(1, '加载失败'))
    const json = (await r.json()) as { code: number; data?: { keys: KeyRecord[] }; msg?: string }
    if (json.code !== 0) return res.status(502).json(reply(1, json.msg || '加载失败'))
    // 脱敏：key 不返回明文
    const masked = (json.data?.keys || []).map((k) => ({
      name: k.name,
      keyMasked: maskKey(k.key),
      note: k.note || '',
      createdAt: k.createdAt,
    }))
    return res.json(reply(0, 'ok', { keys: masked }))
  } catch (e) {
    console.error('assets-keys GET 失败:', (e as Error).message)
    return res.status(500).json(reply(1, '加载失败'))
  }
})

// ============ POST /  创建 ============
router.post('/', async (req, res) => {
  try {
    const { name, note } = req.body as { name?: string; note?: string }
    if (!name || !/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
      return res.status(400).json(reply(1, 'name 仅允许字母数字、下划线、横线（1-64 位）'))
    }
    const newKey = genKey()
    const r = await callEdge('/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, note: note || '', key: newKey }),
    })
    const json = (await r.json()) as { code: number; msg?: string }
    if (!r.ok || json.code !== 0) {
      return res.status(r.status === 409 ? 409 : 502).json(reply(1, json.msg || '创建失败'))
    }
    // 创建成功 → 返回明文（仅此一次，调用方/页面需保存）
    return res.json(reply(0, 'ok', { name, key: newKey, keyMasked: maskKey(newKey) }))
  } catch (e) {
    console.error('assets-keys POST 失败:', (e as Error).message)
    return res.status(500).json(reply(1, '创建失败'))
  }
})

// ============ PUT /:name  轮换 / 改备注 ============
router.put('/:name', async (req, res) => {
  try {
    const name = req.params.name
    const { note } = req.body as { note?: string }
    const rotate = req.query.rotate === '1' || req.query.rotate === 'true'
    const body: { note?: string; key?: string } = {}
    if (note !== undefined) body.note = note
    if (rotate) body.key = genKey() // 轮换：生成新密钥覆盖

    const r = await callEdge(`/keys?name=${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const json = (await r.json()) as { code: number; msg?: string; data?: KeyRecord }
    if (!r.ok || json.code !== 0) {
      return res.status(r.status === 404 ? 404 : 502).json(reply(1, json.msg || '更新失败'))
    }
    // 轮换时返回新明文（仅此一次）；仅改备注则不返回 key
    const data: { keyMasked?: string; key?: string } = {}
    if (rotate && json.data?.key) {
      data.key = json.data.key
      data.keyMasked = maskKey(json.data.key)
    }
    return res.json(reply(0, 'ok', data))
  } catch (e) {
    console.error('assets-keys PUT 失败:', (e as Error).message)
    return res.status(500).json(reply(1, '更新失败'))
  }
})

// ============ DELETE /:name  删除 ============
router.delete('/:name', async (req, res) => {
  try {
    const name = req.params.name
    const r = await callEdge(`/keys?name=${encodeURIComponent(name)}`, { method: 'DELETE' })
    const json = (await r.json()) as { code: number; msg?: string; data?: { removed: boolean } }
    if (!r.ok || json.code !== 0) {
      return res.status(502).json(reply(1, json.msg || '删除失败'))
    }
    if (!json.data?.removed) {
      return res.status(404).json(reply(1, '密钥不存在'))
    }
    return res.json(reply(0, 'ok'))
  } catch (e) {
    console.error('assets-keys DELETE 失败:', (e as Error).message)
    return res.status(500).json(reply(1, '删除失败'))
  }
})

export default router
