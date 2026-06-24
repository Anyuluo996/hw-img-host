interface EdgeContext {
  env: Record<string, string | undefined>
  params: { path?: string | string[] }
}

const CORS_HEADERS: Record<string, string> = { 'Access-Control-Allow-Origin': '*' }

// 任意文件类型的代理（区别于 img-api 的图片专用代理）。
// 目标：https://cnb.cool/<SLUG_IMG>/-/files/<path>
// CNB 的 files 端点会按文件内容返回正确的 Content-Type（如 application/pdf、application/zip），
// 这里原样透传，并强制浏览器下载非内联展示型文件以免触发 XSS。
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
    const response = await fetch(targetUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome',
      },
    })

    // files 路径可能包含中文/空格的原始文件名，用 encodeURIComponent 生成 ASCII 文件名头
    const fileName = pathStr.split('/').pop() || 'file'
    const downloadName = encodeURIComponent(fileName)

    // 图片类仍允许内联展示；其余类型（zip/pdf/exe...）默认下载，避免浏览器执行
    const contentType = response.headers.get('Content-Type') ?? 'application/octet-stream'
    const isInline = /^image\//i.test(contentType)
    const disposition = isInline
      ? 'inline'
      : `attachment; filename="${downloadName}"; filename*=UTF-8''${downloadName}`

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': disposition,
        'Cache-Control': 'public, max-age=30',
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
