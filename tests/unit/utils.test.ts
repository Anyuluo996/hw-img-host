import { describe, it, expect } from 'vitest'
import {
  detectUploadType,
  extractImagePath,
  buildAccessUrl,
  computeSHA256,
} from '../../node-functions/api/_utils'

describe('detectUploadType (M1 文件类型判断)', () => {
  it('图片扩展名走 imgs', () => {
    for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif', 'tiff']) {
      expect(detectUploadType(`a.${ext}`)).toBe('imgs')
    }
  })

  it('大写扩展名也走 imgs', () => {
    expect(detectUploadType('PHOTO.PNG')).toBe('imgs')
    expect(detectUploadType('Photo.Jpg')).toBe('imgs')
  })

  it('非图片扩展名走 files', () => {
    expect(detectUploadType('doc.pdf')).toBe('files')
    expect(detectUploadType('archive.zip')).toBe('files')
    expect(detectUploadType('malware.exe')).toBe('files')
  })

  it('无扩展名走 files', () => {
    expect(detectUploadType('noext')).toBe('files')
  })

  it('伪装扩展名仍按名字判断（evil.exe.png → imgs，evil.png.exe → files）', () => {
    expect(detectUploadType('evil.exe.png')).toBe('imgs')
    expect(detectUploadType('evil.png.exe')).toBe('files')
  })
})

describe('extractImagePath (代理路径提取)', () => {
  it('imgs 路径去 slug 和 -/imgs/ 前缀', () => {
    expect(extractImagePath('/anyul/imgs/-/imgs/abc/uuid.png')).toBe('abc/uuid.png')
  })

  it('files 路径去 slug 和 -/files/ 前缀', () => {
    expect(extractImagePath('/anyul/imgs/-/files/abc/uuid/report.pdf')).toBe('abc/uuid/report.pdf')
  })

  it('去掉 query/fragment', () => {
    expect(extractImagePath('/anyul/imgs/-/imgs/abc/x.png?token=1')).toBe('abc/x.png')
    expect(extractImagePath('/anyul/imgs/-/imgs/abc/x.png#f')).toBe('abc/x.png')
  })

  it('无匹配前缀时原样返回（去掉 query）', () => {
    expect(extractImagePath('/something/else/x?z=1')).toBe('/something/else/x')
  })
})

describe('buildAccessUrl (代理 URL 拼接)', () => {
  it('imgs 路径用 img-api 前缀', () => {
    expect(buildAccessUrl('https://cdn.anyul.cn/', '/anyul/imgs/-/imgs/abc/uuid.png')).toBe(
      'https://cdn.anyul.cn/img-api/abc/uuid.png',
    )
  })

  it('files 路径用 file-api 前缀', () => {
    expect(buildAccessUrl('https://cdn.anyul.cn/', '/anyul/imgs/-/files/abc/uuid/r.pdf')).toBe(
      'https://cdn.anyul.cn/file-api/abc/uuid/r.pdf',
    )
  })

  it('baseUrl 结尾斜杠不影响结果', () => {
    expect(buildAccessUrl('https://cdn.anyul.cn', '/anyul/imgs/-/imgs/abc/x.png')).toBe(
      'https://cdn.anyul.cn/img-api/abc/x.png',
    )
  })
})

describe('computeSHA256', () => {
  it('与已知值一致（空 buffer）', () => {
    expect(computeSHA256(Buffer.alloc(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
  })

  it('与已知值一致（"abc"）', () => {
    expect(computeSHA256(Buffer.from('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  it('确定性：相同输入相同输出', () => {
    const a = computeSHA256(Buffer.from('hello world'))
    const b = computeSHA256(Buffer.from('hello world'))
    expect(a).toBe(b)
  })

  it('不同输入不同输出', () => {
    expect(computeSHA256(Buffer.from('a'))).not.toBe(computeSHA256(Buffer.from('b')))
  })
})
