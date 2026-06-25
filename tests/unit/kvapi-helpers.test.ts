import { describe, it, expect } from 'vitest'
import { extractKeys, pickOrigin, genId, base64UrlDecode, base64UrlToBytes } from '../../edge-functions/kv-api/_helpers'

describe('extractKeys (EdgeOne KV list 解析)', () => {
  it('解析 { keys: [{key}] } 形式（真实 EdgeOne 返回，字段是 key 不是 name）', () => {
    const r = extractKeys({
      complete: false,
      cursor: 'abc',
      keys: [{ key: 'img_1' }, { key: 'img_2' }],
    })
    expect(r.names).toEqual(['img_1', 'img_2'])
    expect(r.complete).toBe(false)
    expect(r.cursor).toBe('abc')
  })

  it('兼容字段名为 name 的旧格式', () => {
    const r = extractKeys({ keys: [{ name: 'img_1' }] })
    expect(r.names).toEqual(['img_1'])
  })

  it('key 直接是字符串数组', () => {
    const r = extractKeys({ keys: ['img_1', 'img_2'] })
    expect(r.names).toEqual(['img_1', 'img_2'])
  })

  it('顶层直接是数组', () => {
    const r = extractKeys(['img_1', 'img_2'])
    expect(r.names).toEqual(['img_1', 'img_2'])
    expect(r.complete).toBe(true)
  })

  it('complete 默认 true（缺省视为完成）', () => {
    expect(extractKeys({ keys: [{ key: 'x' }] }).complete).toBe(true)
  })

  it('空 key 被过滤', () => {
    const r = extractKeys({ keys: [{ key: '' }, { key: 'img_1' }, { key: undefined }] })
    expect(r.names).toEqual(['img_1'])
  })

  it('null/空输入返回空', () => {
    expect(extractKeys(null).names).toEqual([])
    expect(extractKeys(undefined).names).toEqual([])
  })

  it('无法识别的格式返回空', () => {
    expect(extractKeys({ foo: 'bar' }).names).toEqual([])
    expect(extractKeys(42).names).toEqual([])
  })
})

describe('pickOrigin (M3 CORS 白名单)', () => {
  const env = {}

  it('白名单内的 Origin 原样返回', () => {
    expect(pickOrigin('https://cdn.anyul.cn', env)).toBe('https://cdn.anyul.cn')
    expect(pickOrigin('http://localhost:5173', env)).toBe('http://localhost:5173')
  })

  it('白名单外的 Origin 返回 null（收紧，不放开）', () => {
    expect(pickOrigin('https://evil.com', env)).toBeNull()
    expect(pickOrigin('https://attacker.example.com', env)).toBeNull()
  })

  it('无 Origin 头返回 null', () => {
    expect(pickOrigin(null, env)).toBeNull()
    expect(pickOrigin('', env)).toBeNull()
  })

  it('KV_ALLOWED_ORIGINS 覆盖默认白名单', () => {
    const customEnv = { KV_ALLOWED_ORIGINS: 'https://my.site,https://other.site' }
    expect(pickOrigin('https://my.site', customEnv)).toBe('https://my.site')
    // 配置后默认白名单失效
    expect(pickOrigin('https://cdn.anyul.cn', customEnv)).toBeNull()
  })

  it('KV_ALLOWED_ORIGINS 含空格/空段时正确 trim', () => {
    const env2 = { KV_ALLOWED_ORIGINS: ' https://a.site , , https://b.site ' }
    expect(pickOrigin('https://a.site', env2)).toBe('https://a.site')
    expect(pickOrigin('https://b.site', env2)).toBe('https://b.site')
  })
})

describe('genId', () => {
  it('返回非空字符串', () => {
    const id = genId()
    expect(typeof id).toBe('string')
    expect(id.length).toBeGreaterThan(5)
  })

  it('两次调用大概率不同', () => {
    const ids = new Set(Array.from({ length: 20 }, () => genId()))
    expect(ids.size).toBe(20)
  })

  it('只含 base36 字符', () => {
    expect(genId()).toMatch(/^[0-9a-z]+$/)
  })
})

describe('base64Url 工具函数', () => {
  it('base64UrlDecode 解码标准 base64url', () => {
    // 'hello' → base64url = 'aGVsbG8'
    expect(base64UrlDecode('aGVsbG8')).toBe('hello')
  })

  it('base64UrlDecode 兼容 - 和 _（非 +/）', () => {
    // JSON: {"a":1} 的 base64url
    expect(base64UrlDecode('eyJhIjoxfQ')).toBe('{"a":1}')
  })

  it('base64UrlToBytes 返回正确字节', () => {
    const bytes = base64UrlToBytes('aGVsbG8') // 'hello'
    expect(Array.from(bytes)).toEqual([104, 101, 108, 108, 111])
  })

  it('无 padding 也能解码', () => {
    expect(base64UrlDecode('YQ')).toBe('a') // 'a' base64url 无 padding
  })
})
