<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ArrowLeft, KeyRound, Plus, Trash2, Copy, Check, RefreshCw, Loader2 } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { toast } from 'vue-sonner'

interface KeyItem {
  name: string
  keyMasked: string
  note?: string
  createdAt?: string
}

const router = useRouter()
const keys = ref<KeyItem[]>([])
const loading = ref(true)

// 创建表单
const newName = ref('')
const newNote = ref('')
const creating = ref(false)

// 刚创建/轮换出的明文（仅展示一次）
const revealedKey = ref<{ name: string; key: string } | null>(null)
const copied = ref(false)

const sortedKeys = computed(() =>
  [...keys.value].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')),
)

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem('hw_img_host_token')
  return token ? { Authorization: `Bearer ${token}` } : {}
}

async function fetchKeys() {
  loading.value = true
  try {
    const res = await fetch('/api/assets-keys', { headers: authHeaders() })
    const json = await res.json()
    if (json.code === 0) {
      keys.value = json.data.keys
    } else {
      toast.error(json.msg || '加载失败')
    }
  } catch {
    toast.error('网络请求失败')
  } finally {
    loading.value = false
  }
}

async function createKey() {
  const name = newName.value.trim()
  if (!name) {
    toast.error('请填写 service 名称')
    return
  }
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
    toast.error('名称仅允许字母数字、下划线、横线（1-64 位）')
    return
  }
  creating.value = true
  try {
    const res = await fetch('/api/assets-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ name, note: newNote.value.trim() }),
    })
    const json = await res.json()
    if (json.code !== 0) {
      toast.error(json.msg || '创建失败')
      return
    }
    // 展示明文（仅此一次）
    revealedKey.value = { name: json.data.name, key: json.data.key }
    copied.value = false
    newName.value = ''
    newNote.value = ''
    toast.success(`密钥「${name}」已创建，请立即保存明文`)
    await fetchKeys()
  } catch {
    toast.error('创建失败')
  } finally {
    creating.value = false
  }
}

async function deleteKey(item: KeyItem) {
  if (!confirm(`确认删除密钥「${item.name}」？\n删除后该 service 将无法再上传/下载。`)) return
  try {
    const res = await fetch(`/api/assets-keys/${encodeURIComponent(item.name)}`, {
      method: 'DELETE',
      headers: authHeaders(),
    })
    const json = await res.json()
    if (json.code !== 0) {
      toast.error(json.msg || '删除失败')
      return
    }
    toast.success(`密钥「${item.name}」已删除`)
    await fetchKeys()
  } catch {
    toast.error('删除失败')
  }
}

async function rotateKey(item: KeyItem) {
  if (!confirm(`确认轮换密钥「${item.name}」？\n旧密钥立即失效，使用旧密钥的服务需更新为新密钥。`))
    return
  try {
    const res = await fetch(`/api/assets-keys/${encodeURIComponent(item.name)}?rotate=1`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({}),
    })
    const json = await res.json()
    if (json.code !== 0) {
      toast.error(json.msg || '轮换失败')
      return
    }
    // 展示新明文
    revealedKey.value = { name: item.name, key: json.data.key }
    copied.value = false
    toast.success(`密钥「${item.name}」已轮换，请保存新明文`)
    await fetchKeys()
  } catch {
    toast.error('轮换失败')
  }
}

async function copyRevealed() {
  if (!revealedKey.value) return
  try {
    await navigator.clipboard.writeText(revealedKey.value.key)
    copied.value = true
    toast.success('已复制到剪贴板')
    setTimeout(() => (copied.value = false), 2000)
  } catch {
    toast.error('复制失败，请手动复制')
  }
}

