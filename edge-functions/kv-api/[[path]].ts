interface KvStore {
  get(key: string, type?: 'text' | 'json' | 'arrayBuffer' | 'stream'): Promise<unknown>
  put(key: string, value: string | ArrayBuffer | ArrayBufferView | ReadableStream): Promise<void>
  delete(key: string): Promise<void>
  list(options?: {
    prefix?: string
    limit?: number
    cursor?: string
  }): Promise<{ complete: boolean; cursor: string; keys: Array<{ name: string }> }>
}

declare let img_kv: KvStore | undefined

// 每条记录独立 key 的前缀，配合 list 前缀扫描。用下划线规避冒号字符集风险。
const KEY_PREFIX = 'img_'
// 旧版单数组 key（迁移用）
const LEGACY_KEY = 'img_kv'

function base64UrlToBytes(str: string): Uint8Array {
  let b64 = str.replace(/-/g, '+').replace(/_/g, '/')
  while (b64.length % 4) b64 += '='
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

function base64UrlDecode(str: string): string {
  let b64 = str.replace(/-/g, '+').replace(/_/g, '/')
  while (b64.length % 4) b64 += '='
  return atob(b64)
}

async function verifyToken(token: string, secret: string): Promise<boolean> {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return false

    const [headerB64, payloadB64, signatureB64] = parts

    const payloadStr = base64UrlDecode(payloadB64)
    const payload = JSON.parse(payloadStr)
    if (payload.exp && payload.exp * 1000 < Date.now()) return false

    const encoder = new TextEncoder()
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    )

    const signature = base64UrlToBytes(signatureB64)
    const data = encoder.encode(`${headerB64}.${payloadB64}`)

    return crypto.subtle.verify('HMAC', key, signature, data)
  } catch {
    return false
  }
}

function jsonRes(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  })
}

function getKV(): KvStore {
  if (typeof img_kv === 'undefined') {
    throw new Error('KV Storage 未配置')
  }
  return img_kv
}

function genId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

type RecordItem = Record<string, unknown>

// 列出所有记录：list 前缀扫描翻页拿 key，再批量 get 取值
async function listItems(): Promise<RecordItem[]> {
  const kv = getKV()
  const allKeys: string[] = []
  let cursor: string | undefined
  let result
  do {
    // cursor 必须是字符串，首次不传（undefined 会导致 "cursor type invalid"）
    const opts: { prefix: string; limit: number; cursor?: string } = {
      prefix: KEY_PREFIX,
      limit: 256,
    }
    if (cursor) opts.cursor = cursor
    result = await kv.list(opts)
    for (const k of result.keys) allKeys.push(k.name)
    cursor = result.complete ? undefined : result.cursor
  } while (cursor)

  // 并发取值
  const items = await Promise.all(
    allKeys.map(async (k) => {
      try {
        const v = (await kv.get(k, 'json')) as RecordItem | null
        return v ? { ...v, _key: k } : null
      } catch {
        return null
      }
    }),
  )
  return items.filter((x): x is RecordItem => x !== null)
}

// 一次性迁移旧版单数组数据到独立 key 格式。迁移后删除旧 key。
async function migrateLegacy(): Promise<void> {
  const kv = getKV()
  let legacy: unknown
  try {
    legacy = await kv.get(LEGACY_KEY, 'json')
  } catch {
    return // 旧 key 不存在，无需迁移
  }
  if (!Array.isArray(legacy)) return
  const arr = legacy as RecordItem[]
  if (arr.length === 0) {
    await kv.delete(LEGACY_KEY)
    return
  }
  // 逐条写入独立 key（保留原 id，无则生成）
  for (const item of arr) {
    const id = (item.id as string) || genId()
    const key = KEY_PREFIX + id
    await kv.put(key, JSON.stringify(item))
  }
  await kv.delete(LEGACY_KEY)
  console.log(`migrated ${arr.length} legacy records`)
}

async function addItem(item: RecordItem): Promise<RecordItem> {
  const kv = getKV()
  const id = (item.id as string) || genId()
  const newItem = { ...item, id, createdAt: new Date().toISOString() }
  await kv.put(KEY_PREFIX + id, JSON.stringify(newItem))
  return newItem
}

async function removeItem(id: string): Promise<void> {
  await getKV().delete(KEY_PREFIX + id)
}

export async function onRequest(context: {
  request: Request
  env: Record<string, string | undefined>
  params: { path?: string | string[] }
}) {
  if (context.request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      },
    })
  }

  const authHeader = context.request.headers.get('Authorization')
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return jsonRes({ code: 1, msg: '未授权' }, 401)
  }

  const token = authHeader.slice(7)
  const uploadPassword = context.env.UPLOAD_PASSWORD
  if (!uploadPassword) {
    return jsonRes({ code: 1, msg: '服务器未配置上传密码' }, 500)
  }

  const valid = await verifyToken(token, uploadPassword)
  if (!valid) {
    return jsonRes({ code: 1, msg: 'token 无效或已过期' }, 401)
  }

  const method = context.request.method
  const pathSegments = context.params.path

  try {
    if (method === 'GET') {
      // 列表前先尝试迁移旧数据（幂等：迁移完旧 key 被删，下次直接跳过）
      await migrateLegacy().catch((e) => console.error('migrate error:', (e as Error).message))
      const items = await listItems()
      // 按创建时间倒序
      items.sort((a, b) => {
        const ta = new Date((a.createdAt as string) || 0).getTime()
        const tb = new Date((b.createdAt as string) || 0).getTime()
        return tb - ta
      })
      return jsonRes({ code: 0, msg: 'ok', data: { images: items, total: items.length } })
    }

    if (method === 'POST') {
      const body = (await context.request.json()) as Record<string, unknown>
      const item = await addItem(body)
      return jsonRes({ code: 0, msg: 'ok', data: item })
    }

    if (method === 'DELETE') {
      const id = Array.isArray(pathSegments) ? pathSegments[0] : pathSegments
      if (!id) {
        return jsonRes({ code: 1, msg: '缺少 id' }, 400)
      }
      await removeItem(id)
      return jsonRes({ code: 0, msg: '删除成功' })
    }

    return jsonRes({ code: 1, msg: '不支持的请求方法' }, 405)
  } catch (e: unknown) {
    return jsonRes({ code: 1, msg: (e as Error).message || '操作失败' }, 500)
  }
}
