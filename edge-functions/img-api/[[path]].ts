interface EdgeContext {
  env: Record<string, string | undefined>
  params: { path?: string | string[] }
}

const CORS_HEADERS: Record<string, string> = { 'Access-Control-Allow-Origin': '*' }

// 任意图片类型的代理（imgs 端点）。
// 目标：https://cnb.cool/<SLUG_IMG>/-/imgs/<path>
// 原样透传图片字节，不做格式转换/缩放/质量调整。
//
// 注：曾尝试用 @jsquash (WASM) 做服务端图像处理，但 EdgeOne 边缘函数
// 会剥离 query 参数（实测 ?format=webp 等到不了函数），无法接收处理指令。
// node-function 则不支持 sharp 原生模块。故当前仅原样透传。
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
        // 阻止 SVG 等图片内嵌脚本执行（M1：防存储型 XSS）
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
