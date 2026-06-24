// 上传类型：图片走 imgs（TOKEN_IMG），任意文件走 files（TOKEN_FILE，需 repo-notes:rw scope）
type UploadType = 'imgs' | 'files'

// 图片扩展名白名单。命中则走 imgs 端点（CNB 内容嗅探只接受真图片），
// 其余一律走 files 端点。
const IMAGE_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif', 'tiff',
])

function getExt(fileName: string): string {
  const m = String(fileName).toLowerCase().match(/\.([a-z0-9]+)$/)
  return m ? m[1] : ''
}

// 根据文件名判断上传类型：图片走 imgs，其余走 files
function detectUploadType(fileName: string): UploadType {
  return IMAGE_EXTS.has(getExt(fileName)) ? 'imgs' : 'files'
}

function getErrorDetail(err: unknown): string | undefined {
  const data = (err as { response?: { data?: unknown } }).response?.data
  if (typeof data === 'string') return data
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  return undefined
}

// 从 CNB assets.path 提取代理用的相对路径（去掉 slug 和 -/imgs|files 前缀）。
// imgs:  /slug/-/imgs/<ID>/<uuid>.png   -> <ID>/<uuid>.png
// files: /slug/-/files/<ID>/<uuid>/<原文件名> -> <ID>/<uuid>/<原文件名>
function extractImagePath(rawPath: string): string {
  const path = String(rawPath).split(/[?#]/)[0]
  const match = path.match(/-\/(?:imgs|files)\/(.+)/)
  return match ? match[1] : path
}

// 根据原始 path 判断类型，拼接对应的代理前缀：
// 图片用 img-api（旧，兼容），文件用 file-api
function buildAccessUrl(baseUrl: string, rawPath: string): string {
  const proxyPrefix = String(rawPath).includes('/-/imgs/') ? 'img-api' : 'file-api'
  return baseUrl + proxyPrefix + '/' + extractImagePath(rawPath)
}

// 兼容旧调用名（buildImageUrl 现已按类型自动路由，保留别名）
const buildImageUrl = buildAccessUrl

// 根据 type 选择对应的 CNB 访问 token
function tokenForType(type: UploadType): string | undefined {
  return type === 'files' ? process.env.TOKEN_FILE : process.env.TOKEN_IMG
}

async function requestUploadMeta(
  fileName: string,
  fileSize: number,
  type: UploadType,
  signal?: AbortSignal,
) {
  const token = tokenForType(type)
  if (!token) {
    const which = type === 'files' ? 'TOKEN_FILE' : 'TOKEN_IMG'
    throw new Error(`缺少环境变量 ${which}`)
  }
  const metaUrl = `https://api.cnb.cool/${process.env.SLUG_IMG}/-/upload/${type}`
  const resp = await fetch(metaUrl, {
    method: 'POST',
    signal,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: fileName, size: fileSize }),
  })

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    throw new Error(`获取上传元数据失败: ${resp.status} ${resp.statusText} ${errText}`)
  }

  const data = (await resp.json()) as { assets: Record<string, unknown>; upload_url: string }
  // 标注本次走的是哪种类型，便于调用方拼接代理路径
  ;(data.assets as Record<string, unknown>).__type = type
  return data
}

async function uploadToCnb({
  fileBuffer,
  fileName,
  type,
}: {
  fileBuffer: Buffer
  fileName: string
  type?: UploadType
}) {
  const uploadType = type ?? detectUploadType(fileName)
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 30000)

  try {
    const { assets, upload_url } = await requestUploadMeta(
      fileName,
      fileBuffer.length,
      uploadType,
      controller.signal,
    )

    const uploadResp = await fetch(upload_url, {
      method: 'PUT',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(fileBuffer),
    })

    if (!uploadResp.ok) {
      const errText = await uploadResp.text().catch(() => '')
      throw new Error(`上传到存储失败: ${uploadResp.status} ${uploadResp.statusText} ${errText}`)
    }

    return { assets, url: assets['path'], type: uploadType }
  } finally {
    clearTimeout(timeoutId)
  }
}

async function signUpload({
  fileName,
  fileSize,
  type,
}: {
  fileName: string
  fileSize: number
  type?: UploadType
}) {
  const uploadType = type ?? detectUploadType(fileName)
  const data = await requestUploadMeta(fileName, fileSize, uploadType)
  return { ...data, type: uploadType }
}

export {
  uploadToCnb,
  signUpload,
  getErrorDetail,
  extractImagePath,
  buildImageUrl,
  buildAccessUrl,
  detectUploadType,
}
export type { UploadType }
