// 扩展名 → MIME 类型映射。
// CNB 的 files 端点对非媒体文件统一返回 text/plain（实测 js/css/字体/json/xml/md/pdf 全是），
// 边缘代理必须根据扩展名修正，否则浏览器会因 MIME 不匹配拒绝执行/加载。
export const MIME_BY_EXT: Record<string, string> = {
  // 脚本/样式（网页可直接引用）
  js: 'application/javascript',
  mjs: 'application/javascript',
  cjs: 'application/javascript',
  css: 'text/css',

  // 字体（@font-face 可加载）
  woff2: 'font/woff2',
  woff: 'font/woff',
  ttf: 'font/ttf',
  otf: 'font/otf',
  eot: 'application/vnd.ms-fontobject',

  // 文档/数据
  json: 'application/json',
  xml: 'application/xml',
  html: 'text/html',
  htm: 'text/html',
  svg: 'image/svg+xml',
  md: 'text/markdown',
  csv: 'text/csv',

  // 文档（浏览器内嵌查看）
  pdf: 'application/pdf',
  txt: 'text/plain',

  // 压缩/二进制（强制下载）
  zip: 'application/zip',
  gz: 'application/gzip',
  rar: 'application/vnd.rar',
  '7z': 'application/x-7z-compressed',
  tar: 'application/x-tar',

  // Office（强制下载）
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',

  // 其他二进制
  exe: 'application/octet-stream',
  bin: 'application/octet-stream',
}

// 取文件扩展名（小写，不含点）
export function getExt(path: string): string {
  const m = String(path).toLowerCase().match(/\.([a-z0-9]+)$/)
  return m ? m[1] : ''
}

// 根据扩展名查 MIME，查不到返回 fallback
export function mimeForPath(path: string, fallback = 'application/octet-stream'): string {
  return MIME_BY_EXT[getExt(path)] || fallback
}

// 这些类型可在浏览器内联展示（不强制下载）：
// 图片/视频/音频（CNB 已正确识别）+ 脚本/样式/字体/文档（需 inline 才能被网页引用）
export function shouldInline(contentType: string): boolean {
  return /^(image|video|audio)\//i.test(contentType)
    || /^(text\/(css|html|markdown|plain)|application\/(javascript|json|xml|pdf)|font\/|application\/vnd\.ms-fontobject)/i.test(
      contentType,
    )
}
