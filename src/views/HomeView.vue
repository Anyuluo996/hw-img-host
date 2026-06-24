<script setup lang="ts">
import FileUploader from '@/components/public/FileUploader.vue'
import { ref, watch } from 'vue'
import { Upload } from 'lucide-vue-next'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { toast } from 'vue-sonner'

const quality = ref(0.7)
const generateThumbnail = ref(false)

// tag 输入状态
const tags = ref<string[]>([])
const tagInput = ref('')
const gallerySaved = ref(false)

function addTag() {
  const parts = tagInput.value
    .split(/[,，]/)
    .map((t) => t.trim())
    .filter(Boolean)
  for (const p of parts) {
    if (!tags.value.includes(p)) tags.value.push(p)
  }
  tagInput.value = ''
}
function removeTag(t: string) {
  tags.value = tags.value.filter((x) => x !== t)
}

// 保存到画廊（带上 tag）。重复文件复用链接，不再写入索引避免重复记录。
function saveToGallery() {
  if (!uploadInfo.value) return
  if (uploadInfo.value.duplicate) {
    toast.info('该文件已存在，链接已复用，无需重复保存')
    gallerySaved.value = true
    return
  }
  gallerySaved.value = true
  fetch('/kv-api', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(localStorage.getItem('hw_img_host_token')
        ? { Authorization: `Bearer ${localStorage.getItem('hw_img_host_token')}` }
        : {}),
    },
    body: JSON.stringify({ ...uploadInfo.value, tags: tags.value }),
  })
    .then(() => toast.success('已保存到画廊'))
    .catch(() => toast.error('保存到画廊失败'))
}

const uploadInfo = ref<{
  url: string
  thumbnailUrl?: string
  urlOriginal?: string
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
  assetsPath?: string
  tags?: string[]
  hash?: string
  duplicate?: boolean
} | null>(null)

// 上传后重置 tag 状态（等用户在上传完成区填 tag 再保存）
watch(uploadInfo, (val) => {
  if (val) {
    tags.value = []
    tagInput.value = ''
    gallerySaved.value = false
  }
})
</script>

