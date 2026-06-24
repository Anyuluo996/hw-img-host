<template>
  <div class="mx-auto w-full rounded-xl border border-border/50 bg-card p-6">
    <label
      class="mb-4 flex w-full cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed p-8 text-center text-sm transition-colors"
      :class="[
        isDragging
          ? 'border-foreground/30 bg-foreground/3 text-foreground/70'
          : 'border-border text-muted-foreground hover:border-foreground/20 hover:bg-foreground/2',
      ]"
      @dragover.prevent="isDragging = true"
      @dragleave.prevent="isDragging = false"
      @drop.prevent="onDrop"
    >
      <input type="file" @change="onFileChange" class="hidden" />
      <span v-if="!file">
        {{ isDragging ? '释放文件上传' : '点击或拖拽上传文件' }}
      </span>
      <div v-else-if="processing" class="flex items-center gap-2 text-muted-foreground">
        <LoaderIcon class="h-5 w-5 animate-spin" />
        <span>文件处理中...</span>
      </div>
      <div v-else class="flex w-full items-center justify-center text-foreground/80">
        <span class="max-w-[90%] truncate text-sm" :title="file?.name">
          {{ file?.name }}
        </span>
        <XCircle
          class="ml-2 h-4 w-4 cursor-pointer text-muted-foreground/40 transition hover:text-destructive"
          @click.stop="handleFile(null)"
        />
      </div>
    </label>

    <div v-if="file" class="mb-3 rounded-lg border border-border/50 px-3.5 py-3">
      <p class="mb-2 text-xs text-muted-foreground">{{ isImage ? '原图信息' : '文件信息' }}</p>
      <div class="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-muted-foreground">
        <p>
          大小
          <span class="ml-1 text-foreground/70">{{ (file.size / 1024).toFixed(2) }} KB</span>
        </p>
        <p>
          格式
          <span class="ml-1 text-foreground/70">{{ file.type || '未知' }}</span>
        </p>
        <p v-if="isImage">
          压缩率
          <span class="ml-1 text-foreground/70">{{ compressionRatio.toFixed(2) }}%</span>
        </p>
        <p v-if="isImage">
          尺寸
          <span class="ml-1 text-foreground/70">{{ imageWidth }}x{{ imageHeight }}</span>
        </p>
        <p v-else>
          类型
          <span class="ml-1 text-foreground/70">任意文件</span>
        </p>
      </div>
    </div>

    <div
      v-if="file && generateThumbnail && thumbnailPreview"
      class="mb-3 rounded-lg border border-border/50 px-3.5 py-3"
    >
      <p class="mb-2 text-xs text-muted-foreground">缩略图预览</p>
      <div class="flex items-center gap-3">
        <img
          :src="thumbnailPreview"
          alt="缩略图"
          class="h-16 w-16 rounded-md border border-border/30 object-cover"
        />
        <div class="flex gap-5 text-xs text-muted-foreground">
          <p>
            尺寸
            <span class="ml-1 text-foreground/70">{{ thumbnailWidth }}x{{ thumbnailHeight }}</span>
          </p>
          <p>
            大小
            <span class="ml-1 text-foreground/70">{{ (thumbnailSize / 1024).toFixed(2) }} KB</span>
          </p>
        </div>
      </div>
    </div>

    <Button class="w-full" :disabled="!file || uploading" @click="uploadFile">
      {{ uploading ? '上传中...' : '开始上传' }}
    </Button>

    <div v-if="uploading" class="mt-4">
      <Progress :model-value="uploadProgress" class="h-1.5" />
      <p class="mt-2 text-center text-xs text-muted-foreground">{{ uploadProgress }}%</p>
    </div>

    <p v-if="errorMsg" class="mt-4 text-center text-xs text-destructive">
      {{ errorMsg }}
    </p>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onUnmounted } from 'vue'
import axios, { type AxiosProgressEvent } from 'axios'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { toast } from 'vue-sonner'
import { XCircle, LoaderIcon } from 'lucide-vue-next'

interface Props {
  maxWidth?: number
  maxHeight?: number
  quality?: number
  generateThumbnail?: boolean
  thumbnailMaxWidth?: number
  thumbnailMaxHeight?: number
  thumbnailQuality?: number
}

interface UploadInfo {
  url: string
  urlOriginal?: string
  thumbnailUrl?: string
  thumbnailOriginalUrl?: string
  name: string
  size: number
  type: string
  compressionRatio: number
  width: number
  height: number
  hasThumbnail: boolean
  thumbnailWidth: number
  thumbnailHeight: number
  thumbnailSize: number
}

