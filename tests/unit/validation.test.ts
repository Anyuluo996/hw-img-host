import { describe, it, expect } from 'vitest'
import { isValidAssetPath, sanitizeFileName } from '../../node-functions/api/_validation'

describe('isValidAssetPath (H3 路径白名单)', () => {
  const slug = 'anyul/imgs'

  it('接受本仓库 imgs 路径', () => {
    expect(isValidAssetPath('/anyul/imgs/-/imgs/abc/uuid.png', slug)).toBe(true)
  })

  it('接受本仓库 files 路径', () => {
    expect(isValidAssetPath('/anyul/imgs/-/files/abc/uuid/report.pdf', slug)).toBe(true)
  })

  it('拒绝其他仓库的路径（跨 repo 越权）', () => {
    expect(isValidAssetPath('/victim/repo/-/imgs/abc/uuid.png', slug)).toBe(false)
  })

  it('拒绝完全无关路径', () => {
    expect(isValidAssetPath('/etc/passwd', slug)).toBe(false)
    expect(isValidAssetPath('https://evil.com/x', slug)).toBe(false)
    expect(isValidAssetPath('/anyul/imgs/imgs/x', slug)).toBe(false)
  })

  it('拒绝缺少 -/ 分隔的伪装路径', () => {
    expect(isValidAssetPath('/anyul/imgs/whatever/imgs/x', slug)).toBe(false)
  })

  it('query/fragment 不影响判断', () => {
    expect(isValidAssetPath('/anyul/imgs/-/imgs/abc/uuid.png?token=x', slug)).toBe(true)
    expect(isValidAssetPath('/anyul/imgs/-/imgs/abc/uuid.png#frag', slug)).toBe(true)
  })

  it('空 slug 视为未配置，全部拒绝', () => {
    expect(isValidAssetPath('/anyul/imgs/-/imgs/abc/uuid.png', '')).toBe(false)
  })
})

describe('sanitizeFileName (N2 文件名净化)', () => {
  it('正常文件名原样返回', () => {
    expect(sanitizeFileName('photo.png')).toBe('photo.png')
    expect(sanitizeFileName('文档.pdf')).toBe('文档.pdf')
  })

  it('去掉路径前缀（防 ../ 路径穿越）', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd')
    expect(sanitizeFileName('/etc/shadow')).toBe('shadow')
    expect(sanitizeFileName('a/b/c/x.jpg')).toBe('x.jpg')
  })

  it('兼容 Windows 反斜杠路径', () => {
    expect(sanitizeFileName('C:\\Users\\x\\evil.exe')).toBe('evil.exe')
  })

  it('去掉控制字符（含空字符）', () => {
    expect(sanitizeFileName('a\x00b.png')).toBe('ab.png')
    expect(sanitizeFileName('a\nb\r.png')).toBe('ab.png')
    expect(sanitizeFileName('a\x1fb.png')).toBe('ab.png')
  })

  it('超长文件名截断到 200 字符', () => {
    const long = 'a'.repeat(300) + '.png'
    const result = sanitizeFileName(long)
    expect(result.length).toBe(200)
  })

  it('空输入返回默认 file', () => {
    expect(sanitizeFileName('')).toBe('file')
    expect(sanitizeFileName('/')).toBe('file')
  })
})
