import { describe, it, expect } from 'vitest'
import { MIME_BY_EXT, getExt, mimeForPath, shouldInline } from '../../edge-functions/_mime'

describe('getExt', () => {
  it('提取扩展名（小写）', () => {
    expect(getExt('a.js')).toBe('js')
    expect(getExt('PHOTO.PNG')).toBe('png')
    expect(getExt('font.woff2')).toBe('woff2')
  })
  it('无扩展名返回空', () => {
    expect(getExt('noext')).toBe('')
    expect(getExt('')).toBe('')
  })
})

describe('mimeForPath', () => {
  it('脚本类返回正确 MIME', () => {
    expect(mimeForPath('app.js')).toBe('application/javascript')
    expect(mimeForPath('app.mjs')).toBe('application/javascript')
  })
  it('样式/字体返回正确 MIME', () => {
    expect(mimeForPath('style.css')).toBe('text/css')
    expect(mimeForPath('font.woff2')).toBe('font/woff2')
    expect(mimeForPath('font.ttf')).toBe('font/ttf')
  })
  it('数据/文档返回正确 MIME', () => {
    expect(mimeForPath('data.json')).toBe('application/json')
    expect(mimeForPath('doc.pdf')).toBe('application/pdf')
    expect(mimeForPath('vector.svg')).toBe('image/svg+xml')
  })
  it('未知扩展名用 fallback', () => {
    expect(mimeForPath('weird.xyz')).toBe('application/octet-stream')
    expect(mimeForPath('weird.xyz', 'text/plain')).toBe('text/plain')
  })
})

describe('shouldInline（内联展示判断）', () => {
  it('图片/视频/音频允许内联', () => {
    expect(shouldInline('image/png')).toBe(true)
    expect(shouldInline('video/mp4')).toBe(true)
    expect(shouldInline('audio/mpeg')).toBe(true)
  })
  it('脚本/样式/字体允许内联（网页可直接引用）', () => {
    expect(shouldInline('application/javascript')).toBe(true)
    expect(shouldInline('text/css')).toBe(true)
    expect(shouldInline('font/woff2')).toBe(true)
    expect(shouldInline('font/ttf')).toBe(true)
  })
  it('文档类允许内联（浏览器查看）', () => {
    expect(shouldInline('application/pdf')).toBe(true)
    expect(shouldInline('application/json')).toBe(true)
    expect(shouldInline('text/html')).toBe(true)
  })
  it('压缩包/可执行文件强制下载', () => {
    expect(shouldInline('application/zip')).toBe(false)
    expect(shouldInline('application/octet-stream')).toBe(false)
    expect(shouldInline('application/x-msdownload')).toBe(false)
  })
})

describe('MIME_BY_EXT 完整性', () => {
  it('所有映射值都是合法 MIME 格式', () => {
    for (const [ext, mime] of Object.entries(MIME_BY_EXT)) {
      expect(ext).toMatch(/^[a-z0-9]+$/)
      expect(mime).toMatch(/^[a-z.+-]+\/[a-z0-9.+-]+$/i)
    }
  })
})
