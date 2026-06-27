// 关键验证：cloud-functions 运行时是否支持 sharp 原生模块
// 访问 /sharp-test 触发
import sharp from 'sharp'

export async function onRequest(context) {
  try {
    // 生成 100x100 红色测试图，验证 sharp 能否运行
    const png = await sharp({
      create: {
        width: 100,
        height: 100,
        channels: 4,
        background: { r: 255, g: 0, b: 0, alpha: 1 },
      },
    })
      .png()
      .toBuffer()

    return new Response(png, {
      headers: { 'Content-Type': 'image/png', 'Access-Control-Allow-Origin': '*' },
    })
  } catch (e) {
    return Response.json({
      code: 1,
      msg: `sharp 不可用: ${e.message}`,
      runtime: 'cloud-functions',
    }, { status: 500 })
  }
}
