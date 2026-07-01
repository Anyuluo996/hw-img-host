// Assets 中转 API 边缘函数 —— 同时承担两个职责：
//
// 1. KV 索引读写（node 路由调用，JWT 鉴权）
//    POST   /assets-api/index        写入记录
//    DELETE /assets-api/index        删除记录（?service=&key=）
//    GET    /assets-api/check        查询存在性（?service=&key=）
//    GET    /assets-api/list         列举（?service=&prefix=&limit=）
//
// 2. 私有下载（外部调用方，X-API-Key 鉴权 + 强隔离）
//    GET    /assets-api/{service}/{key}   流式返回 CNB 原始字节
//
// 两套鉴权路径：
//   - 索引操作：Bearer JWT（node 自签，与 kv-api 同机制）→ 只信 node 路由的内部调用
//   - 私有下载：X-API-Key → 反查 service，且路径第一段必须等于该 service（强隔离）
//
// KV 命名空间（与现有 img_/idx_all 完全分离，零干扰）：
//   asset_{service}_{key}   单条记录
//   aidx_{service}          该 service 的聚合索引（列举用）

interface EdgeContext {
  request: Request
  env: Record<string, string | undefined>
  params: { path?: string | string[] }
}

interface KvStore {
  get(key: string, type?: 'text' | 'json' | 'arrayBuffer' | 'stream'): Promise<unknown>
  put(key: string, value: string | ArrayBuffer | ArrayBufferView | ReadableStream): Promise<void>
  delete(key: string): Promise<void>
  list(options?: {
    prefix?: string
    limit?: number
    cursor?: string
  }): Promise<{ complete: boolean; cursor: string; keys: Array<{ name?: string; key?: string }> }>
}

declare let img_kv: KvStore | undefined

// EdgeOne 运行时全局注入的 KV 绑定（与 kv-api / img 同名，逐文件复制声明）。
function getKV(): KvStore {
  if (typeof img_kv === 'undefined') throw new Error('KV Storage 未配置')
  return img_kv
}

// ============ 响应辅助 ============

function jsonRes(data: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...(headers || {}) },
  })
}

// 空响应（零信息泄露，401/403/404）
function emptyRes(status: number): Response {
  return new Response(null, { status })
}

// ============ Web Crypto 工具（JWT 验签，从 kv-api 移植）============

function base64UrlDecode(b64: string): string {
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4))
  const b64u = b64.replace(/-/g, '+').replace(/_/g, '/') + pad
  const bin = atob(b64u)
  // 处理多字节 UTF-8
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

function base64UrlToBytes(b64: string): Uint8Array {
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4))
  const b64u = b64.replace(/-/g, '+').replace(/_/g, '/') + pad
  const bin = atob(b64u)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

async function verifyJwt(token: string, secret: string): Promise<boolean> {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return false
    const [headerB64, payloadB64, signatureB64] = parts
    const payload = JSON.parse(base64UrlDecode(payloadB64)) as { exp?: number }
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
    // Uint8Array→BufferSource 的类型摩擦在 TS5.4+ lib 下是已知现象，运行时无碍
    return crypto.subtle.verify('HMAC', key, signature as BufferSource, data)
  } catch {
    return false
  }
}

// ============ X-API-Key 校验（多密钥 + timing-safe + 强隔离）============

// 解析 ASSETS_KEYS = {"service":"key",...}，返回 key→service 映射。
function parseKeys(raw: string | undefined): Map<string, string> {
  const map = new Map<string, string>()
  if (!raw) return map
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>
    for (const [service, key] of Object.entries(obj)) {
      if (typeof key === 'string' && key.length > 0 && service.length > 0) {
        map.set(key, service)
      }
    }
  } catch {
    /* fail-closed */
  }
  return map
}

// 常量时间比较（Web Crypto subtle.timingSafeEqual 不存在，手写 XOR）。
function safeEqualStr(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a)
  const eb = new TextEncoder().encode(b)
  if (ea.length !== eb.length) return false
  let diff = 0
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i]
  return diff === 0
}

// 从请求校验 X-API-Key，返回绑定的 service。失败返回 null。
// 两级查询：KV 密钥库优先 → 环境变量 ASSETS_KEYS fallback。
async function checkApiKey(
  req: Request,
  env: Record<string, string | undefined>,
): Promise<string | null> {
  // fail-closed：KV 不可用且环境变量未配置时拒绝
  const provided = req.headers.get('x-api-key')
  if (!provided) return null
  return resolveService(provided, env)
}

// ============ 索引操作（JWT 鉴权，node 内部调用）============

// 记录主键：asset_{service}_{key}。key 中的 / 保留（KV key 允许）。
function recordKey(service: string, key: string): string {
  return `asset_${service}_${key}`
}

// 聚合索引键：aidx_{service}
function indexKey(service: string): string {
  return `aidx_${service}`
}

// 索引状态：版本号 + 记录数组。ver 用于乐观并发检测（读改写重试）。
// 旧索引（裸数组）在 getIndexState 里自动迁移，向后兼容存量数据。
interface IndexState {
  ver: number
  items: AssetRecord[]
}

