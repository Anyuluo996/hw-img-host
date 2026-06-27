interface EdgeContext {
  request: Request
  env: Record<string, string | undefined>
  params: { path?: string | string[] }
}

const CORS_HEADERS: Record<string, string> = { 'Access-Control-Allow-Origin': '*' }

// 任意图片类型的代理（imgs 端点）。
// 目标：https://cnb.cool/<SLUG_IMG>/-/imgs/<path>
// 透传图片字节 + Range 请求（大图分段加载），不做格式转换/缩放/质量调整。
export async function onRequest(context: EdgeContext) {
  const urlPath = context.params.path
  if (!urlPath) {
    return new Response(JSON.stringify({ error: 'No path provided' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    })
  }

  const pathStr = Array.isArray(urlPath) ? urlPath.join('/') : urlPath
  const targetUrl = `https://cnb.cool/${context.env.SLUG_IMG}/-/imgs/${pathStr}`

  try {
    // 收集要透传给 CNB 的请求头。透传 Range，支持大图分段加载。
    const upstreamHeaders: Record<string, string> = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome',
    }
    const range = context.request.headers.get('Range')
    if (range) upstreamHeaders['Range'] = range

    const response = await fetch(targetUrl, { headers: upstreamHeaders })

    // 组装响应头：透传 Range 相关头
    const respHeaders: Record<string, string> = {
      'Content-Type': response.headers.get('Content-Type') ?? 'image/png',
      'Cache-Control': 'public, max-age=30',
      // 阻止 SVG 等图片内嵌脚本执行（M1：防存储型 XSS）
      'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
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
  } catch (e: unknown) {
    return new Response(JSON.stringify({ error: (e as Error)?.message || String(e) }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    })
  }
}