interface CompressResult {
  compressedFile: File
  width: number
  height: number
}

interface ThumbnailResult {
  thumbnailFile: File
  previewUrl: string
  width: number
  height: number
  size: number
}

interface SignResponse {
  code: number
  msg?: string
  data: {
    assets: { path: string }
    upload_url: string
    type?: 'imgs' | 'files'
    proxy_path?: string // 后端已拼好前缀的代理路径，如 /img-api/xxx 或 /file-api/xxx
  }
}

// 图片扩展名白名单，与后端 _utils.detectUploadType 保持一致
const IMAGE_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif', 'tiff',
])
function isImageFile(name: string): boolean {
  const m = String(name).toLowerCase().match(/\.([a-z0-9]+)$/)
  return !!m && !!m[1] && IMAGE_EXTS.has(m[1])
}

const props = withDefaults(defineProps<Props>(), {
  maxWidth: 0,
  maxHeight: 0,
  quality: 0.7,
  generateThumbnail: false,
  thumbnailMaxWidth: 200,
  thumbnailMaxHeight: 200,
  thumbnailQuality: 0.9,
})

const emit = defineEmits<{
  'update:uploadInfo': [uploadInfo: UploadInfo]
}>()

const file = ref<File | null>(null)
const originalFile = ref<File | null>(null)
const thumbnailFile = ref<File | null>(null)
const thumbnailPreview = ref<string>('')
const thumbnailWidth = ref<number>(0)
const thumbnailHeight = ref<number>(0)
const thumbnailSize = ref<number>(0)
const uploadProgress = ref<number>(0)
const uploading = ref<boolean>(false)
const processing = ref<boolean>(false)
const uploadedUrl = ref<string>('')
const uploadedThumbnailUrl = ref<string>('')
const errorMsg = ref<string>('')
const isDragging = ref<boolean>(false)
const compressionRatio = ref<number>(0)
const imageWidth = ref<number>(0)
const imageHeight = ref<number>(0)
const isImage = ref<boolean>(true)

let qualityDebounceTimer: ReturnType<typeof setTimeout> | null = null
watch(
  () => props.quality,
  () => {
    if (qualityDebounceTimer) clearTimeout(qualityDebounceTimer)
    qualityDebounceTimer = setTimeout(() => {
      if (originalFile.value && !processing.value && !uploading.value) {
        handleFile(originalFile.value)
      }
    }, 300)
  },
)

watch(
  () => props.generateThumbnail,
  (newVal) => {
    if (!newVal) {
      thumbnailFile.value = null
      thumbnailPreview.value = ''
      thumbnailWidth.value = 0
      thumbnailHeight.value = 0
      thumbnailSize.value = 0
    } else if (file.value && !processing.value) {
      generateThumbnailImage(file.value).then((t) => {
        thumbnailFile.value = t.thumbnailFile
        thumbnailPreview.value = t.previewUrl
        thumbnailWidth.value = t.width
        thumbnailHeight.value = t.height
        thumbnailSize.value = t.size
      })
    }
  },
)

onUnmounted(() => {
  if (qualityDebounceTimer) clearTimeout(qualityDebounceTimer)
})

