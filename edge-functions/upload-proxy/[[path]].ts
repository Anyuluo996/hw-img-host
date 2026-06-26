interface EdgeContext {
  request: Request
  params: { path?: string | string[] }
}

const ALLOWED_ORIGIN = 'https://cdn.anyul.cn'

// 大文件上传代理：浏览器 → 边缘函数 → CNB 直传
// 绕开 node-function 的请求体限制（实测约 5-6MB）。
// 边缘函数流式转发 request.body，不缓存到内存。
//
// 用法：浏览器 PUT https://cdn.anyul.cn/upload-proxy/assets/t/<token>
//      边缘函数把 body 流式转发到 https://asset.cnb.cool/assets/t/<token>
export async function onRequest(context: EdgeContext) {
  const req = context.request

  // CORS 预检
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
        'Access-Control-Allow-Methods': 'PUT, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    })
  }

  if (req.method !== 'PUT') {
    return new Response(JSON.stringify({ code: 1, msg: '只支持 PUT' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': ALLOWED_ORIGIN },
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
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': ALLOWED_ORIGIN },
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
        'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
        'Content-Type': resp.headers.get('Content-Type') || 'application/json',
      },
    })
  } catch (e: unknown) {
    return new Response(JSON.stringify({ code: 1, msg: '上传转发失败' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': ALLOWED_ORIGIN },
    })
  }
}