function formatTime(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

onMounted(fetchKeys)
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
        <KeyRound class="h-5 w-5" />
        Assets 密钥
      </h1>
      <Button variant="outline" size="sm" @click="router.push('/gallery')">图库</Button>
    </div>

    <p class="mb-6 text-xs leading-relaxed text-muted-foreground">
      管理 assets 中转服务的访问密钥。每个密钥绑定一个 service
      命名空间，只能操作该命名空间下的文件。 密钥明文仅在创建/轮换时显示一次，请妥善保存。
    </p>

    <!-- 创建区 -->
    <div class="mb-6 rounded-lg border border-border/50 bg-card px-5 py-4">
      <h2 class="mb-3 text-sm font-medium">新建密钥</h2>
      <div class="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div class="flex-1">
          <Label class="mb-1.5 block text-xs text-muted-foreground">Service 名称</Label>
          <Input v-model="newName" placeholder="如 koishi、script" />
        </div>
        <div class="flex-1">
          <Label class="mb-1.5 block text-xs text-muted-foreground">备注（可选）</Label>
          <Input v-model="newNote" placeholder="用途说明" />
        </div>
        <Button :disabled="creating" @click="createKey">
          <Plus class="mr-1.5 h-3.5 w-3.5" />
          创建
        </Button>
      </div>
    </div>

    <!-- 明文展示（仅创建/轮换后出现一次）-->
    <div
      v-if="revealedKey"
      class="mb-6 rounded-lg border border-amber-500/40 bg-amber-500/5 px-5 py-4"
    >
      <div class="mb-2 flex items-center gap-2">
        <p class="text-sm font-medium text-amber-600 dark:text-amber-500">
          「{{ revealedKey.name }}」的密钥明文（仅显示一次）
        </p>
        <Button variant="outline" size="sm" @click="copyRevealed">
          <component :is="copied ? Check : Copy" class="mr-1.5 h-3.5 w-3.5" />
          {{ copied ? '已复制' : '复制' }}
        </Button>
      </div>
      <code class="block break-all rounded bg-muted px-3 py-2 text-xs text-foreground">
        {{ revealedKey.key }}
      </code>
    </div>

    <!-- 加载中 -->
    <div v-if="loading" class="flex justify-center py-16">
      <Loader2 class="h-6 w-6 animate-spin text-muted-foreground/50" />
    </div>

    <!-- 密钥列表 -->
    <div v-else-if="sortedKeys.length > 0" class="space-y-2">
      <div
        v-for="item in sortedKeys"
        :key="item.name"
        class="flex items-center justify-between rounded-lg border border-border/50 bg-card px-4 py-3 transition hover:border-foreground/20"
      >
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2">
            <span class="rounded bg-muted px-2 py-0.5 text-xs text-foreground/80">{{
              item.name
            }}</span>
            <code class="text-xs text-muted-foreground">{{ item.keyMasked }}</code>
          </div>
          <p v-if="item.note" class="mt-1 truncate text-xs text-muted-foreground/70">
            {{ item.note }}
          </p>
          <p v-if="item.createdAt" class="mt-0.5 text-xs text-muted-foreground/50">
            创建于 {{ formatTime(item.createdAt) }}
          </p>
        </div>
        <div class="flex items-center gap-1">
          <button
            class="rounded p-1.5 text-muted-foreground/50 transition hover:bg-muted hover:text-foreground"
            title="轮换密钥"
            @click="rotateKey(item)"
          >
            <RefreshCw class="h-3.5 w-3.5" />
          </button>
          <button
            class="rounded p-1.5 text-muted-foreground/50 transition hover:bg-destructive/10 hover:text-destructive"
            title="删除密钥"
            @click="deleteKey(item)"
          >
            <Trash2 class="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>

    <div
      v-else
      class="flex flex-col items-center justify-center py-16 text-sm text-muted-foreground"
    >
      <KeyRound class="mb-2 h-8 w-8 text-muted-foreground/30" />
      <p>还没有密钥</p>
      <p class="mt-1 text-xs text-muted-foreground/60">在上方创建第一个 service 密钥</p>
    </div>
  </div>
</template>
