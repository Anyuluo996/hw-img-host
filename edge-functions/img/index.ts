interface KvStore {
  get(key: string, type?: 'text' | 'json' | 'arrayBuffer' | 'stream'): Promise<unknown>
  put(key: string, value: string | ArrayBuffer | ArrayBufferView | ReadableStream): Promise<void>
  delete(key: string): Promise<void>
  list(options?: {
    prefix?: string
    limit?: number
    cursor?: string
  }): Promise<{ complete: boolean; cursor: string; keys: Array<{ key?: string; name?: string }> }>
}

declare let img_kv: KvStore | undefined

const KEY_PREFIX = 'img_'

const IMAGE_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif', 'tiff',
])

type RecordItem = Record<string, unknown>

function getKV(): KvStore {
  if (typeof img_kv === 'undefined') {
    throw new Error('KV Storage 未配置')
  }
  return img_kv
}

// 从 list 返回里提取 key 名（字段名是 key 或 name，兼容两者）
function extractKeys(result: unknown): { names: string[]; complete: boolean; cursor?: string } {
  if (!result) return { names: [], complete: true }
  if (Array.isArray((result as { keys?: unknown }).keys)) {
    const r = result as { keys: unknown[]; complete?: boolean; cursor?: string }
    const names = r.keys.map((k) => {
      if (typeof k === 'string') return k
      const obj = k as { key?: string; name?: string }
      return obj.key || obj.name || ''
    })
    return { names: names.filter(Boolean), complete: r.complete !== false, cursor: r.cursor }
  }
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

function isImageName(name: string): boolean {
  const m = String(name).toLowerCase().match(/\.([a-z0-9]+)$/)
  return !!m && !!m[1] && IMAGE_EXTS.has(m[1])
}

// 列出所有记录（list 翻页 + 批量 get）
async function listItems(): Promise<RecordItem[]> {
  const kv = getKV()
  const allKeys: string[] = []
  let cursor: string | undefined
  let result: unknown
  let guard = 0
  do {
    if (guard++ > 50) break
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

  const items = await Promise.all(
    allKeys.map(async (k) => {
      try {
        return (await kv.get(k, 'json')) as RecordItem | null
      } catch {
        return null
      }
    }),
  )
  return items.filter((x): x is RecordItem => x !== null)
}

function jsonRes(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    },
  })
}

// 记录缓存：避免每次请求都全量 list 扫描（213 条扫描要 0.4~0.9s）。
// TTL 内复用，随机图场景下显著降低延迟。边缘函数实例级缓存（非全局）。
let _cache = { items: null as RecordItem[] | null, expireAt: 0 }
const CACHE_TTL = 60 * 1000 // 60 秒

// GET /img?tag=动漫        随机返回一张带「动漫」tag 的图片
// GET /img?tag=动漫,风景    tag 任一命中即可
// GET /img                 随机返回一张图片（全部）
// 免登录。直接返回图片字节（浏览器在 /img 端点显示图片，网址不变每次刷新换图）。
export async function onRequest(context: {
  request: Request
  params: { path?: string | string[] }
}) {
  if (context.request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
      },
    })
  }
  if (context.request.method !== 'GET') {
    return jsonRes({ code: 1, msg: '只支持 GET' }, 405)
  }

  try {
    const url = new URL(context.request.url)
    const tagParam = url.searchParams.get('tag')

    // 候选图片：优先用 tag 桶（1 次 get，冷启动也快），桶不存在才回退全量 list
    let candidates: Array<{ u: string; o: string }> | null = null
    const kv = getKV()

    if (tagParam) {
      // 多 tag（逗号分隔）：合并各桶
      const wantTags = tagParam.split(',').map((t) => t.trim()).filter(Boolean)
      const merged: Array<{ u: string; o: string }> = []
      const seen = new Set<string>()
      for (const t of wantTags) {
        let bucket: Array<{ u: string; o: string }> | null = null
        try {
          const r = (await kv.get('tag_' + t, 'json')) as Array<{ u: string; o: string }> | null
          if (Array.isArray(r)) bucket = r
        } catch {}
        if (bucket) {
          for (const e of bucket) {
            if (!seen.has(e.u)) { seen.add(e.u); merged.push(e) }
          }
        }
      }
      if (merged.length > 0) candidates = merged
    } else {
      // 无 tag：读「全部」桶
      try {
        const r = (await kv.get('tag__all', 'json')) as Array<{ u: string; o: string }> | null
        if (Array.isArray(r)) candidates = r
      } catch {}
    }

    // 回退：桶不存在（旧数据/未迁移）→ 全量 list + 过滤
    if (!candidates) {
      const items = await listItems()
      candidates = items
        .filter((it) => isImageName(String(it.name || '')) && (it.url || it.urlOriginal))
        .map((it) => ({ u: String(it.urlOriginal || it.url || ''), o: String(it.urlOriginal || it.url || '') }))
      if (tagParam) {
        const wantTags = tagParam.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean)
        candidates = candidates.filter((_, idx) => {
          const it = items[idx]
          const itemTags = (Array.isArray(it.tags) ? it.tags : []).map((t) => String(t).toLowerCase())
          return wantTags.some((w) => itemTags.includes(w))
        })
      }
    }

    if (candidates.length === 0) {
      return jsonRes({ code: 1, msg: '没有匹配的图片' }, 404)
    }

    // 随机选一张
    const pick = candidates[Math.floor(Math.random() * candidates.length)]
    // 优先用 CNB 原始直链（o），避免边缘函数回调自己的 /img-api 代理
    const target = pick.o || pick.u

    const imgResp = await fetch(target, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome',
      },
    })
    if (!imgResp.ok) {
      return jsonRes(
        { code: 1, msg: `获取图片失败: ${imgResp.status}`, target },
        502,
      )
    }
    const contentType = imgResp.headers.get('Content-Type') || 'image/jpeg'

    // 转发图片字节，禁止缓存（保证每次刷新都换图）
    return new Response(imgResp.body, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Access-Control-Allow-Origin': '*',
      },
    })
  } catch (e: unknown) {
    return jsonRes({ code: 1, msg: (e as Error).message || '随机图获取失败' }, 500)
  }
}
