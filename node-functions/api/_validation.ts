// 校验 CNB 资源路径必须指向本仓库的 imgs/files，禁止跨 repo 或注入任意路径（H3）。
// 纯函数，便于单元测试，不依赖任何运行时环境。
//
// 合法形如:
//   /<SLUG_IMG>/-/imgs/<ID>/<uuid>.png
//   /<SLUG_IMG>/-/files/<ID>/<uuid>/<原文件名>
export function isValidAssetPath(path: string, slug: string): boolean {
  if (!slug) return false
  // 去掉 query/fragment，避免 ?/../ 这类绕过
  const p = String(path).split(/[?#]/)[0]
  const prefixImgs = `/${slug}/-/imgs/`
  const prefixFiles = `/${slug}/-/files/`
  return p.startsWith(prefixImgs) || p.startsWith(prefixFiles)
}

// N2 文件名净化：去掉路径前缀（防 ../ 路径穿越）、控制字符、超长串。
// 仅保留 basename，避免把 fileName 当存储路径时写入非预期位置。
export function sanitizeFileName(name: string): string {
  // 只取最后一段 basename（兼容 / 和 \）
  const base = String(name).split(/[/\\]/).pop() || 'file'
  // 去掉控制字符（含空字符 \x00）
  return base.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200) || 'file'
}

// 上传单文件大小上限（字节），与 multer 限制保持一致
export const MAX_FILE_SIZE = 20 * 1024 * 1024

