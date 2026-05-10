async function requestUploadMeta(
  fileName: string,
  fileSize: number,
  type: string,
  signal?: AbortSignal,
) {
  const metaUrl = `https://api.cnb.cool/${process.env.SLUG_IMG}/-/upload/${type}`
  const resp = await fetch(metaUrl, {
    method: 'POST',
    signal,
    headers: {
      Authorization: `Bearer ${process.env.TOKEN_IMG}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: fileName, size: fileSize }),
  })

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    throw new Error(`获取上传元数据失败: ${resp.status} ${resp.statusText} ${errText}`)
  }

  return (await resp.json()) as { assets: Record<string, unknown>; upload_url: string }
}

async function uploadToCnb({
  fileBuffer,
  fileName,
  type = 'imgs',
}: {
  fileBuffer: Buffer
  fileName: string
  type?: string
}) {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 30000)

  try {
    const { assets, upload_url } = await requestUploadMeta(
      fileName,
      fileBuffer.length,
      type,
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

    return { assets, url: assets['path'] }
  } finally {
    clearTimeout(timeoutId)
  }
}

async function signUpload({
  fileName,
  fileSize,
  type = 'imgs',
}: {
  fileName: string
  fileSize: number
  type?: string
}) {
  return await requestUploadMeta(fileName, fileSize, type)
}

export { uploadToCnb, signUpload }
