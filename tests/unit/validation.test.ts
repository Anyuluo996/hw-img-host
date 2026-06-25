import { describe, it, expect } from 'vitest'
import { isValidAssetPath } from '../../node-functions/api/_validation'

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
