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
// 单 key 聚合索引：存全部记录的数组。图库/查重/列表都用它（实测 1 次 get ~4ms，
// 远快于 list翻页 + get×N 的 ~1.5s）。每条独立 key 仍保留为可信数据源 + 重建依据。
const INDEX_KEY = 'idx_all'
// 标记 idx_all 是否已初始化过（区分「空库，已建索引」和「从未建过索引需迁移」）。
const INDEX_INIT_KEY = 'idx_init'

import {
  extractKeys,
  pickOrigin as pickOriginPure,
  base64UrlDecode,
  base64UrlToBytes,
  genId,
} from './_helpers'

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

// CORS：kv-api 是管理/写端点，收紧到白名单域名（M3），避免任意站点用 token 调用。
// 从请求里取 Origin，交给纯函数 pickOriginPure 判断。
function pickOrigin(req: Request, env: Record<string, string | undefined>): string | null {
  return pickOriginPure(req.headers.get('Origin'), env)
}

// jsonRes 默认收紧 CORS（只对白名单 Origin 放开）。调用方传 req + env 才能下发 Origin。
function jsonRes(data: unknown, status = 200, corsOrigin?: string | null): Response {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (corsOrigin) headers['Access-Control-Allow-Origin'] = corsOrigin
  return new Response(JSON.stringify(data), { status, headers })
}

function getKV(): KvStore {
  if (typeof img_kv === 'undefined') {
    throw new Error('KV Storage 未配置')
  }
  return img_kv
}

type RecordItem = Record<string, unknown>

