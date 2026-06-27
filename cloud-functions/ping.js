// 最简验证：cloud-functions 运行时本身是否工作
export function onRequestGet() {
  return new Response('pong', {
    headers: { 'Content-Type': 'text/plain' },
  })
}
