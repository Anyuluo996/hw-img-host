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

// GET /img?tag=动漫        随机返回一张带「动漫」tag 的图片
// GET /img?tag=动漫,风景    tag 任一命中即可
// GET /img                 随机返回一张图片（全部）
// 免登录。返回 302 重定向到图片代理 URL，网址不变每次刷新换图。
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
    const items = await listItems()

    // 只保留图片文件
    let images = items.filter((it) => isImageName(String(it.name || '')) && !!it.url)

    // 按 tag 过滤
    const url = new URL(context.request.url)
    const tagParam = url.searchParams.get('tag')
    if (tagParam) {
      const wantTags = tagParam
        .split(',')
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean)
      if (wantTags.length > 0) {
        images = images.filter((it) => {
          const itemTags = (Array.isArray(it.tags) ? it.tags : [])
            .map((t) => String(t).toLowerCase())
          return wantTags.some((w) => itemTags.includes(w))
        })
      }
    }

    if (images.length === 0) {
      return jsonRes({ code: 1, msg: '没有匹配的图片' }, 404)
    }

    // 随机选一张，直接流式获取图片字节返回（而非 302 重定向）。
    // 这样浏览器在 /img 端点直接显示图片，网址不变每次刷新换图。
    const pick = images[Math.floor(Math.random() * images.length)]
    const target = String(pick.url)

    const imgResp = await fetch(target)
    if (!imgResp.ok) {
      return jsonRes({ code: 1, msg: `获取图片失败: ${imgResp.status}` }, 502)
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
