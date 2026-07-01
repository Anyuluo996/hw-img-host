interface EdgeContext {
  request: Request
  env: Record<string, string | undefined>
  params: { path?: string | string[] }
}

// 大文件上传代理：浏览器 → 边缘函数 → CNB 直传
// 绕开 node-function 的请求体限制（实测约 5-6MB）。
// 边缘函数流式转发 request.body，不缓存到内存。
//
// 用法：浏览器 PUT https://your-domain.com/upload-proxy/assets/t/<token>
//      边缘函数把 body 流式转发到 https://asset.cnb.cool/assets/t/<token>
//
// CORS：从 BASE_IMG_URL 环境变量动态获取允许的 Origin，不硬编码域名。
export async function onRequest(context: EdgeContext) {
  const req = context.request
  // 允许的 Origin：从 BASE_IMG_URL 提取。
  // 未配置时不降级为 *（避免生产环境误配导致任意来源可上传），
  // 仅允许 localhost 开发环境。
  const baseUrl = (context.env.BASE_IMG_URL || '').replace(/\/$/, '')
  const allowedOrigin = baseUrl || 'http://localhost:8088'

  // CORS 预检
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': allowedOrigin,
        'Access-Control-Allow-Methods': 'PUT, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    })
  }

  if (req.method !== 'PUT') {
    return new Response(JSON.stringify({ code: 1, msg: '只支持 PUT' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': allowedOrigin },
    })
  }

  // 从路径提取 CNB 上传 token：/upload-proxy/assets/t/<token>
  const path = context.params.path
  const segs = Array.isArray(path) ? path : [path]
  const filtered = (segs.filter(Boolean) as string[])
  // 期望形如 ['assets','t','<token>']
  const subPath = filtered.join('/')
  if (!subPath.startsWith('assets/t/')) {
    return new Response(JSON.stringify({ code: 1, msg: '非法上传路径' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': allowedOrigin },
    })
  }

  const targetUrl = `https://asset.cnb.cool/${subPath}`

  try {
    // 流式转发 body，不经内存缓存（支持大文件）
    const resp = await fetch(targetUrl, {
      method: 'PUT',
      body: req.body, // ReadableStream 直接转发
      headers: { 'Content-Type': req.headers.get('Content-Type') || 'application/octet-stream' },
    })

    return new Response(resp.body, {
      status: resp.status,
      headers: {
        'Access-Control-Allow-Origin': allowedOrigin,
        'Content-Type': resp.headers.get('Content-Type') || 'application/json',
      },
    })
  } catch {
    return new Response(JSON.stringify({ code: 1, msg: '上传转发失败' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': allowedOrigin },
    })
  }
}