// 读取索引状态。兼容两种存量格式：
//  - 旧裸数组 AssetRecord[]  → 迁移为 { ver: Date.now(), items }
//  - 新对象 { ver, items }    → 原样返回
//  - null/异常                → 空状态（ver 用当前时间，确保首次写入有区分度）
async function getIndexState(service: string): Promise<IndexState> {
  const v = await getKV().get(indexKey(service), 'json').catch(() => null)
  if (Array.isArray(v)) {
    // 旧裸数组格式 → 自动迁移
    return { ver: Date.now(), items: v as AssetRecord[] }
  }
  if (v && typeof v === 'object' && Array.isArray((v as IndexState).items)) {
    return v as IndexState
  }
  return { ver: 0, items: [] }
}

async function setIndexState(service: string, state: IndexState): Promise<void> {
  await getKV().put(indexKey(service), JSON.stringify(state))
}

// 保留旧名（只读路径用）：返回 items 数组。
async function getIndex(service: string): Promise<AssetRecord[]> {
  return (await getIndexState(service)).items
}

async function findRecord(service: string, key: string): Promise<AssetRecord | null> {
  const v = (await getKV().get(recordKey(service, key), 'json')) as AssetRecord | null
  return v || null
}

// ============ 乐观并发：版本号 + 重试 ============
//
// KV 是最终一致（<60s），无 CAS/条件写。纯互斥锁本身也会竞态（两个并发请求
// 可能同时拿到同一把"锁"）。这里用「读 → 改 → 重读校验 ver → 写」三步：
//   1. 读出 (ver0, items0)
//   2. fn 在内存里算出 next
//   3. 再读一次：若 ver 仍是 ver0 → 写回 (ver0+1, next)；否则说明期间有人写过，重试
// 重试上限 3 次，仍冲突则抛错（极端竞态，交给兜底重建自愈）。
// 注意：最终一致窗口内仍可能两人读到同一 ver0，此时版本号挡不住，
//       所以列表端点另有 rebuildAssetIndex 兜底（见 list 处理）。
async function mutateIndex<T>(
  service: string,
  fn: (items: AssetRecord[]) => { items: AssetRecord[]; result: T },
): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const state = await getIndexState(service)
    const { items: next, result } = fn(state.items)
    // 写前重读校验 ver：变了就放弃本次改动重读
    const fresh = await getIndexState(service)
    if (fresh.ver !== state.ver) continue
    await setIndexState(service, { ver: state.ver + 1, items: next })
    return result
  }
  throw new Error('index 写冲突，重试耗尽')
}

async function putRecord(rec: AssetRecord): Promise<void> {
  await getKV().put(recordKey(rec.service, rec.key), JSON.stringify(rec))
  // 维护聚合索引（乐观并发）
  await mutateIndex(rec.service, (items) => {
    const i = items.findIndex((it) => it.service === rec.service && it.key === rec.key)
    if (i >= 0) items[i] = rec
    else items.push(rec)
    return { items: [...items], result: undefined }
  })
}

async function removeRecord(service: string, key: string): Promise<boolean> {
  const exists = await findRecord(service, key)
  if (!exists) return false
  await getKV().delete(recordKey(service, key))
  return mutateIndex(service, (items) => {
    const next = items.filter((it) => !(it.service === service && it.key === key))
    return { items: next, result: next.length !== items.length }
  })
}

// 从每条独立 KV 记录重建某 service 的聚合索引（真相源 → 缓存）。
// 用于：① 首次升级的存量迁移；② 极端竞态后的自愈；③ 手动清理残留。
// 翻页 list({prefix:'asset_'+service}) → 批量 get → 过滤已过期 → 覆盖式写回（高 ver）。
// 与 kv-api.rebuildIndex 同构。
// 稳健解析 kv.list() 返回值里的 key 名数组 + 分页游标。
// EdgeOne 运行时实际返回 { complete, cursor, keys:[{key, ...}] }（字段名是 key 不是 name），
// 但不同版本/路径下可能形态不一（裸数组、keys 缺失等）。本函数兼容所有形态，
// 逻辑与 kv-api/_helpers.extractKeys 一致（该文件无法跨目录 import）。
function extractKeyNames(result: unknown): { names: string[]; complete: boolean; cursor?: string } {
  if (!result) return { names: [], complete: true }
  // 情况1: { keys: [...] }
  if (Array.isArray((result as { keys?: unknown }).keys)) {
    const r = result as { keys: unknown[]; complete?: boolean; cursor?: string }
    const names = r.keys.map((k) => {
      if (typeof k === 'string') return k
      const obj = k as { key?: string; name?: string }
      return obj.key || obj.name || ''
    })
    return { names: names.filter(Boolean), complete: r.complete !== false, cursor: r.cursor }
  }
  // 情况2: 直接是数组
  if (Array.isArray(result)) {
    const names = result.map((k) => {
      if (typeof k === 'string') return k
      const obj = k as { key?: string; name?: string }
      return obj.key || obj.name || ''
    })
    return { names: names.filter(Boolean), complete: true }
  }
  return { names: [], complete: true }
}

