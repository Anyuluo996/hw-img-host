// kv-api 边缘函数的纯辅助函数，独立出来便于单元测试。
// 不依赖运行时全局（img_kv / Request / Response），输入输出纯数据。

export interface ParsedKeys {
  names: string[]
  complete: boolean
  cursor?: string
}

// 从 kv.list() 的返回值里稳健地提取 key 列表。
// EdgeOne 实际返回 { complete, cursor, keys:[{key, expiration, meta}] }，
// 注意 key 对象的字段名是 `key`（不是文档说的 `name`）。这里兼容两者。
export function extractKeys(result: unknown): ParsedKeys {
  if (!result) return { names: [], complete: true }
  // 情况1: { keys: [...] }
  if (Array.isArray((result as { keys?: unknown }).keys)) {
    const r = result as { keys: unknown[]; complete?: boolean; cursor?: string }
    const names = r.keys.map((k) => {
      if (typeof k === 'string') return k
      const obj = k as { key?: string; name?: string }
      return obj.key || obj.name || ''
    })
    return {
      names: names.filter(Boolean),
      complete: r.complete !== false,
      cursor: r.cursor,
    }
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

// CORS 白名单匹配（M3 收紧）。origin 命中白名单则原样返回，否则 null。
// 默认白名单从 BASE_IMG_URL 动态生成，不硬编码域名。
export function pickOrigin(
  origin: string | null,
  env: { KV_ALLOWED_ORIGINS?: string; BASE_IMG_URL?: string },
  defaults?: string[],
): string | null {
  if (!origin) return null
  const configured = env.KV_ALLOWED_ORIGINS
  // 默认白名单：BASE_IMG_URL + localhost 开发环境
  const fallback = [
    ...(env.BASE_IMG_URL ? [env.BASE_IMG_URL.replace(/\/$/, '')] : []),
    'http://localhost:3210',
    'http://localhost:5173',
  ]
  const list = configured
    ? configured.split(',').map((s) => s.trim()).filter(Boolean)
    : (defaults || fallback)
  return list.includes(origin) ? origin : null
}

// base64url 解码为字符串
export function base64UrlDecode(str: string): string {
  let b64 = str.replace(/-/g, '+').replace(/_/g, '/')
  while (b64.length % 4) b64 += '='
  return atob(b64)
}

// base64url 解码为字节
export function base64UrlToBytes(str: string): Uint8Array {
  let b64 = str.replace(/-/g, '+').replace(/_/g, '/')
  while (b64.length % 4) b64 += '='
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

// 生成记录 ID
export function genId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}
