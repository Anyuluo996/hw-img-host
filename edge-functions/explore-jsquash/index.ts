// 最小验证：@jsquash 能否在 EdgeOne 边缘函数运行（加载 wasm）
// GET /explore-jsquash
export async function onRequest() {
  const result: Record<string, unknown> = {}

  // 1. WebAssembly 是否可用
  result.WebAssembly = typeof WebAssembly !== 'undefined'

  if (!result.WebAssembly) {
    return new Response(JSON.stringify({ code: 0, data: result }, null, 2), {
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // 2. 尝试 import @jsquash 并解码一张图
  try {
    const { default: decodeJpeg } = await import('@jsquash/jpeg/decode.js')
    result.import_ok = true

    const resp = await fetch(
      'https://cnb.cool/anyuluo/imagescdn/-/imgs/U3V9LHH158HCMyxbKejujA/388755a3-e996-4f91-8a74-66c20345a590.jpg',
      { headers: { 'User-Agent': 'Mozilla/5.0' } },
    )
    const buf = new Uint8Array(await resp.arrayBuffer())
    result.fetch_ok = true
    result.orig_size = buf.byteLength

    const imgData = await decodeJpeg(buf)
    result.decode_ok = true
    result.decoded = `${imgData.width}x${imgData.height}`
  } catch (e) {
    result.error = (e as Error).message?.slice(0, 200)
  }

  return new Response(JSON.stringify({ code: 0, data: result }, null, 2), {
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  })
}