// 列出所有记录：list 前缀扫描翻页拿 key，再批量 get 取值
async function listItems(): Promise<RecordItem[]> {
  const kv = getKV()
  const allKeys: string[] = []
  let cursor: string | undefined
  let result: unknown
  let guard = 0
  do {
    if (guard++ > 50) break // 防止无限翻页
    const opts: { prefix: string; limit: number; cursor?: string } = {
      prefix: KEY_PREFIX,
      limit: 256,
    }
    if (cursor) opts.cursor = cursor
    result = await kv.list(opts)
    const parsed = extractKeys(result)
    allKeys.push(...parsed.names)
    cursor = parsed.complete ? undefined : parsed.cursor
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

// ===== 单 key 聚合索引（idx_all）=====
// 一次 get 拿到全部记录，图库列表/查重都走这里（~4ms）。
// 写操作（增删改）会增量维护这个索引，保证一致性。
async function getIndex(): Promise<RecordItem[]> {
  try {
    const v = (await getKV().get(INDEX_KEY, 'json')) as RecordItem[] | null
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

async function setIndex(items: RecordItem[]): Promise<void> {
  const kv = getKV()
  await kv.put(INDEX_KEY, JSON.stringify(items))
  // 标记已初始化，空库写 [] 后也不算「未迁移」
  await kv.put(INDEX_INIT_KEY, '1')
}

// idx_all 是否已初始化（区分「空库已建索引」和「从未建过需迁移」，
// 避免空库每次 GET 都误触发全量 list 重建）
async function isIndexInitialized(): Promise<boolean> {
  try {
    return (await getKV().get(INDEX_INIT_KEY, 'text')) === '1'
  } catch {
    return false
  }
}

// 一次性迁移：从每条独立 key 重建 idx_all 聚合索引。
// 存量数据首次切到单 key 方案时调用，之后写操作会增量维护，无需再跑。
async function rebuildIndex(): Promise<{ total: number }> {
  await migrateLegacy().catch((e) => console.error('migrate error:', (e as Error).message))
  const items = await listItems()
  await setIndex(items) // setIndex 内会标记 idx_init=1
  return { total: items.length }
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

// 把图片加入对应 tag 桶。桶 key: tag_{名称}，value: [{u:代理url, o:CNB直链}] 数组。
// 随机图端点直接 get 对应桶（1 次 get），避免 list + 批量 get，根治冷启动慢。
async function addToTagBuckets(url: string, urlOriginal: unknown, tags: unknown): Promise<void> {
  const kv = getKV()
  const tagList = Array.isArray(tags) ? (tags as string[]) : []
  const entry = { u: url, o: typeof urlOriginal === 'string' ? urlOriginal : url }
  // 无 tag 的图只进「全部」桶；有 tag 的进对应桶 + 全部桶
  const targets = tagList.length > 0 ? tagList : []
  const bucketKeys = ['_all']
  for (const t of targets) bucketKeys.push(t)
  for (const bk of bucketKeys) {
    const fullKey = 'tag_' + bk
    let bucket: Array<{ u: string; o: string }> = []
    try {
      const existing = (await kv.get(fullKey, 'json')) as Array<{ u: string; o: string }> | null
      if (Array.isArray(existing)) bucket = existing
    } catch {}
    if (!bucket.some((e) => e.u === url)) bucket.push(entry)
    await kv.put(fullKey, JSON.stringify(bucket))
  }
}

async function addItem(item: RecordItem): Promise<RecordItem> {
  const kv = getKV()
  const id = (item.id as string) || genId()
  const newItem = { ...item, id, createdAt: new Date().toISOString() }
  // 写每条独立 key（可信数据源）
  await kv.put(KEY_PREFIX + id, JSON.stringify(newItem))
  // 增量维护 idx_all 聚合索引（图库列表走它，1次get ~4ms）
  const index = await getIndex()
  index.push(newItem)
  await setIndex(index)
  // 维护 tag 桶索引，加速随机图端点
  if (newItem.url) {
    await addToTagBuckets(String(newItem.url), newItem.urlOriginal, newItem.tags).catch(() => {})
  }
  return newItem
}

// 读单条记录
async function getItem(id: string): Promise<RecordItem | null> {
  try {
    const v = (await getKV().get(KEY_PREFIX + id, 'json')) as RecordItem | null
    return v
  } catch {
    return null
  }
}

// 更新单条记录：读旧值 → 合并传入字段 → 写回。用于改 tag。
async function updateItem(id: string, patch: RecordItem): Promise<RecordItem | null> {
  const kv = getKV()
  const old = await getItem(id)
  if (!old) return null
  const updated = { ...old, ...patch, id }
  // 写每条独立 key
  await kv.put(KEY_PREFIX + id, JSON.stringify(updated))
  // 同步更新 idx_all 里对应记录
  const index = await getIndex()
  const i = index.findIndex((it) => it.id === id)
  if (i >= 0) {
    index[i] = { ...index[i], ...updated }
    await setIndex(index)
  }
  return updated
}

// 重建所有 tag 桶：拉全量记录 → 分桶 → 覆盖式写入 tag_{名称} key。
// 用于存量数据迁移（让 /img 随机端点能走桶索引）。
async function rebuildBuckets(): Promise<{ buckets: number; total: number }> {
  const kv = getKV()
  const items = await listItems()
  const buckets: Record<string, Array<{ u: string; o: string }>> = { _all: [] }

  for (const it of items) {
    const url = String(it.url || '')
    const o = String(it.urlOriginal || url)
    if (!url) continue
    const entry = { u: url, o }
    buckets._all.push(entry)
    for (const t of Array.isArray(it.tags) ? (it.tags as string[]) : []) {
      const k = String(t)
      if (!buckets[k]) buckets[k] = []
      if (!buckets[k].some((e) => e.u === url)) buckets[k].push(entry)
    }
  }

  let count = 0
  for (const [tag, entries] of Object.entries(buckets)) {
    await kv.put('tag_' + tag, JSON.stringify(entries))
    count++
  }
  // 顺带刷新聚合索引（全量重建，保证一致）
  await setIndex(items)
  return { buckets: count, total: items.length }
}

async function removeItem(id: string): Promise<void> {
  const kv = getKV()
  // 删每条独立 key
  await kv.delete(KEY_PREFIX + id)
  // 同步从 idx_all 移除
  const index = await getIndex()
  const next = index.filter((it) => it.id !== id)
  if (next.length !== index.length) {
    await setIndex(next)
  }
}

// 按文件哈希查重：读 idx_all 聚合索引（1次get），返回命中记录或 null。
// 用于上传前避免重复：前端算好原始文件 hash，命中则直接复用链接。
async function findByHash(hash: string): Promise<RecordItem | null> {
  const items = await getIndex()
  return items.find((it) => String(it.hash || '') === hash) || null
}

export async function onRequest(context: {
  request: Request
  env: Record<string, string | undefined>
  params: { path?: string | string[] }
}) {
  // 统一在本仓库入口计算一次允许的 Origin（M3 收紧 CORS）
  const origin = pickOrigin(context.request, context.env)

  if (context.request.method === 'OPTIONS') {
    const headers: Record<string, string> = {
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    }
    if (origin) headers['Access-Control-Allow-Origin'] = origin
    return new Response(null, { headers })
  }

  // GET /kv-api/login-path — 公开端点（无需 JWT）：返回当前登录路径，无则随机生成。
  // 前端路由守卫用它跳转登录页。路径本身是秘密（不知道路径看不到登录表单）。
  const pathSegments0 = context.params.path
  const firstSeg0 = Array.isArray(pathSegments0) ? pathSegments0[0] : pathSegments0
  if (firstSeg0 === 'login-path' && context.request.method === 'GET') {
    try {
      const kv = typeof img_kv !== 'undefined' ? img_kv : undefined
      if (!kv) return jsonRes({ code: 1, msg: 'KV 未配置' }, 500, origin)
      let loginPath = (await kv.get('login_path', 'text')) as string | null
      if (!loginPath) {
        // 首次：随机生成 16 位路径（crypto.randomUUID 去横线取前 16 位）
        loginPath = (crypto.randomUUID().replace(/-/g, '')).slice(0, 16)
        await kv.put('login_path', loginPath)
      }
      return jsonRes({ code: 0, msg: 'ok', data: { loginPath } }, 200, origin)
    } catch {
      return jsonRes({ code: 1, msg: '获取登录路径失败' }, 500, origin)
    }
  }

  const authHeader = context.request.headers.get('Authorization')
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return jsonRes({ code: 1, msg: '未授权' }, 401, origin)
  }

  const token = authHeader.slice(7)
  // 优先用独立的 JWT_SECRET（与登录密码解耦），未配置则回退 UPLOAD_PASSWORD（兼容）
  const jwtSecret = context.env.JWT_SECRET || context.env.UPLOAD_PASSWORD
  if (!jwtSecret) {
    return jsonRes({ code: 1, msg: '服务器未配置 JWT 密钥' }, 500, origin)
  }

  const valid = await verifyToken(token, jwtSecret)
  if (!valid) {
    return jsonRes({ code: 1, msg: 'token 无效或已过期' }, 401, origin)
  }

  const method = context.request.method
  const pathSegments = context.params.path

  try {
    if (method === 'GET') {
      // 子路由 GET /kv-api/check?hash=xxx — 按文件哈希查重
      const firstSeg = Array.isArray(pathSegments) ? pathSegments[0] : pathSegments
      if (firstSeg === 'check') {
        const url = new URL(context.request.url)
        const hash = (url.searchParams.get('hash') || '').trim()
        if (!hash) {
          return jsonRes({ code: 1, msg: '缺少 hash 参数' }, 400, origin)
        }
        const hit = await findByHash(hash)
        return jsonRes({ code: 0, msg: 'ok', data: { exists: !!hit, record: hit } }, 200, origin)
      }

      // 列表：优先读单 key 聚合索引 idx_all（1次get ~4ms）。
      // 首次切到本方案时 idx_init 不存在 → 自动重建一次（幂等），之后写操作增量维护。
      let items = await getIndex()
      const initialized = await isIndexInitialized()
      if (!initialized) {
        // 聚合索引从未建过：从每条独立 key 重建一次（存量迁移）
        await rebuildIndex()
        items = await getIndex()
      }
      // 按创建时间倒序
      items.sort((a, b) => {
        const ta = new Date((a.createdAt as string) || 0).getTime()
        const tb = new Date((b.createdAt as string) || 0).getTime()
        return tb - ta
      })
      return jsonRes({ code: 0, msg: 'ok', data: { images: items, total: items.length } }, 200, origin)
    }

    if (method === 'POST') {
      const body = (await context.request.json()) as Record<string, unknown>
      const firstSeg = Array.isArray(pathSegments) ? pathSegments[0] : pathSegments
      // 子路由 POST /kv-api/rebuild-idx — 从每条独立 key 重建 idx_all 聚合索引
      if (firstSeg === 'rebuild-idx') {
        const result = await rebuildIndex()
        return jsonRes({ code: 0, msg: '聚合索引重建完成', data: result }, 200, origin)
      }
      // 子路由 POST /kv-api/rebuild-buckets — 一次性构建 tag 桶索引（顺带刷新 idx_all）
      if (firstSeg === 'rebuild-buckets') {
        const result = await rebuildBuckets()
        return jsonRes({ code: 0, msg: '桶索引重建完成', data: result }, 200, origin)
      }
      const item = await addItem(body)
      return jsonRes({ code: 0, msg: 'ok', data: item }, 200, origin)
    }

    if (method === 'PUT') {
      const id = Array.isArray(pathSegments) ? pathSegments[0] : pathSegments
      // 子路由 PUT /kv-api/login-path — 管理员重置登录路径（生成新随机路径，旧的失效）
      if (id === 'login-path') {
        try {
          const kv = typeof img_kv !== 'undefined' ? img_kv : undefined
          if (!kv) return jsonRes({ code: 1, msg: 'KV 未配置' }, 500, origin)
          const newLoginPath = (crypto.randomUUID().replace(/-/g, '')).slice(0, 16)
          await kv.put('login_path', newLoginPath)
          return jsonRes({ code: 0, msg: '登录路径已重置', data: { loginPath: newLoginPath } }, 200, origin)
        } catch {
          return jsonRes({ code: 1, msg: '重置失败' }, 500, origin)
        }
      }
      if (!id) {
        return jsonRes({ code: 1, msg: '缺少 id' }, 400, origin)
      }
      const body = (await context.request.json()) as Record<string, unknown>
      const updated = await updateItem(id, body as RecordItem)
      if (!updated) {
        return jsonRes({ code: 1, msg: '记录不存在' }, 404, origin)
      }
      return jsonRes({ code: 0, msg: 'ok', data: updated }, 200, origin)
    }

    if (method === 'DELETE') {
      const id = Array.isArray(pathSegments) ? pathSegments[0] : pathSegments
      if (!id) {
        return jsonRes({ code: 1, msg: '缺少 id' }, 400, origin)
      }
      await removeItem(id)
      return jsonRes({ code: 0, msg: '删除成功' }, 200, origin)
    }

    return jsonRes({ code: 1, msg: '不支持的请求方法' }, 405, origin)
  } catch (e: unknown) {
    return jsonRes({ code: 1, msg: (e as Error).message || '操作失败' }, 500, origin)
  }
}