async function rebuildAssetIndex(
  service: string,
  env: Record<string, string | undefined>,
): Promise<{ total: number; cleaned: number }> {
  const kv = getKV()
  const prefix = `asset_${service}_`
  const allKeys: string[] = []
  let cursor: string | undefined
  let guard = 0
  do {
    if (guard++ > 50) break // 防无限翻页
    const opts: { prefix: string; limit: number; cursor?: string } = { prefix, limit: 256 }
    if (cursor) opts.cursor = cursor
    const result = await kv.list(opts)
    const parsed = extractKeyNames(result)
    allKeys.push(...parsed.names)
    cursor = parsed.complete ? undefined : parsed.cursor
  } while (cursor)

  const now = Date.now()
  const items = await Promise.all(
    allKeys.map(async (k) => {
      try {
        const v = (await kv.get(k, 'json')) as AssetRecord | null
        return v || null
      } catch {
        return null
      }
    }),
  )
  const expired = items.filter(
    (it): it is AssetRecord =>
      !!it && !!it.expiresAt && new Date(it.expiresAt).getTime() < now,
  )
  const live = items.filter((it): it is AssetRecord => {
    if (!it) return false
    if (it.expiresAt && new Date(it.expiresAt).getTime() < now) return false
    return true
  })
  // 对过期项执行双删：删 KV 记录 + 删 CNB 文件（修复旧版只移除索引项的泄漏）
  if (expired.length > 0) {
    await Promise.all(
      expired.map(async (r) => {
        await kv.delete(recordKey(r.service, r.key)).catch(() => {})
        if (r.cnbPath) await deleteCnbFile(r.cnbPath, env).catch(() => {})
      }),
    )
  }
  // 高 ver 写回，压过任何并发旧写
  await setIndexState(service, { ver: Date.now(), items: live })
  return { total: live.length, cleaned: expired.length }
}

interface AssetRecord {
  service: string
  key: string
  public: boolean
  url: string
  cnbPath: string
  hash?: string
  name?: string
  size?: number
  mime?: string
  createdAt?: string
  expiresAt?: string | null // ISO 时间戳；null/缺省=永不过期。懒删除据此清理
  status?: 'uploading' | 'ready' // 大文件三阶段上传标记；缺省=ready（兼容旧记录）
  sessionId?: string // 三阶段上传会话 ID（complete 时反查用）
}

// ============ TTL 懒删除 ============

