declare let img_kv: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get(key: string, type?: 'text' | 'json' | 'arrayBuffer' | 'stream'): Promise<any>
  put(key: string, value: string | ArrayBuffer | ArrayBufferView | ReadableStream): Promise<void>
  delete(key: string): Promise<void>
  list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<{
    complete: boolean
    cursor: string
    keys: Array<{ name: string }>
  }>
}

interface EdgeContext {
  request: Request
  params: Record<string, string | string[]>
  env: Record<string, string | undefined>
}

interface ImageRecord {
  key?: string
  url: string
  thumbnailUrl?: string
  urlOriginal?: string
  thumbnailOriginalUrl?: string
  name: string
  size: number
  type: string
  width: number
  height: number
  hasThumbnail: boolean
  thumbnailWidth: number
  thumbnailHeight: number
  thumbnailSize: number
  compressionRatio: number
  createdAt?: string
}

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

function reply(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  })
}

function replyError(status: number, msg: string) {
  return reply({ code: 1, msg }, status)
}

function getKV() {
  if (typeof img_kv === 'undefined') {
    throw new Error('KV Storage 未配置，请在 EdgeOne Pages 控制台启用并绑定 KV 命名空间')
  }
  return img_kv
}

function generateKey(): string {
  const ts = Date.now()
  const rand = Math.random().toString(36).substring(2, 6)
  return `img:${ts}_${rand}`
}

export async function onRequest(context: EdgeContext) {
  const { request } = context

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }

  try {
    const kv = getKV()

    switch (request.method) {
      case 'POST':
        return handlePost(kv, request)
      case 'GET':
        return handleGet(kv, request)
      case 'DELETE':
        return handleDelete(kv, request)
      default:
        return replyError(405, 'Method not allowed')
    }
  } catch (e: unknown) {
    const msg = (e as Error)?.message || String(e) || 'Internal error'
    return replyError(500, msg)
  }
}

async function handlePost(kv: typeof img_kv, request: Request): Promise<Response> {
  let body: ImageRecord
  try {
    body = (await request.json()) as ImageRecord
  } catch {
    return replyError(400, 'Invalid JSON body')
  }

  if (!body.url) {
    return replyError(400, 'url is required')
  }

  const key = generateKey()
  const record: ImageRecord & { key: string; createdAt: string } = {
    ...body,
    key,
    createdAt: new Date().toISOString(),
  }

  await kv.put(key, JSON.stringify(record))
  return reply({ code: 0, msg: 'ok', data: record })
}

async function handleGet(kv: typeof img_kv, request: Request): Promise<Response> {
  const url = new URL(request.url)
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '20', 10), 100)
  const cursor = url.searchParams.get('cursor') || undefined

  const result = await kv.list({ prefix: 'img:', limit, cursor })

  const records = await Promise.all(
    result.keys.map((k) => kv.get(k.name, 'json') as Promise<ImageRecord | null>),
  )

  return reply({
    code: 0,
    msg: 'ok',
    data: {
      images: records.filter(Boolean),
      cursor: result.cursor || '',
      complete: result.complete,
    },
  })
}

async function handleDelete(kv: typeof img_kv, request: Request): Promise<Response> {
  let body: { key: string }
  try {
    body = (await request.json()) as { key: string }
  } catch {
    return replyError(400, 'Invalid JSON body')
  }

  if (!body.key) {
    return replyError(400, 'key is required')
  }

  await kv.delete(body.key)
  return reply({ code: 0, msg: 'deleted' })
}