async function compressImageToWebp(
  file: File,
  quality: number = 0.7,
  maxWidth: number = 0,
  maxHeight: number = 0,
): Promise<CompressResult> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.readAsDataURL(file)
    reader.onload = (e: ProgressEvent<FileReader>) => {
      const img = new Image()
      img.src = e.target?.result as string
      img.onload = async () => {
        let width = img.width
        let height = img.height

        if (maxWidth > 0 || maxHeight > 0) {
          if (maxWidth > 0 && maxHeight > 0) {
            const ratio = Math.min(maxWidth / width, maxHeight / height)
            if (ratio < 1) {
              width = Math.round(width * ratio)
              height = Math.round(height * ratio)
            }
          } else if (maxWidth > 0 && width > maxWidth) {
            const ratio = maxWidth / width
            width = maxWidth
            height = Math.round(height * ratio)
          } else if (maxHeight > 0 && height > maxHeight) {
            const ratio = maxHeight / height
            height = maxHeight
            width = Math.round(width * ratio)
          }
        }

        const canvas = document.createElement('canvas')
        const ctx = canvas.getContext('2d')

        if (!ctx) {
          reject(new Error('无法获取 canvas context'))
          return
        }

        canvas.width = width
        canvas.height = height
        ctx.drawImage(img, 0, 0, width, height)

        const pixelCount = width * height
        let effectiveQuality = quality
        if (pixelCount > 4_000_000) {
          effectiveQuality = Math.min(quality, 0.6)
        } else if (pixelCount > 2_000_000) {
          effectiveQuality = Math.min(quality, 0.65)
        }

        canvas.toBlob(
          (blob) => {
            if (!blob) {
              reject(new Error('WebP 转换失败'))
              return
            }
            if (blob.size > 3 * 1024 * 1024 && effectiveQuality > 0.3) {
              canvas.toBlob(
                (retryBlob) => {
                  if (!retryBlob) {
                    reject(new Error('WebP 转换失败'))
                    return
                  }
                  const compressedFile = new File(
                    [retryBlob],
                    file.name.replace(/\.\w+$/, '.webp'),
                    { type: 'image/webp' },
                  )
                  resolve({ compressedFile, width, height })
                },
                'image/webp',
                0.3,
              )
              return
            }
            const compressedFile = new File([blob], file.name.replace(/\.\w+$/, '.webp'), {
              type: 'image/webp',
            })
            resolve({ compressedFile, width, height })
          },
          'image/webp',
          effectiveQuality,
        )
      }
      img.onerror = () => reject(new Error('图片加载失败'))
    }
    reader.onerror = () => reject(new Error('文件读取失败'))
  })
}
async function generateThumbnailImage(file: File): Promise<ThumbnailResult> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.readAsDataURL(file)
    reader.onload = (e: ProgressEvent<FileReader>) => {
      const img = new Image()
      img.src = e.target?.result as string
      img.onload = () => {
        const canvas = document.createElement('canvas')
        const ctx = canvas.getContext('2d')

        if (!ctx) {
          reject(new Error('无法获取 canvas context'))
          return
        }

        let width = img.width
        let height = img.height
        const maxWidth = props.thumbnailMaxWidth
        const maxHeight = props.thumbnailMaxHeight

        if (width > maxWidth || height > maxHeight) {
          const ratio = Math.min(maxWidth / width, maxHeight / height)
          width = Math.round(width * ratio)
          height = Math.round(height * ratio)
        }

        canvas.width = width
        canvas.height = height
        ctx.drawImage(img, 0, 0, width, height)

        canvas.toBlob(
          (blob) => {
            if (blob) {
              const thumbnailFile = new File([blob], file.name.replace(/\.\w+$/, '_thumb.webp'), {
                type: 'image/webp',
              })
              const previewUrl = URL.createObjectURL(blob)
              resolve({
                thumbnailFile,
                previewUrl,
                width,
                height,
                size: blob.size,
              })
            } else {
              reject(new Error('缩略图生成失败'))
            }
          },
          'image/webp',
          props.thumbnailQuality,
        )
      }
      img.onerror = () => reject(new Error('图片加载失败'))
    }
    reader.onerror = () => reject(new Error('文件读取失败'))
  })
}

function extractImagePath(url: string): string {
  if (url.includes('-/imgs/')) {
    return url.split('-/imgs/')[1] || url
  } else if (url.includes('-/files/')) {
    return url.split('-/files/')[1] || url
  }
  return url
}

function onFileChange(e: Event): void {
  const target = e.target as HTMLInputElement
  const f = target.files?.[0]
  if (f) {
    handleFile(f)
  }
}

function onDrop(e: DragEvent): void {
  isDragging.value = false
  const f = e.dataTransfer?.files?.[0]
  if (f) {
    handleFile(f)
  }
}

async function handleFile(f: File | null): Promise<void> {
  if (!f) {
    file.value = null
    originalFile.value = null
    thumbnailFile.value = null
    thumbnailPreview.value = ''
    return
  }

  processing.value = true

  try {
    if (f.size > 20 * 1024 * 1024) {
      errorMsg.value = '文件大小不能超过 20MB'
      return
    }
    originalFile.value = f
    isImage.value = isImageFile(f.name)

    if (isImage.value) {
      // 图片：走原有的 canvas 压缩 + 缩略图流程
      const { compressedFile, width, height } = await compressImageToWebp(
        f,
        props.quality,
        props.maxWidth,
        props.maxHeight,
      )
      compressionRatio.value = ((f.size - compressedFile.size) / f.size) * 100
      file.value = compressedFile
      imageWidth.value = width
      imageHeight.value = height

      if (props.generateThumbnail) {
        const thumbnail = await generateThumbnailImage(compressedFile)
        thumbnailFile.value = thumbnail.thumbnailFile
        thumbnailPreview.value = thumbnail.previewUrl
        thumbnailWidth.value = thumbnail.width
        thumbnailHeight.value = thumbnail.height
        thumbnailSize.value = thumbnail.size
      }
    } else {
      // 非图片：原文件直传，不做压缩、不生成缩略图
      file.value = f
      compressionRatio.value = 0
      imageWidth.value = 0
      imageHeight.value = 0
      thumbnailFile.value = null
      thumbnailPreview.value = ''
    }

    errorMsg.value = ''
    uploadedUrl.value = ''
    uploadedThumbnailUrl.value = ''
  } catch (err) {
    console.error('处理失败:', err)
    errorMsg.value = '文件处理失败'
  } finally {
    processing.value = false
  }
}