// 从 cnbPath（如 /slug/-/imgs|files/ID/uuid.ext）提取 CNB DELETE 需要的子路径。
// 逻辑与 node 端 _utils.extractImagePath 一致。
function extractCnbSubPath(cnbPath: string): string {
  const path = String(cnbPath).split(/[?#]/)[0]
  const match = path.match(/-\/(?:imgs|files)\/(.+)/)
  return match ? match[1] : path
}

// 调 CNB DELETE API 删除实际文件。token/slug 来自 env。
// 失败不抛（吞掉错误），因为懒删除不应因单个 CNB 删除失败而中断清理其他记录。
// 返回是否成功。
async function deleteCnbFile(
  cnbPath: string,
  env: Record<string, string | undefined>,
): Promise<boolean> {
  const token = env.TOKEN_DELETE
  const slug = env.SLUG_IMG
  if (!token || !slug) return false
  const subPath = extractCnbSubPath(cnbPath)
  const isImgs = cnbPath.includes('/-/imgs/')
  const deleteUrl = `https://api.cnb.cool/${slug}/-/${isImgs ? 'imgs' : 'files'}/${subPath}`
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 15000)
  try {
    const resp = await fetch(deleteUrl, {
      method: 'DELETE',
      signal: controller.signal,
      headers: { Authorization: `Bearer ${token}` },
    })
    return resp.ok
  } catch {
    return false
  } finally {
    clearTimeout(timeoutId)
  }
}

// 扫描某 service 的索引，删掉已过期的记录（KV 记录 + 索引项 + CNB 实际文件）。
// 返回清理条数。env 用于调 CNB DELETE（TOKEN_DELETE/SLUG_IMG）。
// 索引项的删除走 mutateIndex（乐观并发）；KV 记录与 CNB 文件删除作为副作用并行执行。
async function sweepExpired(
  service: string,
  env: Record<string, string | undefined>,
): Promise<number> {
  const now = Date.now()
  // 先读一次挑出过期项（用于副作用删除）
  const state = await getIndexState(service)
  const expired = state.items.filter(
    (r) => r.expiresAt && new Date(r.expiresAt).getTime() < now,
  )
  if (expired.length === 0) return 0
  // 删 KV 记录 + CNB 文件（并行，单个失败不影响其他）
  await Promise.all(
    expired.map(async (r) => {
      await getKV()
        .delete(recordKey(r.service, r.key))
        .catch(() => {})
      if (r.cnbPath) await deleteCnbFile(r.cnbPath, env).catch(() => {})
    }),
  )
  // 从索引移除过期项（乐观并发）
  try {
    await mutateIndex(service, (items) => {
      const next = items.filter(
        (it) => !(it.expiresAt && new Date(it.expiresAt).getTime() < now),
      )
      return { items: next, result: undefined }
    })
  } catch {
    // 索引写冲突：实际 KV 记录已删，索引会在下次 rebuild 自愈，不阻塞流程
  }
  return expired.length
}

// 扫描所有 service（aidx_* 聚合索引键），逐个调 sweepExpired。
// 解决低频/静默 service 的孤儿永远不被清理的问题。
async function sweepAllServices(
  env: Record<string, string | undefined>,
): Promise<{ services: number; cleaned: number; details: Array<{ service: string; cleaned: number }> }> {
  const kv = getKV()
  // 翻页收集所有 aidx_ 前缀的 key
  const allKeys: string[] = []
  let cursor: string | undefined
  let guard = 0
  do {
    if (guard++ > 50) break
    const opts: { prefix: string; limit: number; cursor?: string } = { prefix: 'aidx_', limit: 256 }
    if (cursor) opts.cursor = cursor
    const result = await kv.list(opts)
    const parsed = extractKeyNames(result)
    allKeys.push(...parsed.names)
    cursor = parsed.complete ? undefined : parsed.cursor
  } while (cursor)

  // 从 key 名提取 service：aidx_{service} → {service}
  const services = allKeys.map((k) => k.replace(/^aidx_/, '')).filter(Boolean)

  // 逐 service 清理（并行）
  const details = await Promise.all(
    services.map(async (service) => ({
      service,
      cleaned: await sweepExpired(service, env).catch(() => 0),
    })),
  )
  const cleaned = details.reduce((sum, d) => sum + d.cleaned, 0)
  return { services: services.length, cleaned, details }
}

// CNB 对账：拉 CNB list-assets 全量清单 vs KV asset_* 记录，
// 找出 CNB 有但 KV 无的孤儿文件（rebuild 泄漏 / 手动删了索引但没删 CNB 等）。
// mode='dry-run' 只报告；mode='delete' 删孤儿。
async function reconcileCnb(
  env: Record<string, string | undefined>,
  mode: 'dry-run' | 'delete',
): Promise<{ cnbTotal: number; kvTotal: number; orphans: string[]; deleted: number }> {
  const token = env.TOKEN_DELETE
  const slug = env.SLUG_IMG
  if (!token || !slug) {
    return { cnbTotal: 0, kvTotal: 0, orphans: [], deleted: 0 }
  }

  // 1. 拉取 CNB 侧全量清单（分页 list-assets）
  const cnbPaths = new Set<string>()
  let page = 1
  let hasMore = true
  let pageGuard = 0
  while (hasMore && pageGuard++ < 100) {
    const listUrl = `https://api.cnb.cool/${slug}/-/list-assets?page=${page}&page_size=200`
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 15000)
    try {
      const resp = await fetch(listUrl, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      })
      if (!resp.ok) break
      const data = (await resp.json()) as Array<{ path?: string }> | { data?: Array<{ path?: string }> }
      const records = Array.isArray(data) ? data : data?.data || []
      if (records.length === 0) {
        hasMore = false
        break
      }
      for (const r of records) {
        if (r.path) cnbPaths.add(r.path)
      }
      // 不足一页 = 最后一页
      if (records.length < 200) hasMore = false
      else page++
    } catch {
      break
    } finally {
      clearTimeout(timeoutId)
    }
  }

  // 2. 拉取 KV 侧全量路径
  //    dry-run：从聚合索引读取（快，但可能 stale → 有少量假阳性，dry-run 可接受）
  //    delete：从每条独立记录读取（慢，但是真相源 → 绝不误删真实文件）
  //    统一去前导 / 后存入集合（CNB list-assets 返回的 path 无前导 /）
  const normPath = (p: string) => p.replace(/^\//, '')
  const kv = getKV()
  const kvPaths = new Set<string>()

  // 辅助：翻页扫描某前缀的独立记录，逐条 get 提取 path（真相源，准确但慢）
  async function scanRecordPaths(prefix: string, extractPath: (v: Record<string, unknown>) => string | undefined) {
    let cursor: string | undefined
    let guard = 0
    do {
      if (guard++ > 200) break
      const opts: { prefix: string; limit: number; cursor?: string } = { prefix, limit: 256 }
      if (cursor) opts.cursor = cursor
      const result = await kv.list(opts)
      const parsed = extractKeyNames(result)
      await Promise.all(
        parsed.names.map(async (k) => {
          try {
            const v = (await kv.get(k, 'json')) as Record<string, unknown> | null
            if (v) {
              const p = extractPath(v)
              if (p) kvPaths.add(normPath(p))
            }
          } catch {
            /* skip */
          }
        }),
      )
      cursor = parsed.complete ? undefined : parsed.cursor
    } while (cursor)
  }

  if (mode === 'delete') {
    // 删除模式：必须用真相源（独立记录），聚合索引可能 stale 导致误删
    await scanRecordPaths('asset_', (v) => v.cnbPath as string | undefined)
    await scanRecordPaths('img_', (v) => (v.assetsPath || v.urlOriginal) as string | undefined)
  } else {
    // dry-run：用聚合索引（快），假阳性无害（只报告不删）
    let aidxCursor: string | undefined
    let aidxGuard = 0
    do {
      if (aidxGuard++ > 50) break
      const opts: { prefix: string; limit: number; cursor?: string } = { prefix: 'aidx_', limit: 256 }
      if (aidxCursor) opts.cursor = aidxCursor
      const result = await kv.list(opts)
      const parsed = extractKeyNames(result)
      for (const k of parsed.names) {
        try {
          const v = (await kv.get(k, 'json')) as { items?: Array<{ cnbPath?: string }> } | null
          if (v?.items) {
            for (const it of v.items) {
              if (it.cnbPath) kvPaths.add(normPath(it.cnbPath))
            }
          }
        } catch {
          /* skip */
        }
      }
      aidxCursor = parsed.complete ? undefined : parsed.cursor
    } while (aidxCursor)

    try {
      const idxAll = (await kv.get('idx_all', 'json')) as Array<Record<string, unknown>> | null
      if (Array.isArray(idxAll)) {
        for (const it of idxAll) {
          const p = (it.assetsPath || it.urlOriginal) as string | undefined
          if (p) kvPaths.add(normPath(p))
        }
      }
    } catch {
      /* idx_all 不存在或读取失败，跳过 */
    }
  }

  // 3. 比对：CNB 有但两个 KV namespace 都无 = 孤儿
  const orphans = [...cnbPaths].filter((p) => !kvPaths.has(p))

  // 4. mode='delete' 时删孤儿
  let deleted = 0
  if (mode === 'delete' && orphans.length > 0) {
    const results = await Promise.all(
      orphans.map((path) => deleteCnbFile(path, env).catch(() => false)),
    )
    deleted = results.filter(Boolean).length
  }

  return { cnbTotal: cnbPaths.size, kvTotal: kvPaths.size, orphans, deleted }
}

