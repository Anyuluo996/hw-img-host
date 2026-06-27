import { mimeForPath } from '../_mime'

interface EdgeContext {
  request: Request
  env: Record<string, string | undefined>
  params: { path?: string | string[] }
}

const CORS_HEADERS: Record<string, string> = { 'Access-Control-Allow-Origin': '*' }

export async function onRequest(context: EdgeContext) {
  const urlPath = context.params.path

  // 临时验证：jsquash wasm 能否在边缘函数加载
  // 用真实图片路径 + query 参数 ?_jsquashtest=1 触发
  const reqUrl = new URL(context.request.url)
  if (reqUrl.searchParams.get('_jsquashtest') === '1') {
    const result: Record<string, unknown> = { WebAssembly: typeof WebAssembly !== 'undefined' }
    try {
      const { default: decodeJpeg } = await import('@jsquash/jpeg/decode.js')
      result.import_ok = true
      const resp = await fetch(
        'https://cnb.cool/anyuluo/imagescdn/-/imgs/U3V9LHH158HCMyxbKejujA/388755a3-e996-4f91-8a74-66c20345a590.jpg',
        { headers: { 'User-Agent': 'Mozilla/5.0' } },
      )
      const buf = new Uint8Array(await resp.arrayBuffer())
      result.orig_size = buf.byteLength
      const imgData = await decodeJpeg(buf)
      result.decode_ok = true
      result.decoded = `${imgData.width}x${imgData.height}`
    } catch (e) {
      result.error = (e as Error).message?.slice(0, 300)
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
