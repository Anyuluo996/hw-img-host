// 探索：EdgeOne 边缘函数是否原生支持图像处理（Web API）
// 测试 createImageBitmap / OffscreenCanvas / ImageData 是否可用
export async function onRequest() {
  const result: Record<string, boolean | string> = {}

  // 检查 Web API 可用性
  result.createImageBitmap = typeof createImageBitmap === 'function'
  result.OffscreenCanvas = typeof OffscreenCanvas !== 'undefined'
  result.ImageData = typeof ImageData !== 'undefined'
  result.createImageBitmap_2nd = typeof createImageBitmap !== 'undefined'

  // 如果 createImageBitmap 可用，尝试解码一张真实图片
  if (result.createImageBitmap) {
    try {
      const resp = await fetch(
        'https://cnb.cool/anyuluo/imagescdn/-/imgs/U3V9LHH158HCMyxbKejujA/388755a3-e996-4f91-8a74-66c20345a590.jpg',
        { headers: { 'User-Agent': 'Mozilla/5.0' } },
      )
      const blob = await resp.blob()
      const bitmap = await createImageBitmap(blob)
      result.decode_ok = true
      result.decoded_size = `${bitmap.width}x${bitmap.height}`
      bitmap.close?.()
    } catch (e) {
      result.decode_ok = false
      result.decode_error = (e as Error).message?.slice(0, 100)
    }
  }

  return new Response(JSON.stringify({ code: 0, data: result }, null, 2), {
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  })
}