// ============ 密钥管理（KV 存储，页面增删即时生效）============
//
// 密钥命名空间（与 asset_*/aidx_* 分离）：
//   akidx_all     全部密钥的聚合数组（唯一真相源）
//
// 设计说明：只用单 key 聚合数组，不维护 ak_{name} 单条记录。
// 原因：KV 是最终一致（<60s），单条与索引双写会出现写后读不一致，
// 导致"轮换后删不掉"（findKeyByName 读单条返回 null）。以索引为唯一真相源可彻底避免。

interface KeyRecord {
  name: string // = service 名，授权命名空间
  key: string // 明文密钥，k_ 前缀
  note?: string // 可选备注
  createdAt?: string
}

// 密钥索引状态：版本号 + 数组（与 asset 索引同一套乐观并发机制）。
interface KeyIndexState {
  ver: number
  items: KeyRecord[]
}

const KEY_INDEX = 'akidx_all'

async function getKeyIndexState(): Promise<KeyIndexState> {
  const v = await getKV().get(KEY_INDEX, 'json').catch(() => null)
  if (Array.isArray(v)) {
    // 旧裸数组格式 → 自动迁移
    return { ver: Date.now(), items: v as KeyRecord[] }
  }
  if (v && typeof v === 'object' && Array.isArray((v as KeyIndexState).items)) {
    return v as KeyIndexState
  }
  return { ver: 0, items: [] }
}

async function setKeyIndexState(state: KeyIndexState): Promise<void> {
  await getKV().put(KEY_INDEX, JSON.stringify(state))
}

// 保留旧名（只读路径用）：返回 items 数组。
async function getKeyIndex(): Promise<KeyRecord[]> {
  return (await getKeyIndexState()).items
}

// 密钥索引的乐观并发读改写（与 mutateIndex 同构）。
async function mutateKeyIndex<T>(
  fn: (items: KeyRecord[]) => { items: KeyRecord[]; result: T },
): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const state = await getKeyIndexState()
    const { items: next, result } = fn(state.items)
    const fresh = await getKeyIndexState()
    if (fresh.ver !== state.ver) continue
    await setKeyIndexState({ ver: state.ver + 1, items: next })
    return result
  }
  throw new Error('key index 写冲突，重试耗尽')
}

// 在索引里按 name 查找。索引是唯一真相源。
async function findKeyByName(name: string): Promise<KeyRecord | null> {
  const idx = await getKeyIndex()
  return idx.find((it) => it.name === name) || null
}

// 写入/更新：直接更新索引数组中的对应项（乐观并发）。
async function putKey(rec: KeyRecord): Promise<void> {
  await mutateKeyIndex((items) => {
    const i = items.findIndex((it) => it.name === rec.name)
    if (i >= 0) items[i] = rec
    else items.push(rec)
    return { items: [...items], result: undefined }
  })
}

async function removeKey(name: string): Promise<boolean> {
  return mutateKeyIndex((items) => {
    const before = items.length
    const next = items.filter((it) => it.name !== name)
    return { items: next, result: next.length !== before }
  })
}

