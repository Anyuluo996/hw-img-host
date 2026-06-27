import { mimeForPath } from '../_mime'

interface EdgeContext {
  request: Request
  env: Record<string, string | undefined>
  params: { path?: string | string[] }
}

const CORS_HEADERS: Record<string, string> = { 'Access-Control-Allow-Origin': '*' }

export async function onRequest(context: EdgeContext) {
  const urlPath = context.params.path

  // 临时验证：检查 context.request.url 是否含 query（用 header 返回诊断，不破坏图片输出）
  const reqUrl = new URL(context.request.url)
  const queryPresent = reqUrl.search
  if (queryPresent) {
    const result = {
      has_query: true,
      query: queryPresent,
      url: reqUrl.pathname,
      WebAssembly: typeof WebAssembly !== 'undefined',
    }
    return new Response(JSON.stringify({ code: 0, data: result }, null, 2), {
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    })
  }
  if (!urlPath) {
    return new Response(JSON.stringify({ error: 'No path provided' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    })
  }

  const pathStr = Array.isArray(urlPath) ? urlPath.join('/') : urlPath
  const targetUrl = `https://cnb.cool/${context.env.SLUG_IMG}/-/imgs/${pathStr}`

  try {
    const response = await fetch(targetUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome',
      },
    })

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: {
        'Content-Type': response.headers.get('Content-Type') ?? 'image/png',
        'Cache-Control': 'public, max-age=30',
        // 阻止 SVG 等图片内嵌脚本执行（M1：防存储型 XSS）。SVG 可内嵌 <script>，
        // 透传 image/svg+xml 后浏览器会渲染执行。CSP 禁止脚本 + 禁止外部资源加载。
        'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
        'X-Content-Type-Options': 'nosniff',
        ...CORS_HEADERS,
      },
    })
  } catch (e: unknown) {
    return new Response(JSON.stringify({ error: (e as Error)?.message || String(e) }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    })
  }
}
// force redeploy 1782518721
