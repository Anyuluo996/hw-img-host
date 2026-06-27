<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ArrowLeft, Tag, Search, Loader2, Pencil, Trash2 } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from 'vue-sonner'

interface ImageRecord {
  id: string
  name: string
  tags?: string[]
}

const router = useRouter()
const images = ref<ImageRecord[]>([])
const loading = ref(true)
const search = ref('')

// 聚合：tag → 数量
const tagStats = computed(() => {
  const map = new Map<string, number>()
  for (const img of images.value) {
    if (Array.isArray(img.tags)) {
      for (const t of img.tags) {
        if (t) map.set(t, (map.get(t) || 0) + 1)
      }
    }
  }
  // 按数量降序
  return Array.from(map.entries())
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count)
    .filter((t) => !search.value || t.tag.toLowerCase().includes(search.value.toLowerCase()))
})

const untaggedCount = computed(
  () => images.value.filter((img) => !Array.isArray(img.tags) || img.tags.length === 0).length,
)

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem('hw_img_host_token')
  return token ? { Authorization: `Bearer ${token}` } : {}
}

async function fetchImages() {
  loading.value = true
  try {
    const res = await fetch('/kv-api', { headers: authHeaders() })
    const json = await res.json()
    if (json.code === 0) {
      images.value = json.data.images
    }
  } catch {
    toast.error('加载失败')
  } finally {
    loading.value = false
  }
}

// 重命名 tag：遍历所有含该 tag 的记录，把旧 tag 换成新 tag
async function renameTag(oldTag: string) {
  const newTag = prompt(`将标签「${oldTag}」重命名为：`, oldTag)
  if (!newTag || newTag === oldTag) return
  if (newTag.trim() === '') {
    toast.error('标签名不能为空')
    return
  }
  const targets = images.value.filter((img) => Array.isArray(img.tags) && img.tags.includes(oldTag))
  let ok = 0
  for (const img of targets) {
    const newTags = (img.tags || []).map((t) => (t === oldTag ? newTag.trim() : t))
    try {
      const res = await fetch(`/kv-api/${img.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ tags: newTags }),
      })
      const json = await res.json().catch(() => ({}))
      if (json.code === 0) {
        img.tags = newTags
        ok++
      }
    } catch {
      /* 继续 */
    }
  }
  toast.success(`已重命名 ${ok}/${targets.length} 条记录的标签`)
}

// 删除 tag：遍历所有含该 tag 的记录，移除该 tag
async function deleteTag(tag: string) {
  const targets = images.value.filter((img) => Array.isArray(img.tags) && img.tags.includes(tag))
  if (!confirm(`从 ${targets.length} 条记录中移除标签「${tag}」？文件本身不删除。`)) return
  let ok = 0
  for (const img of targets) {
    const newTags = (img.tags || []).filter((t) => t !== tag)
    try {
      const res = await fetch(`/kv-api/${img.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ tags: newTags }),
      })
      const json = await res.json().catch(() => ({}))
      if (json.code === 0) {
        img.tags = newTags
        ok++
      }
    } catch {
      /* 继续 */
    }
  }
  toast.success(`已从 ${ok}/${targets.length} 条记录移除标签`)
}

function viewByTag(tag: string) {
  router.push({ path: '/gallery', query: { tag } })
}

onMounted(fetchImages)
</script>

<template>
  <div class="mx-auto max-w-4xl px-6 py-8">
    <button
      class="group mb-6 flex items-center gap-1.5 text-xs text-muted-foreground transition hover:text-foreground"
      @click="router.push('/home')"
    >
      <ArrowLeft class="h-4 w-4 transition group-hover:-translate-x-0.5" />
      上传
    </button>

    <div class="mb-6 flex items-center justify-between">
      <h1 class="flex items-center gap-2 text-lg font-normal">
        <Tag class="h-5 w-5" />
        标签管理
      </h1>
      <Button variant="outline" size="sm" @click="router.push('/gallery')">图库</Button>
    </div>

    <!-- 概览 -->
    <div class="mb-6 grid grid-cols-3 gap-3">
      <div class="rounded-lg border border-border/50 bg-card px-4 py-3 text-center">
        <p class="text-2xl font-light">{{ tagStats.length }}</p>
        <p class="mt-0.5 text-xs text-muted-foreground">标签总数</p>
      </div>
      <div class="rounded-lg border border-border/50 bg-card px-4 py-3 text-center">
        <p class="text-2xl font-light">{{ images.length }}</p>
        <p class="mt-0.5 text-xs text-muted-foreground">文件总数</p>
      </div>
      <button
        class="rounded-lg border border-border/50 bg-card px-4 py-3 text-center transition hover:border-foreground/20"
        @click="viewByTag('')"
      >
        <p class="text-2xl font-light">{{ untaggedCount }}</p>
        <p class="mt-0.5 text-xs text-muted-foreground">未分类</p>
      </button>
    </div>

    <!-- 搜索 -->
    <div class="relative mb-4">
      <Search class="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/50" />
      <Input v-model="search" placeholder="搜索标签..." class="pl-9" />
    </div>

    <!-- 加载中 -->
    <div v-if="loading" class="flex justify-center py-16">
      <Loader2 class="h-6 w-6 animate-spin text-muted-foreground/50" />
    </div>

    <!-- 标签列表 -->
    <div v-else-if="tagStats.length > 0" class="space-y-2">
      <div
        v-for="t in tagStats"
        :key="t.tag"
        class="flex items-center justify-between rounded-lg border border-border/50 bg-card px-4 py-2.5 transition hover:border-foreground/20"
      >
        <button class="flex flex-1 items-center gap-2 text-left" @click="viewByTag(t.tag)">
          <span class="rounded bg-muted px-2 py-0.5 text-xs text-foreground/80">{{ t.tag }}</span>
          <span class="text-xs text-muted-foreground">{{ t.count }} 张</span>
        </button>
        <div class="flex items-center gap-1">
          <button
            class="rounded p-1.5 text-muted-foreground/50 transition hover:bg-muted hover:text-foreground"
            title="重命名"
            @click="renameTag(t.tag)"
          >
            <Pencil class="h-3.5 w-3.5" />
          </button>
          <button
            class="rounded p-1.5 text-muted-foreground/50 transition hover:bg-destructive/10 hover:text-destructive"
            title="删除标签"
            @click="deleteTag(t.tag)"
          >
            <Trash2 class="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>

    <div v-else class="flex flex-col items-center justify-center py-16 text-sm text-muted-foreground">
      <p>{{ search ? '没有匹配的标签' : '还没有标签' }}</p>
    </div>
  </div>
</template>