// 校验 X-API-Key：先查 KV 密钥库，再 fallback 到环境变量 ASSETS_KEYS。
// 返回绑定的 service（密钥 name）。失败返回 null。timing-safe 比较。
async function resolveService(
  provided: string,
  env: Record<string, string | undefined>,
): Promise<string | null> {
  if (!provided) return null
  // 1. KV 密钥库
  try {
    const idx = await getKeyIndex()
    for (const kr of idx) {
      if (safeEqualStr(provided, kr.key)) return kr.name
    }
  } catch {
    /* 落到 fallback */
  }
  // 2. 环境变量 fallback（兼容已部署的 ASSETS_KEYS）
  const envKeys = parseKeys(env.ASSETS_KEYS)
  for (const [knownKey, service] of envKeys) {
    if (safeEqualStr(provided, knownKey)) return service
  }
  return null
}

// ============ 主入口 ============

export async function onRequest(context: EdgeContext): Promise<Response> {
  const req = context.request
  const env = context.env

  // CORS 预检（索引操作 + 下载都需要）
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-API-Key',
        'Access-Control-Allow-Origin': '*',
      },
    })
  }

  const pathSegs = (
    (Array.isArray(context.params.path) ? context.params.path : [context.params.path]).filter(
      Boolean,
    ) as string[]
  ).map((s) => decodeURIComponent(s))

  // 索引操作子路由：第一段为 index/check/check-hash/list
  const first = pathSegs[0] || ''
  if (first === 'index' || first === 'check' || first === 'check-hash' || first === 'list') {
    return handleIndexOp(req, env, first)
  }

  // 维护操作子路由：sweep / sweep-all / reconcile（JWT 鉴权，管理员操作）
  if (first === 'sweep' || first === 'sweep-all' || first === 'reconcile') {
    return handleMaintenance(req, env, first)
  }

  // 密钥管理子路由：keys / resolve-service（JWT 鉴权，node 内部调用）
  if (first === 'keys' || first === 'resolve-service') {
    return handleKeysOp(req, env, first, pathSegs.slice(1))
  }

  // 否则视为私有下载：/{service}/{key...}
  if (req.method === 'GET' && pathSegs.length >= 2) {
    return handleDownload(req, env, pathSegs)
  }

  return emptyRes(404)
}

// ============ 索引操作（JWT 鉴权）============

async function handleIndexOp(
  req: Request,
  env: Record<string, string | undefined>,
  op: string,
): Promise<Response> {
  // JWT 鉴权（node 路由自签的内部调用）
  const authHeader = req.headers.get('Authorization')
  if (!authHeader || !authHeader.startsWith('Bearer ')) return emptyRes(401)
  const secret = env.JWT_SECRET || env.UPLOAD_PASSWORD
  if (!secret) return emptyRes(500)
  const ok = await verifyJwt(authHeader.slice(7), secret)
  if (!ok) return emptyRes(401)

  const url = new URL(req.url)
  const service = (url.searchParams.get('service') || '').trim()
  const key = (url.searchParams.get('key') || '').trim()

  try {
    if (op === 'index' && req.method === 'POST') {
      // 子路由 POST /assets-api/index/rebuild?service= — 手动重建某 service 聚合索引
      // （从每条独立记录扫描真相源，覆盖式写回）。用于清理竞态残留 / 存量迁移。
      const subOp = url.searchParams.get('rebuild') === '1'
      if (subOp) {
        if (!service) return jsonRes({ code: 1, msg: '缺少 service' }, 400)
        // 重建单独 catch：暴露真实错误，便于运维定位（外层 catch 会吞成"索引操作失败"）
        try {
          const r = await rebuildAssetIndex(service, env)
          return jsonRes({ code: 0, msg: '聚合索引已重建', data: r })
        } catch (e) {
          return jsonRes({ code: 1, msg: '重建失败: ' + (e as Error).message }, 500)
        }
      }
      const rec = (await req.json()) as AssetRecord
      if (!rec.service || !rec.key || !rec.cnbPath) {
        return jsonRes({ code: 1, msg: '缺少 service/key/cnbPath' }, 400)
      }
      await putRecord(rec)
      // 懒删除：写完后顺手扫该 service 的过期记录（含 CNB 文件）
      await sweepExpired(rec.service, env).catch(() => {})
      return jsonRes({ code: 0, msg: 'ok', data: { service: rec.service, key: rec.key } })
    }

    if (op === 'index' && req.method === 'DELETE') {
      if (!service || !key) return jsonRes({ code: 1, msg: '缺少 service/key' }, 400)
      const removed = await removeRecord(service, key)
      return jsonRes({ code: 0, msg: removed ? 'ok' : 'not found', data: { removed } })
    }

    if (op === 'check') {
      if (!service || !key) return jsonRes({ code: 1, msg: '缺少 service/key' }, 400)
      const rec = await findRecord(service, key)
      return jsonRes({ code: 0, msg: 'ok', data: { exists: !!rec, record: rec || null } })
    }

    // 哈希查重：扫 asset_{service}_ 前缀，比对每条记录的 hash 字段。
    // 用于 Assets API 上前去重（同 service 内，命中则复用已有记录不重复传 CNB）。
    if (op === 'check-hash') {
      const hash = (url.searchParams.get('hash') || '').trim()
      if (!service || !hash) return jsonRes({ code: 1, msg: '缺少 service/hash' }, 400)
      // 从聚合索引快速查找（比翻页扫 asset_ keys 快）
      const items = await getIndex(service)
      const now = Date.now()
      const hit = items.find(
        (it) =>
          it.hash === hash &&
          it.status !== 'uploading' && // 跳过未完成的三阶段上传
          (!it.expiresAt || new Date(it.expiresAt).getTime() >= now), // 跳过已过期
      )
      return jsonRes({
        code: 0,
        msg: 'ok',
        data: { exists: !!hit, record: hit || null },
      })
    }

    if (op === 'list') {
      if (!service) return jsonRes({ code: 1, msg: '缺少 service' }, 400)
      // 懒删除：列举前先清理过期记录（含 CNB 文件，保持索引干净）
      await sweepExpired(service, env).catch(() => {})
      const prefix = url.searchParams.get('prefix') || ''
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10), 500)
      // 兜底自愈：随机 1/20 概率从真相源重建索引。
      // 版本号+重试挡不住最终一致窗口内的极端竞态，重建保证最终一致。
      // 低频中转场景下 ~5% 请求多花 ~1.5s，可接受。
      if (Math.floor(Math.random() * 20) === 0) {
        await rebuildAssetIndex(service, env).catch(() => {})
      }
      let items = await getIndex(service)
      // 双保险：再过滤一次已过期（防止 sweep 与 list 间的竞态）
      const now = Date.now()
      items = items.filter((it) => !it.expiresAt || new Date(it.expiresAt).getTime() >= now)
      if (prefix) items = items.filter((it) => it.key.startsWith(prefix))
      items = items.slice(0, limit)
      return jsonRes({ code: 0, msg: 'ok', data: { items, total: items.length } })
    }

    return emptyRes(404)
  } catch {
    return jsonRes({ code: 1, msg: '索引操作失败' }, 500)
  }
}

