// 最简验证：cloud-functions 运行时本身是否工作（不依赖任何包）
export function onRequest(context) {
  return Response.json({
    code: 0,
    msg: 'cloud-functions 运行时正常',
    runtime: 'cloud-functions',
    server: context.server,
    time: new Date().toISOString(),
  })
}
// trigger 1782521715