async function uploadFile(): Promise<void> {
  if (!file.value) {
    errorMsg.value = '请先选择文件'
    return
  }
  try {
    uploading.value = true
    uploadProgress.value = 0

    const signRes = await axios.get<SignResponse>('/api/upload/sign', {
      params: {
        name: file.value.name,
        size: file.value.size,
      },
    })
    if (signRes.data.code !== 0) {
      throw new Error(signRes.data.msg || '获取上传签名失败')
    }

    const { assets, upload_url: uploadUrl, proxy_path: proxyPath } = signRes.data.data

    await axios.put(uploadUrl, file.value, {
      headers: { 'Content-Type': 'application/octet-stream' },
      onUploadProgress: (e: AxiosProgressEvent) => {
        if (e.total) {
          uploadProgress.value = Math.round((e.loaded / e.total) * 100)
        }
      },
      timeout: 30000,
    })

    // 代理路径优先用后端返回的 proxy_path（已含 img-api/file-api 正确前缀），
    // 兜底用旧的 extractImagePath（老后端兼容）
    const proxyUrl = proxyPath
      ? window.location.origin + proxyPath
      : window.location.origin + '/img-api/' + extractImagePath(assets.path)
    const originUrl = 'https://cnb.cool' + assets.path

    uploadedUrl.value = proxyUrl

    let thumbProxyUrl: string | undefined
    let thumbOriginUrl: string | undefined

    if (thumbnailFile.value) {
      uploadProgress.value = 0

      const thumbSignRes = await axios.get<SignResponse>('/api/upload/sign', {
        params: {
          name: thumbnailFile.value.name,
          size: thumbnailFile.value.size,
        },
      })
      if (thumbSignRes.data.code !== 0) {
        throw new Error(thumbSignRes.data.msg || '获取缩略图上传签名失败')
      }

      await axios.put(thumbSignRes.data.data.upload_url, thumbnailFile.value, {
        headers: { 'Content-Type': 'application/octet-stream' },
        onUploadProgress: (e: AxiosProgressEvent) => {
          if (e.total) {
            uploadProgress.value = Math.round((e.loaded / e.total) * 100)
          }
        },
        timeout: 30000,
      })

      const thumbProxyPath = thumbSignRes.data.data.proxy_path
      thumbProxyUrl = thumbProxyPath
        ? window.location.origin + thumbProxyPath
        : window.location.origin +
          '/img-api/' +
          extractImagePath(thumbSignRes.data.data.assets.path)
      thumbOriginUrl = 'https://cnb.cool' + thumbSignRes.data.data.assets.path
      uploadedThumbnailUrl.value = thumbProxyUrl
    }

    const uploadInfo: UploadInfo = {
      url: proxyUrl,
      urlOriginal: originUrl,
      thumbnailUrl: thumbProxyUrl,
      thumbnailOriginalUrl: thumbOriginUrl,
      name: file.value.name,
      size: file.value.size,
      type: file.value.type,
      compressionRatio: compressionRatio.value,
      width: imageWidth.value,
      height: imageHeight.value,
      hasThumbnail: props.generateThumbnail,
      thumbnailWidth: thumbnailWidth.value,
      thumbnailHeight: thumbnailHeight.value,
      thumbnailSize: thumbnailSize.value,
    }
    emit('update:uploadInfo', uploadInfo)

    toast.success('上传成功')
  } catch (err) {
    console.error(err)
    const error = err as {
      response?: {
        data?: { code?: number; msg?: string; data?: { message?: string; detail?: string } }
      }
      message?: string
    }
    const serverMsg = error.response?.data?.msg
    const serverDetail = error.response?.data?.data?.detail
    const serverInnerMsg = error.response?.data?.data?.message
    errorMsg.value = serverMsg || serverInnerMsg || serverDetail || error.message || '上传失败'
    toast.error(errorMsg.value)
  } finally {
    uploading.value = false
  }
}
</script>
