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