// ============ 维护操作（JWT 鉴权，管理员调用）============
//
// POST /assets-api/sweep?service=<name>   单 service 清理过期记录（= sweepExpired）
// POST /assets-api/sweep-all              扫所有 service 清理
// POST /assets-api/reconcile?mode=dry-run CNB 对账（只报告孤儿）
// POST /assets-api/reconcile?mode=delete  CNB 对账（删孤儿文件）

async function handleMaintenance(
  req: Request,
  env: Record<string, string | undefined>,
  op: string,
): Promise<Response> {
  // JWT 鉴权（同 handleIndexOp）
  const authHeader = req.headers.get('Authorization')
  if (!authHeader || !authHeader.startsWith('Bearer ')) return emptyRes(401)
  const secret = env.JWT_SECRET || env.UPLOAD_PASSWORD
  if (!secret) return emptyRes(500)
  const ok = await verifyJwt(authHeader.slice(7), secret)
  if (!ok) return emptyRes(401)

  const url = new URL(req.url)

  try {
    if (op === 'sweep') {
      const service = (url.searchParams.get('service') || '').trim()
      if (!service) return jsonRes({ code: 1, msg: '缺少 service' }, 400)
      const cleaned = await sweepExpired(service, env)
      return jsonRes({ code: 0, msg: 'ok', data: { service, cleaned } })
    }

    if (op === 'sweep-all') {
      const result = await sweepAllServices(env)
      return jsonRes({ code: 0, msg: 'ok', data: result })
    }

    if (op === 'reconcile') {
      const mode = url.searchParams.get('mode') === 'delete' ? 'delete' : 'dry-run'
      const result = await reconcileCnb(env, mode)
      return jsonRes({ code: 0, msg: mode === 'delete' ? '对账完成' : '对账完成（dry-run）', data: result })
    }

    return emptyRes(404)
  } catch (e) {
    return jsonRes({ code: 1, msg: '维护操作失败: ' + (e as Error).message }, 500)
  }
}

// ============ 私有下载（X-API-Key 鉴权 + 强隔离 + 流式转发）============

