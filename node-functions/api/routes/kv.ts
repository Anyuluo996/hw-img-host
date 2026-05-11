import { Router } from 'express'
import { reply } from '../_reply'
import { authMiddleware } from '../_auth'

interface KvStore {
  get(key: string, type?: 'text' | 'json' | 'arrayBuffer' | 'stream'): Promise<unknown>
  put(key: string, value: string | ArrayBuffer | ArrayBufferView | ReadableStream): Promise<void>
  delete(key: string): Promise<void>
}

declare let img_kv: KvStore | undefined

const router = Router()

const KV_KEY = 'img_kv'
const MAX_ITEMS = 500

function getKV(): KvStore {
  if (typeof img_kv === 'undefined') {
    throw new Error('KV Storage 未配置，请在 EdgeOne Pages 控制台启用并绑定 KV 命名空间')
  }
  return img_kv
}

async function getItems(): Promise<Record<string, unknown>[]> {
  try {
    const data = await getKV().get(KV_KEY, 'json')
    return Array.isArray(data) ? data : []
  } catch (e) {
    console.error('KV getItems error:', (e as Error).message)
    return []
  }
}

async function addItem(item: Record<string, unknown>) {
  const kv = getKV()
  const items = await getItems()
  const newItem = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    ...item,
    createdAt: new Date().toISOString(),
  }
  items.unshift(newItem)
  if (items.length > MAX_ITEMS) items.length = MAX_ITEMS
  await kv.put(KV_KEY, JSON.stringify(items))
  return newItem
}

async function removeItem(id: string) {
  const items = await getItems()
  await getKV().put(KV_KEY, JSON.stringify(items.filter((r) => (r as { id?: string }).id !== id)))
}

router.get('/', authMiddleware, async (_req, res) => {
  try {
    const items = await getItems()
    res.json(reply(0, 'ok', { images: items, total: items.length }))
  } catch (e: unknown) {
    res.status(500).json(reply(1, (e as Error).message || '获取KV数据失败'))
  }
})

router.post('/', authMiddleware, async (req, res) => {
  try {
    const item = await addItem(req.body as Record<string, unknown>)
    res.json(reply(0, 'ok', item))
  } catch (e: unknown) {
    res.status(500).json(reply(1, (e as Error).message || '保存KV数据失败'))
  }
})

router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    await removeItem(req.params.id)
    res.json(reply(0, '删除成功'))
  } catch (e: unknown) {
    res.status(500).json(reply(1, (e as Error).message || '删除失败'))
  }
})

export default router
