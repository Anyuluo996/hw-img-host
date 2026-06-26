// 本地验证 @jsquash 解码→缩放→编码流程
import decodeJpeg from '@jsquash/jpeg/decode.js'
import encodeJpeg from '@jsquash/jpeg/encode.js'
import encodeWebp from '@jsquash/webp/encode.js'
import encodePng from '@jsquash/png/encode.js'

const IMG_URL = 'https://cnb.cool/anyuluo/imagescdn/-/imgs/U3V9LHH158HCMyxbKejujA/388755a3-e996-4f91-8a74-66c20345a590.jpg'

async function time(label, fn) {
  const t = Date.now()
  const r = await fn()
  console.log(`${label}: ${Date.now() - t}ms`)
  return r
}

console.log('=== @jsquash 本地验证 ===\n')

// 1. fetch 原图
const t0 = Date.now()
const resp = await fetch(IMG_URL, { headers: { 'User-Agent': 'Mozilla/5.0' } })
const origBuf = new Uint8Array(await resp.arrayBuffer())
console.log(`1. fetch 原图: ${Date.now() - t0}ms, ${origBuf.length} bytes`)

// 2. 解码 jpeg → ImageData
const imgData = await time('2. 解码 jpeg→ImageData', () => decodeJpeg(origBuf))
console.log(`   尺寸: ${imgData.width}x${imgData.height}`)

// 3. 缩放（纯 JS 最近邻，简单实现）
function resize(imgData, newW, newH) {
  const { width, height, data } = imgData
  const out = new Uint8ClampedArray(newW * newH * 4)
  const xRatio = width / newW
  const yRatio = height / newH
  for (let y = 0; y < newH; y++) {
    for (let x = 0; x < newW; x++) {
      const sx = Math.floor(x * xRatio)
      const sy = Math.floor(y * yRatio)
      const si = (sy * width + sx) * 4
      const di = (y * newW + x) * 4
      out[di] = data[si]
      out[di + 1] = data[si + 1]
      out[di + 2] = data[si + 2]
      out[di + 3] = data[si + 3]
    }
  }
  return { width: newW, height: newH, data: out, colorSpace: imgData.colorSpace }
}

const small = await time('3. 缩放 300x560', () => resize(imgData, 300, 560))

// 4. 编码 webp q=80
const webp = await time('4. 编码 webp q=80', () => encodeWebp(small, { quality: 80 }))
console.log(`   webp: ${webp.byteLength} bytes`)

// 5. 编码 jpeg q=80
const jpeg = await time('5. 编码 jpeg q=80', () => encodeJpeg(small, { quality: 80 }))
console.log(`   jpeg: ${jpeg.byteLength} bytes`)

// 6. 编码 png
const png = await time('6. 编码 png', () => encodePng(small))
console.log(`   png: ${png.byteLength} bytes`)

console.log('\n=== 结论 ===')
console.log('@jsquash 解码/编码流程本地通过，输出都是 Uint8Array')
console.log('注意：边缘函数里 import 路径可能不同，需实测 WASM 是否加载')
