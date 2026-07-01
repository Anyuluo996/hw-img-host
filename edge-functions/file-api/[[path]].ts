import { mimeForPath, shouldInline } from '../_mime'

interface EdgeContext {
  request: Request
  env: Record<string, string | undefined>
  params: { path?: string | string[] }
}

const CORS_HEADERS: Record<string, string> = { 'Access-Control-Allow-Origin': '*' }

// 任意文件类型的代理（区别于 img-api 的图片专用代理）。
// 目标：https://cnb.cool/<SLUG_IMG>/-/files/<path>
// CNB 的 files 端点会按文件内容返回正确的 Content-Type（如 application/pdf、video/mp4）。
// 透传 Range 请求，支持视频/音频拖动进度条；视频/音频/图片内联展示，其余强制下载。
export async function onRequest(context: EdgeContext) {
  const urlPath = context.params.path
  if (!urlPath) {
    return new Response(JSON.stringify({ error: 'No path provided' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    })
  }

  const pathStr = Array.isArray(urlPath) ? urlPath.join('/') : urlPath
  const targetUrl = `https://cnb.cool/${context.env.SLUG_IMG}/-/files/${pathStr}`

  try {
    // 收集要透传给 CNB 的请求头。
    // 关键：透传 Range 头，让 CNB 返回 206 分段内容（视频拖动进度条所需）。
    const upstreamHeaders: Record<string, string> = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome',
    }
    const range = context.request.headers.get('Range')
    if (range) {
      upstreamHeaders['Range'] = range
    }

    const response = await fetch(targetUrl, { headers: upstreamHeaders })

    // files 路径可能包含中文/空格的原始文件名，用 encodeURIComponent 生成 ASCII 文件名头
    const fileName = pathStr.split('/').pop() || 'file'
    const downloadName = encodeURIComponent(fileName)

    // 关键：CNB files 端点对非媒体文件统一返回 text/plain（实测 js/css/字体/pdf 全是），
    // 浏览器会因 MIME 不匹配拒绝执行 <script>/加载 @font-face。这里按扩展名修正。
    const upstreamCt = response.headers.get('Content-Type') ?? 'application/octet-stream'
    const fixedByExt = mimeForPath(fileName, '')
    // CNB 返回 text/plain 但扩展名能识别出更精确类型时，用扩展名的 MIME 覆盖
    const contentType = fixedByExt && /^text\/plain/i.test(upstreamCt) ? fixedByExt : upstreamCt

    // 安全：HTML/JS/SVG 等可执行内容强制 attachment（防存储型 XSS）。
    // 攻击场景：上传 .html → 发 /file-api 链接给受害者 → 站点 origin 内执行 JS。
    const FORCED_DOWNLOAD_TYPES = /^(text\/html|application\/javascript|image\/svg\+xml)/i
    const isInline = shouldInline(contentType) && !FORCED_DOWNLOAD_TYPES.test(contentType)
    const disposition = isInline
      ? 'inline'
      : `attachment; filename="${downloadName}"; filename*=UTF-8''${downloadName}`

    // 组装响应头：透传 Range 相关头（Accept-Ranges/Content-Range/Content-Length），
    // 让浏览器正确处理分段内容。
    // 安全：nosniff 防止浏览器嗅探覆盖 Content-Type（如把 text/plain 当 html 执行）。
    const respHeaders: Record<string, string> = {
      'Content-Type': contentType,
      'Content-Disposition': disposition,
      'Cache-Control': 'public, max-age=30',
      'X-Content-Type-Options': 'nosniff',
      ...CORS_HEADERS,
    }
    const acceptRanges = response.headers.get('Accept-Ranges')
    if (acceptRanges) respHeaders['Accept-Ranges'] = acceptRanges
    const contentRange = response.headers.get('Content-Range')
    if (contentRange) respHeaders['Content-Range'] = contentRange
    const contentLength = response.headers.get('Content-Length')
    if (contentLength) respHeaders['Content-Length'] = contentLength

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: respHeaders,
    })
  } catch {
    return new Response(JSON.stringify({ error: '代理失败' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    })
  }
}
