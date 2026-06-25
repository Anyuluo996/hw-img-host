import { describe, it, expect } from 'vitest'
import { isAllowedImageHost, sanitizeFileName } from '../../edge-functions/_security'

const ALLOWED = ['cnb.cool', 'cnb-img.cool']

describe('isAllowedImageHost (N1 SSRF 防护)', () => {
  it('允许 CNB 主域名', () => {
    expect(isAllowedImageHost('https://cnb.cool/x/y.png', ALLOWED)).toBe(true)
    expect(isAllowedImageHost('http://cnb-img.cool/a/b.jpg', ALLOWED)).toBe(true)
  })

  it('允许 CNB 子域名', () => {
    expect(isAllowedImageHost('https://assets.cnb.cool/x.png', ALLOWED)).toBe(true)
    expect(isAllowedImageHost('https://img.cnb-img.cool/x.png', ALLOWED)).toBe(true)
  })

  it('拒绝内网地址（核心 SSRF 防护）', () => {
    expect(isAllowedImageHost('http://127.0.0.1/admin', ALLOWED)).toBe(false)
    expect(isAllowedImageHost('http://192.168.1.1/', ALLOWED)).toBe(false)
    expect(isAllowedImageHost('http://10.0.0.1/', ALLOWED)).toBe(false)
    expect(isAllowedImageHost('http://169.254.169.254/latest/meta-data/', ALLOWED)).toBe(false)
  })

  it('拒绝其他公网域名', () => {
    expect(isAllowedImageHost('https://evil.com/x.png', ALLOWED)).toBe(false)
    expect(isAllowedImageHost('https://attacker.example.com/x.png', ALLOWED)).toBe(false)
  })

  it('拒绝伪造相似域名（防 cnb.cool.evil.com 绕过）', () => {
    expect(isAllowedImageHost('https://cnb.cool.evil.com/x.png', ALLOWED)).toBe(false)
    expect(isAllowedImageHost('https://evil-cnb.cool/x.png', ALLOWED)).toBe(false)
    expect(isAllowedImageHost('https://xcnb.cool/x.png', ALLOWED)).toBe(false)
  })

  it('拒绝非 http(s) 协议（防 file:// data: 等）', () => {
    expect(isAllowedImageHost('file:///etc/passwd', ALLOWED)).toBe(false)
    expect(isAllowedImageHost('data:text/html,<script>', ALLOWED)).toBe(false)
    expect(isAllowedImageHost('javascript:alert(1)', ALLOWED)).toBe(false)
  })

  it('畸形 URL 返回 false', () => {
    expect(isAllowedImageHost('', ALLOWED)).toBe(false)
    expect(isAllowedImageHost('not-a-url', ALLOWED)).toBe(false)
    expect(isAllowedImageHost('://no-host', ALLOWED)).toBe(false)
  })
})

describe('sanitizeFileName (edge 端 N2)', () => {
  it('正常文件名原样返回', () => {
    expect(sanitizeFileName('photo.png')).toBe('photo.png')
  })

  it('去掉路径前缀防穿越', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd')
  })

  it('去掉控制字符', () => {
    expect(sanitizeFileName('a\x00b.png')).toBe('ab.png')
  })

  it('截断超长名', () => {
    expect(sanitizeFileName('a'.repeat(300)).length).toBe(200)
  })
})
