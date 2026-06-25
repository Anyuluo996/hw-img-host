<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { Image, Copy, Check, ExternalLink, ArrowLeft, Loader2, Trash2, Search, Tag } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from 'vue-sonner'
import { useGalleryCache, type ImageRecord } from '@/composables/useGalleryCache'

const router = useRouter()
const { readCache, writeCache, bumpVersion } = useGalleryCache()

interface ListResponse {
  code: number
  msg: string
  data: {
    images: ImageRecord[]
    total: number
  }
}

const IMAGE_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif', 'tiff',
])
function isImageName(name: string): boolean {
  const m = String(name).toLowerCase().match(/\.([a-z0-9]+)$/)
  return !!m && !!m[1] && IMAGE_EXTS.has(m[1])
}

const images = ref<ImageRecord[]>([])
const loading = ref(true)
const error = ref('')
const total = ref(0)
const brokenImages = ref(new Set<string>())
const copiedId = ref('')

// 搜索与筛选
const search = ref('')
const filter = ref<'all' | 'image' | 'file'>('all')
const filterTag = ref<string>('') // 按 tag 筛选

// 所有已用过的 tag 列表（供筛选下拉）
const allTags = computed(() => {
  const s = new Set<string>()
  for (const img of images.value) {
    if (Array.isArray(img.tags)) for (const t of img.tags) if (t) s.add(t)
  }
  return Array.from(s).sort()
})

const filteredImages = computed(() => {
  let list = images.value
  if (filter.value !== 'all') {
    list = list.filter((img) =>
      filter.value === 'image' ? isImageName(img.name) : !isImageName(img.name),
    )
  }
  if (filterTag.value) {
    const t = filterTag.value.toLowerCase()
    list = list.filter((img) =>
      Array.isArray(img.tags) ? img.tags.some((x) => x.toLowerCase() === t) : false,
    )
  }
  const kw = search.value.trim().toLowerCase()
  if (kw) {
    list = list.filter((img) => {
      const inName = img.name.toLowerCase().includes(kw)
      const inTag = Array.isArray(img.tags) && img.tags.some((t) => t.toLowerCase().includes(kw))
      return inName || inTag
    })
  }
  return list
})

// 分页：每页 20 张。数据仍一次性从 KV 拉取（无法在边缘函数侧分页），
// 这里做客户端分页避免一次渲染上千个 DOM 节点导致卡顿。
const PAGE_SIZE = 20
const page = ref(1)
const pagedImages = computed(() =>
  filteredImages.value.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE),
)
const totalPages = computed(() => Math.max(1, Math.ceil(filteredImages.value.length / PAGE_SIZE)))

// 搜索 / 筛选改变后回到第 1 页
watch([search, filter, filterTag], () => {
  page.value = 1
})

// tag 编辑状态
const editingId = ref('') // 正在编辑 tag 的记录 id
const editTagsInput = ref('')
const savingTags = ref(false)