<template>
  <div class="min-h-screen bg-background">
    <div class="flex min-h-screen flex-col items-center justify-center space-y-3 px-4 py-16">
      <div class="text-center">
        <div class="mb-3 flex items-center justify-center gap-2.5">
          <Upload class="h-6 w-6 text-foreground/60" :stroke-width="1.5" />
          <h1 class="text-2xl font-normal tracking-wide text-foreground">图片上传</h1>
        </div>
        <p class="text-sm text-muted-foreground">拖拽上传 · 压缩转码 · 直达链接</p>
      </div>

      <div class="w-full max-w-md space-y-5">
        <div class="space-y-4 rounded-xl border border-border/50 bg-card px-5 py-4">
          <div class="space-y-2">
            <div class="flex items-center justify-between">
              <Label class="text-xs text-muted-foreground">压缩质量</Label>
              <span class="text-xs tabular-nums text-foreground/70"
                >{{ Math.round(quality * 100) }}%</span
              >
            </div>
            <Slider
              :model-value="[quality]"
              @update:model-value="(val: number[] | undefined) => (quality = val?.[0] ?? quality)"
              :min="0.1"
              :max="1"
              :step="0.05"
            />
          </div>

          <div class="flex items-center justify-between">
            <Label for="thumbnail-toggle" class="text-xs text-muted-foreground">生成缩略图</Label>
            <Switch id="thumbnail-toggle" v-model="generateThumbnail" />
          </div>
        </div>

        <FileUploader
          v-model:uploadInfo="uploadInfo"
          :quality="quality"
          :generateThumbnail="generateThumbnail"
          :maxHeight="5000"
          :maxWidth="5000"
          :thumbnailMaxWidth="400"
          :thumbnailMaxHeight="800"
          :thumbnailQuality="0.8"
        />
      </div>

      <Transition
        enter-active-class="transition duration-300 ease-out"
        enter-from-class="opacity-0 translate-y-4"
        leave-active-class="transition duration-200 ease-in"
        leave-from-class="opacity-100 translate-y-0"
        leave-to-class="opacity-0 translate-y-4"
      >
        <div
          v-if="uploadInfo"
          class="mt-6 w-full max-w-md overflow-hidden rounded-xl border border-border/50 bg-card"
        >
          <div class="flex items-center gap-2 px-5 py-3.5">
            <span class="text-xs font-medium text-muted-foreground">上传完成</span>
            <span
              v-if="uploadInfo.duplicate"
              class="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-600 dark:text-amber-400"
            >已存在·复用</span>
          </div>
          <div class="space-y-0.5 border-t border-border/30 px-5 py-3.5">
            <div class="flex items-baseline gap-2 py-1.5">
              <span class="w-17 shrink-0 text-xs text-muted-foreground/70">代理原图</span>
              <a
                :href="uploadInfo.url"
                target="_blank"
                class="truncate text-sm text-foreground/80 underline-offset-2 transition hover:text-foreground hover:underline"
              >
                {{ uploadInfo.url }}
              </a>
            </div>
            <div v-if="uploadInfo.thumbnailUrl" class="flex items-baseline gap-2 py-1.5">
              <span class="w-17 shrink-0 text-xs text-muted-foreground/70">代理缩略图</span>
              <a
                :href="uploadInfo.thumbnailUrl"
                target="_blank"
                class="truncate text-sm text-foreground/80 underline-offset-2 transition hover:text-foreground hover:underline"
              >
                {{ uploadInfo.thumbnailUrl }}
              </a>
            </div>
            <div class="flex items-baseline gap-2 py-1.5">
              <span class="w-17 shrink-0 text-xs text-muted-foreground/70">CNB 原图</span>
              <a
                :href="uploadInfo.urlOriginal"
                target="_blank"
                class="truncate text-sm text-foreground/80 underline-offset-2 transition hover:text-foreground hover:underline"
              >
                {{ uploadInfo.urlOriginal }}
              </a>
            </div>
            <div v-if="uploadInfo.thumbnailUrl" class="flex items-baseline gap-2 py-1.5">
              <span class="w-17 shrink-0 text-xs text-muted-foreground/70">CNB 缩略图</span>
              <a
                :href="uploadInfo.thumbnailOriginalUrl"
                target="_blank"
                class="truncate text-sm text-foreground/80 underline-offset-2 transition hover:text-foreground hover:underline"
              >
                {{ uploadInfo.thumbnailOriginalUrl }}
              </a>
            </div>
          </div>

          <!-- 复用提示（duplicate 时）-->
          <div
            v-if="uploadInfo.duplicate"
            class="border-t border-border/30 px-5 py-3 text-center text-xs text-muted-foreground"
          >
            该文件已存在，已复用链接，无需重复保存
          </div>

          <!-- tag 输入 + 保存到画廊（非 duplicate）-->
          <div v-else class="space-y-2.5 border-t border-border/30 px-5 py-3.5">
            <div class="flex items-center gap-2">
              <span class="w-17 shrink-0 text-xs text-muted-foreground/70">标签</span>
              <div class="flex flex-wrap items-center gap-1.5">
                <span
                  v-for="t in tags"
                  :key="t"
                  class="inline-flex items-center gap-1 rounded bg-muted px-2 py-0.5 text-xs text-foreground/80"
                >
                  {{ t }}
                  <button class="text-muted-foreground/60 hover:text-destructive" @click="removeTag(t)">×</button>
                </span>
                <input
                  v-model="tagInput"
                  placeholder="输入标签，逗号或回车添加"
                  class="min-w-32 flex-1 bg-transparent text-xs text-foreground/80 outline-none placeholder:text-muted-foreground/40"
                  @keydown.enter.prevent="addTag"
                  @keydown.,.prevent="addTag"
                />
              </div>
            </div>
            <button
              :disabled="gallerySaved"
              class="w-full rounded-lg bg-foreground py-2 text-xs text-background transition hover:bg-foreground/90 disabled:cursor-not-allowed disabled:opacity-50"
              @click="saveToGallery"
            >
              {{ gallerySaved ? '已保存到画廊' : '保存到画廊' }}
            </button>
          </div>
        </div>
      </Transition>
    </div>
  </div>
</template>