async function handleDownload(
  req: Request,
  env: Record<string, string | undefined>,
  pathSegs: string[],
): Promise<Response> {
  const service = await checkApiKey(req, env)
  if (!service) return emptyRes(401)

  const pathService = pathSegs[0]
  const keyPath = pathSegs.slice(1).join('/')
  // 强隔离：路径第一段必须等于 key 绑定的 service
  if (!safeEqualStr(pathService, service) || !keyPath) return emptyRes(403)

  let rec: AssetRecord | null
  try {
    rec = await findRecord(service, keyPath)
  } catch {
    return emptyRes(500)
  }
  if (!rec) return emptyRes(404)
  // TTL 懒删除：记录已过期 → 删 KV 记录 + CNB 文件 + 返回 404
  if (rec.expiresAt && new Date(rec.expiresAt).getTime() < Date.now()) {
    await removeRecord(service, keyPath).catch(() => {})
    if (rec.cnbPath) await deleteCnbFile(rec.cnbPath, env).catch(() => {})
    return emptyRes(404)
  }

  const slug = env.SLUG_IMG
  if (!slug) return emptyRes(500)

  // 推导 CNB 直链。cnbPath 形如 /slug/-/imgs|files/...，直接拼到 cnb.cool。
  // imgs 内联展示，files 视类型决定 inline/attachment。
  const isImgs = rec.cnbPath.includes('/-/imgs/')
  const target = `https://cnb.cool${rec.cnbPath}`

  try {
    const headers: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    }
    const range = req.headers.get('Range')
    if (range) headers['Range'] = range

    const upstream = await fetch(target, { headers })
    if (!upstream.ok || !upstream.body) return emptyRes(502)

    const respHeaders: Record<string, string> = {
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'private, max-age=60',
      'Content-Type': upstream.headers.get('Content-Type') || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
    }
    // 透传 Range 相关
    const ar = upstream.headers.get('Accept-Ranges')
    const cr = upstream.headers.get('Content-Range')
    const cl = upstream.headers.get('Content-Length')
    if (ar) respHeaders['Accept-Ranges'] = ar
    if (cr) respHeaders['Content-Range'] = cr
    if (cl) respHeaders['Content-Length'] = cl
    // files（非图片）默认附件下载，用记录里的 name
    if (!isImgs && rec.name) {
      const dn = encodeURIComponent(rec.name)
      respHeaders['Content-Disposition'] = `attachment; filename="${dn}"; filename*=UTF-8''${dn}`
    }

    return new Response(upstream.body, { status: upstream.status, headers: respHeaders })
  } catch {
    return emptyRes(502)
  }
}

// ============ 密钥管理（JWT 鉴权，node 路由调用）============
//
// GET    /assets-api/keys                列举所有密钥（node 脱敏后给前端）
// POST   /assets-api/keys                创建密钥 {name, note, key}（key 由 node 生成传入）
// DELETE /assets-api/keys?name=          删除密钥
// PUT    /assets-api/keys?name=          更新（轮换 key / 改 note）{key?, note?}
// POST   /assets-api/resolve-service     {key} → {service}（node 消费鉴权用）

async function handleKeysOp(
  req: Request,
  env: Record<string, string | undefined>,
  op: string,
  _subSegs: string[],
): Promise<Response> {
  // JWT 鉴权
  const authHeader = req.headers.get('Authorization')
  if (!authHeader || !authHeader.startsWith('Bearer ')) return emptyRes(401)
  const secret = env.JWT_SECRET || env.UPLOAD_PASSWORD
  if (!secret) return emptyRes(500)
  const ok = await verifyJwt(authHeader.slice(7), secret)
  if (!ok) return emptyRes(401)

  const url = new URL(req.url)

  try {
    // node 消费鉴权：传入 key，返回 service（或 null）
    if (op === 'resolve-service' && req.method === 'POST') {
      const body = (await req.json()) as { key?: string }
      if (!body.key) return jsonRes({ code: 1, msg: '缺少 key' }, 400)
      const service = await resolveService(body.key, env)
      return jsonRes({ code: 0, msg: 'ok', data: { service } })
    }

    if (op === 'keys' && req.method === 'GET') {
      const idx = await getKeyIndex()
      return jsonRes({ code: 0, msg: 'ok', data: { keys: idx } })
    }

    if (op === 'keys' && req.method === 'POST') {
      const body = (await req.json()) as KeyRecord
      if (!body.name || !body.key) return jsonRes({ code: 1, msg: '缺少 name/key' }, 400)
      // name 仅允许字母数字下划线横线（防 KV key 注入）
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(body.name)) {
        return jsonRes({ code: 1, msg: 'name 仅允许字母数字、下划线、横线（1-64 位）' }, 400)
      }
      if (await findKeyByName(body.name)) {
        return jsonRes({ code: 1, msg: 'name 已存在' }, 409)
      }
      const rec: KeyRecord = {
        name: body.name,
        key: body.key,
        note: body.note || '',
        createdAt: new Date().toISOString(),
      }
      await putKey(rec)
      return jsonRes({ code: 0, msg: 'ok', data: rec })
    }

    if (op === 'keys' && req.method === 'PUT') {
      const name = (url.searchParams.get('name') || '').trim()
      if (!name) return jsonRes({ code: 1, msg: '缺少 name' }, 400)
      const old = await findKeyByName(name)
      if (!old) return jsonRes({ code: 1, msg: '密钥不存在' }, 404)
      const body = (await req.json()) as { key?: string; note?: string }
      const updated: KeyRecord = {
        ...old,
        key: body.key || old.key,
        note: body.note !== undefined ? body.note : old.note,
      }
      await putKey(updated)
      return jsonRes({ code: 0, msg: 'ok', data: updated })
    }

    if (op === 'keys' && req.method === 'DELETE') {
      const name = (url.searchParams.get('name') || '').trim()
      if (!name) return jsonRes({ code: 1, msg: '缺少 name' }, 400)
      const removed = await removeKey(name)
      return jsonRes({ code: 0, msg: removed ? 'ok' : 'not found', data: { removed } })
    }

    return emptyRes(404)
  } catch {
    return jsonRes({ code: 1, msg: '密钥操作失败' }, 500)
  }
}