function startEditTags(img: ImageRecord) {
  editingId.value = img.id
  editTagsInput.value = (img.tags || []).join(', ')
}
function cancelEditTags() {
  editingId.value = ''
  editTagsInput.value = ''
}
async function saveEditTags(img: ImageRecord) {
  const tags = editTagsInput.value
    .split(/[,，]/)
    .map((t) => t.trim())
    .filter(Boolean)
  savingTags.value = true
  try {
    const res = await fetch(`/kv-api/${img.id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders(),
      },
      body: JSON.stringify({ tags }),
    })
    const json = await res.json()
    if (json.code !== 0) {
      toast.error(json.msg || '保存标签失败')
      return
    }
    // 本地更新
    img.tags = tags
    // 同步缓存 + 打脏版本号（tag 变更影响 /img 随机端点的桶，也通知其他标签页）
    writeCache(images.value)
    bumpVersion()
    toast.success('标签已更新')
    editingId.value = ''
  } catch {
    toast.error('保存标签失败')
  } finally {
    savingTags.value = false
  }
}

// 批量选择
const selectedIds = ref(new Set<string>())
const selectMode = ref(false)
const deleting = ref(false)
function toggleSelect(id: string) {
  if (selectedIds.value.has(id)) selectedIds.value.delete(id)
  else selectedIds.value.add(id)
  // 触发响应式
  selectedIds.value = new Set(selectedIds.value)
}
function toggleSelectAll() {
  if (selectedIds.value.size === filteredImages.value.length) {
    selectedIds.value = new Set()
  } else {
    selectedIds.value = new Set(filteredImages.value.map((i) => i.id))
  }
}
const allSelected = computed(() => selectedIds.value.size > 0 && selectedIds.value.size === filteredImages.value.length)

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

function formatDate(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function formatRatio(ratio: number): string {
  return (Math.abs(ratio) < 0.01 ? 0 : ratio).toFixed(1) + '%'
}

async function copyUrl(url: string, id: string) {
  try {
    await navigator.clipboard.writeText(url)
    copiedId.value = id
    setTimeout(() => {
      if (copiedId.value === id) copiedId.value = ''
    }, 2000)
  } catch {
    toast.error('复制失败')
  }
}

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem('hw_img_host_token')
  return token ? { Authorization: `Bearer ${token}` } : {}
}

// 加载图库列表。
// silent=true 时不显示 loading（用于后台刷新：已先用缓存秒显，再静默拉最新数据）。
async function fetchImages(silent = false) {
  if (!silent) loading.value = true
  error.value = ''
  try {
    const res = await fetch('/kv-api', { headers: authHeaders() })
    const json: ListResponse = await res.json()
    if (json.code !== 0) {
      // 后台刷新失败时不清空已有缓存数据，只在首次加载时报错
      if (!silent) error.value = json.msg || '加载失败'
      return
    }
    images.value = json.data.images
    total.value = json.data.total
    // 写入缓存供下次秒开
    writeCache(json.data.images)
  } catch {
    if (!silent) error.value = '网络请求失败'
  } finally {
    if (!silent) loading.value = false
  }
}

// 删除单条：并行删 KV 索引 + CNB 文件，两者独立成败
async function deleteOne(img: ImageRecord) {
  if (!confirm(`确定删除「${img.name}」？`)) return
  deleting.value = true
  try {
    // 1. 删 KV 索引
    const kvRes = await fetch(`/kv-api/${img.id}`, { method: 'DELETE', headers: authHeaders() })
    const kvJson = await kvRes.json().catch(() => ({}))
    if (kvJson.code !== 0) {
      toast.error(kvJson.msg || '删除索引失败')
      return
    }
    // 2. 删 CNB 文件（失败仅警告，索引已删）
    if (img.assetsPath) {
      const cnbRes = await fetch('/api/delete', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ path: img.assetsPath }),
      })
      const cnbJson = await cnbRes.json().catch(() => ({}))
      if (cnbJson.code !== 0) {
        toast.warning(`索引已删除，但 CNB 文件删除失败：${cnbJson.msg || cnbJson.data?.message}`)
      } else {
        toast.success('已删除')
      }
    } else {
      toast.success('索引已删除（无 CNB path，未删实际文件）')
    }
    // 本地移除
    images.value = images.value.filter((i) => i.id !== img.id)
    total.value = images.value.length
    // 同步缓存 + 打脏版本号（通知其他标签页/上传页）
    writeCache(images.value)
    bumpVersion()
  } catch {
    toast.error('删除失败')
  } finally {
    deleting.value = false
  }
}

// 批量删除
async function deleteSelected() {
  const targets = images.value.filter((i) => selectedIds.value.has(i.id))
  if (targets.length === 0) return
  if (!confirm(`确定删除选中的 ${targets.length} 项？`)) return
  deleting.value = true
  let okCount = 0
  let cnbFail = 0
  // 逐个删 KV 索引，CNB 文件批量删
  for (const img of targets) {
    const kvRes = await fetch(`/kv-api/${img.id}`, { method: 'DELETE', headers: authHeaders() })
    const kvJson = await kvRes.json().catch(() => ({}))
    if (kvJson.code === 0) okCount++
  }
  // 有 assetsPath 的批量删 CNB 文件
  const paths = targets.map((t) => t.assetsPath).filter((p): p is string => !!p)
  if (paths.length > 0) {
    const cnbRes = await fetch('/api/delete/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ paths }),
    })
    const cnbJson = await cnbRes.json().catch(() => ({}))
    cnbFail = cnbJson.data?.failed ?? 0
  }
  // 本地移除已删的
  images.value = images.value.filter((i) => !selectedIds.value.has(i.id))
  total.value = images.value.length
  // 同步缓存 + 打脏版本号
  writeCache(images.value)
  bumpVersion()
  selectedIds.value = new Set()
  selectMode.value = false
  if (cnbFail > 0) {
    toast.warning(`删除 ${okCount} 条索引，CNB 文件 ${cnbFail} 个删除失败`)
  } else {
    toast.success(`已删除 ${okCount} 项`)
  }
  deleting.value = false
}

// 监听跨标签页缓存失效（HomeView 在另一标签上传后通过 storage 事件通知）
function onStorageChange(e: StorageEvent) {
  if (e.key === 'hw_gallery_version') {
    fetchImages(true)
  }
}
// 同标签页缓存失效（HomeView 上传 → 自定义事件，storage 事件不触发本标签）
function onCacheInvalidated() {
  fetchImages(true)
}

onMounted(() => {
  // 先读缓存秒显（loading=false 不转圈），再后台静默拉最新数据对齐
  const cached = readCache()
  if (cached && cached.length > 0) {
    images.value = cached
    total.value = cached.length
    loading.value = false
    fetchImages(true)
  } else {
    fetchImages()
  }
  window.addEventListener('storage', onStorageChange)
  window.addEventListener('gallery-cache-invalidated', onCacheInvalidated)
})

onUnmounted(() => {
  window.removeEventListener('storage', onStorageChange)
  window.removeEventListener('gallery-cache-invalidated', onCacheInvalidated)
})
</script>

<template>
  <div class="min-h-screen bg-background">
    <div class="mx-auto max-w-6xl px-4 py-8">
      <div class="mb-6 flex items-center justify-between">
        <button
          class="group inline-flex items-center gap-1.5 text-sm text-muted-foreground transition hover:text-foreground"
          @click="router.push('/home')"
        >
          <ArrowLeft class="h-4 w-4 transition group-hover:-translate-x-0.5" />
          上传文件
        </button>
        <div class="flex items-center gap-2.5">
          <Image class="h-5 w-5 text-foreground/60" :stroke-width="1.5" />
          <h1 class="text-xl font-normal tracking-wide text-foreground">文件图库</h1>
        </div>
        <div class="w-18" />
      </div>

      <div v-if="loading" class="flex items-center justify-center py-24">
        <Loader2 class="h-6 w-6 animate-spin text-muted-foreground" />
      </div>

      <div v-else-if="error" class="flex flex-col items-center justify-center py-24">
        <p class="text-sm text-destructive">{{ error }}</p>
        <Button variant="outline" size="sm" class="mt-4" @click="fetchImages">重试</Button>
      </div>

      <div v-else-if="images.length === 0" class="flex flex-col items-center justify-center py-24">
        <Image class="mb-3 h-10 w-10 text-muted-foreground/40" :stroke-width="1" />
        <p class="text-sm text-muted-foreground">还没有上传的文件</p>
        <Button variant="outline" size="sm" class="mt-4" @click="router.push('/home')"> 去上传 </Button>
      </div>

      <template v-else>
        <!-- 工具栏：搜索 + 类型筛选 + tag筛选 + 选择模式 -->
        <div class="mb-5 flex flex-wrap items-center gap-3">
          <div class="relative flex-1 min-w-48">
            <Search class="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/50" />
            <Input v-model="search" placeholder="搜索文件名或标签..." class="pl-9" />
          </div>
          <div class="flex items-center gap-1 rounded-lg border border-border/50 p-0.5">
            <button
              v-for="opt in [{ k: 'all', t: '全部' }, { k: 'image', t: '图片' }, { k: 'file', t: '文件' }] as const"
              :key="opt.k"
              class="rounded-md px-3 py-1 text-xs transition"
              :class="filter === opt.k ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground'"
              @click="filter = opt.k"
            >
              {{ opt.t }}
            </button>
          </div>
          <select
            v-if="allTags.length > 0"
            v-model="filterTag"
            class="rounded-lg border border-border/50 bg-card px-3 py-1.5 text-xs text-foreground/80 outline-none"
          >
            <option value="">所有标签</option>
            <option v-for="t in allTags" :key="t" :value="t">{{ t }}</option>
          </select>
          <Button variant="outline" size="sm" :disabled="deleting" @click="selectMode = !selectMode">
            {{ selectMode ? '取消选择' : '批量管理' }}
          </Button>
        </div>

        <!-- 批量操作栏 -->
        <div
          v-if="selectMode"
          class="mb-4 flex items-center justify-between rounded-lg border border-border/50 bg-muted/20 px-4 py-2.5"
        >
          <div class="flex items-center gap-3 text-xs text-muted-foreground">
            <button class="hover:text-foreground" @click="toggleSelectAll">
              <span v-if="allSelected">取消全选</span>
              <span v-else>全选</span>
            </button>
            <span>已选 {{ selectedIds.size }} / {{ filteredImages.length }} 项</span>
          </div>
          <Button
            variant="destructive"
            size="sm"
            :disabled="selectedIds.size === 0 || deleting"
            @click="deleteSelected"
          >
            <Trash2 class="mr-1.5 h-3.5 w-3.5" />
            删除选中
          </Button>
        </div>

        <div v-if="filteredImages.length === 0" class="flex flex-col items-center justify-center py-16">
          <p class="text-sm text-muted-foreground">没有匹配的文件</p>
        </div>

        <div v-else class="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
          <div
            v-for="img in pagedImages"
            :key="img.id"
            class="group relative overflow-hidden rounded-xl border bg-card transition hover:border-border"
            :class="selectedIds.has(img.id) ? 'border-foreground ring-1 ring-foreground' : 'border-border/50'"
          >
            <!-- 选择框 -->
            <input
              v-if="selectMode"
              type="checkbox"
              :checked="selectedIds.has(img.id)"
              class="absolute left-2 top-2 z-20 h-4 w-4 cursor-pointer"
              @click.stop="toggleSelect(img.id)"
            />

            <div class="relative aspect-4/3 overflow-hidden bg-muted/30">
              <img
                v-if="isImageName(img.name)"
                :src="img.thumbnailUrl || img.url"
                :alt="img.name"
                class="h-full w-full object-cover transition group-hover:scale-105"
                loading="lazy"
                @error="brokenImages.add(img.id)"
              />
              <div v-else class="flex h-full items-center justify-center">
                <span class="text-2xl font-light text-muted-foreground/40">
                  .{{ img.name.split('.').pop() }}
                </span>
              </div>
              <div
                v-if="isImageName(img.name) && brokenImages.has(img.id)"
                class="absolute inset-0 flex items-center justify-center bg-muted/30"
              >
                <Image class="h-8 w-8 text-muted-foreground/50" :stroke-width="1" />
              </div>
              <div class="absolute inset-0 bg-black/0 transition group-hover:bg-black/20" />
              <div class="absolute right-2 top-2 flex gap-1.5">
                <button
                  class="rounded-md bg-background/80 p-1.5 opacity-0 backdrop-blur-sm transition hover:bg-background group-hover:opacity-100"
                  :title="copiedId === img.id ? '已复制' : '复制链接'"
                  @click="copyUrl(img.url, img.id)"
                >
                  <Check v-if="copiedId === img.id" class="h-3.5 w-3.5 text-green-600" />
                  <Copy v-else class="h-3.5 w-3.5 text-foreground/70" />
                </button>
                <a
                  :href="img.url"
                  target="_blank"
                  class="rounded-md bg-background/80 p-1.5 opacity-0 backdrop-blur-sm transition hover:bg-background group-hover:opacity-100"
                  title="新窗口打开"
                >
                  <ExternalLink class="h-3.5 w-3.5 text-foreground/70" />
                </a>
                <button
                  v-if="!selectMode"
                  class="rounded-md bg-background/80 p-1.5 opacity-0 backdrop-blur-sm transition hover:bg-background group-hover:opacity-100"
                  title="编辑标签"
                  :disabled="savingTags"
                  @click="startEditTags(img)"
                >
                  <Tag class="h-3.5 w-3.5 text-foreground/70" />
                </button>
                <button
                  v-if="!selectMode"
                  class="rounded-md bg-background/80 p-1.5 opacity-0 backdrop-blur-sm transition hover:bg-destructive hover:text-destructive-foreground group-hover:opacity-100"
                  title="删除"
                  :disabled="deleting"
                  @click="deleteOne(img)"
                >
                  <Trash2 class="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            <div class="space-y-1.5 px-3 py-2.5">
              <p class="truncate text-xs font-medium text-foreground/80" :title="img.name">
                {{ img.name }}
              </p>
              <div class="flex items-center justify-between text-[11px] text-muted-foreground/70">
                <span v-if="isImageName(img.name)">{{ img.width }}x{{ img.height }}</span>
                <span v-else class="rounded bg-muted px-1.5 py-0.5 text-[10px]">文件</span>
                <span>{{ formatSize(img.size) }}</span>
              </div>
              <div class="flex items-center justify-between text-[11px] text-muted-foreground/50">
                <span v-if="isImageName(img.name)">压缩 {{ formatRatio(img.compressionRatio) }}</span>
                <span v-else>-</span>
                <span>{{ formatDate(img.createdAt) }}</span>
              </div>
              <!-- tag 显示 -->
              <div v-if="editingId !== img.id && img.tags && img.tags.length" class="flex flex-wrap gap-1 pt-0.5">
                <span
                  v-for="t in img.tags"
                  :key="t"
                  class="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary"
                >{{ t }}</span>
              </div>
              <!-- tag 编辑面板 -->
              <div v-if="editingId === img.id" class="space-y-1.5 pt-1">
                <input
                  v-model="editTagsInput"
                  placeholder="逗号分隔，如：动漫, 风景"
                  class="w-full rounded border border-border/50 bg-background px-2 py-1 text-[11px] outline-none focus:border-foreground/40"
                  @keydown.enter.prevent="saveEditTags(img)"
                  @keydown.esc="cancelEditTags"
                />
                <div class="flex gap-1.5">
                  <button
                    class="flex-1 rounded bg-foreground py-1 text-[10px] text-background disabled:opacity-50"
                    :disabled="savingTags"
                    @click="saveEditTags(img)"
                  >保存</button>
                  <button
                    class="flex-1 rounded border border-border/50 py-1 text-[10px] text-muted-foreground"
                    @click="cancelEditTags"
                  >取消</button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="mt-8 flex flex-col items-center gap-3">
          <p class="text-xs text-muted-foreground">
            共 {{ total }} 个文件{{ filteredImages.length !== total ? `（显示 ${filteredImages.length}）` : '' }}
          </p>
          <div v-if="totalPages > 1" class="flex items-center gap-1.5">
            <button
              class="rounded-md border border-border/50 px-3 py-1.5 text-xs text-muted-foreground transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
              :disabled="page === 1"
              @click="page--"
            >
              上一页
            </button>
            <span class="px-2 text-xs tabular-nums text-muted-foreground">
              {{ page }} / {{ totalPages }}
            </span>
            <button
              class="rounded-md border border-border/50 px-3 py-1.5 text-xs text-muted-foreground transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
              :disabled="page === totalPages"
              @click="page++"
            >
              下一页
            </button>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>
