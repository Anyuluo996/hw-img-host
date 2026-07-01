<script setup lang="ts">
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { ArrowLeft, Loader2, Wand2, Search, Trash2, Sparkles } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import { toast } from 'vue-sonner'

const router = useRouter()

// 扫描结果
const cnbTotal = ref(0)
const kvTotal = ref(0)
const orphans = ref<string[]>([])
const hasScanned = ref(false)

// 操作状态
const scanning = ref(false)
const sweeping = ref(false)
const deleting = ref(false)

// sweep-all 结果
const sweepResult = ref<{ services: number; cleaned: number; details: Array<{ service: string; cleaned: number }> } | null>(null)
const deleteResult = ref<number | null>(null)

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem('hw_img_host_token')
  return token ? { Authorization: `Bearer ${token}` } : {}
}

// 从 path 提取文件名
function fileName(path: string): string {
  return path.split('/').pop() || path
}

// 从 path 判断类型
function isImage(path: string): boolean {
  return path.includes('/-/imgs/')
}

const orphanCount = computed(() => orphans.value.length)

// 扫描对账（dry-run）
async function scanOrphans() {
  scanning.value = true
  sweepResult.value = null
  deleteResult.value = null
  try {
    const res = await fetch('/api/assets/reconcile?mode=dry-run', {
      method: 'POST',
      headers: authHeaders(),
    })
    const json = await res.json()
    if (json.code === 0 && json.data) {
      cnbTotal.value = json.data.cnbTotal
      kvTotal.value = json.data.kvTotal
      orphans.value = json.data.orphans || []
      hasScanned.value = true
      if (orphanCount.value === 0) {
        toast.success('未发现孤儿文件')
      } else {
        toast.info(`发现 ${orphanCount.value} 个孤儿文件`)
      }
    } else {
      toast.error(json.msg || '扫描失败')
    }
  } catch {
    toast.error('网络请求失败')
  } finally {
    scanning.value = false
  }
}

// 清理过期记录（sweep-all）
async function sweepAll() {
  sweeping.value = true
  try {
    const res = await fetch('/api/assets/sweep-all', {
      method: 'POST',
      headers: authHeaders(),
    })
    const json = await res.json()
    if (json.code === 0 && json.data) {
      sweepResult.value = json.data
      toast.success(`已清理 ${json.data.cleaned} 条过期记录`)
    } else {
      toast.error(json.msg || '清理失败')
    }
  } catch {
    toast.error('网络请求失败')
  } finally {
    sweeping.value = false
  }
}

// 删除孤儿（reconcile delete）
async function deleteOrphans() {
  if (orphanCount.value === 0) {
    toast.info('没有孤儿文件可删除')
    return
  }
  if (!confirm(`确认删除 ${orphanCount.value} 个孤儿文件？此操作不可逆。`)) return

  deleting.value = true
  try {
    const res = await fetch('/api/assets/reconcile?mode=delete', {
      method: 'POST',
      headers: authHeaders(),
    })
    const json = await res.json()
    if (json.code === 0 && json.data) {
      deleteResult.value = json.data.deleted
      toast.success(`已删除 ${json.data.deleted} 个孤儿文件`)
      // 自动重新扫描刷新
      await scanOrphans()
    } else {
      toast.error(json.msg || '删除失败')
    }
  } catch {
    toast.error('网络请求失败')
  } finally {
    deleting.value = false
  }
}
</script>

<template>
  <div class="mx-auto max-w-4xl px-6 py-8">
    <!-- 返回 -->
    <button
      class="group mb-6 flex items-center gap-1.5 text-xs text-muted-foreground transition hover:text-foreground"
      @click="router.push('/home')"
    >
      <ArrowLeft class="h-4 w-4 transition group-hover:-translate-x-0.5" />
      上传
    </button>

    <!-- 标题 -->
    <div class="mb-6 flex items-center justify-between">
      <h1 class="flex items-center gap-2 text-lg font-normal">
        <Wand2 class="h-5 w-5" />
        孤儿文件清理
      </h1>
      <Button variant="outline" size="sm" @click="router.push('/gallery')">图库</Button>
    </div>

    <!-- 说明 -->
    <p class="mb-6 text-xs leading-relaxed text-muted-foreground">
      扫描 CNB 存储与 KV 索引的差异，发现并清理孤儿文件（CNB 上有文件但无索引引用）。
      也可手动清理已过期的索引记录。详见
      <a href="https://github.com/Anyuluo996/hw-img-host/blob/main/docs/MECHANISM.md" target="_blank"
        class="text-blue-500 hover:underline">机制文档</a>。
    </p>

    <!-- 操作按钮 -->
    <div class="mb-6 flex flex-wrap gap-2">
      <Button variant="outline" size="sm" :disabled="scanning" @click="scanOrphans">
        <Search v-if="!scanning" class="mr-1.5 h-3.5 w-3.5" />
        <Loader2 v-else class="mr-1.5 h-3.5 w-3.5 animate-spin" />
        {{ scanning ? '扫描中...' : '扫描对账' }}
      </Button>
      <Button variant="outline" size="sm" :disabled="sweeping" @click="sweepAll">
        <Sparkles v-if="!sweeping" class="mr-1.5 h-3.5 w-3.5" />
        <Loader2 v-else class="mr-1.5 h-3.5 w-3.5 animate-spin" />
        {{ sweeping ? '清理中...' : '清理过期记录' }}
      </Button>
      <Button
        variant="destructive"
        size="sm"
        :disabled="deleting || orphanCount === 0"
        @click="deleteOrphans"
      >
        <Trash2 v-if="!deleting" class="mr-1.5 h-3.5 w-3.5" />
        <Loader2 v-else class="mr-1.5 h-3.5 w-3.5 animate-spin" />
        {{ deleting ? '删除中...' : `删除孤儿 (${orphanCount})` }}
      </Button>
    </div>

    <!-- Stats 卡片 -->
    <div v-if="hasScanned" class="mb-6 grid grid-cols-3 gap-3">
      <div class="rounded-lg border border-border/50 bg-card px-4 py-3 text-center">
        <div class="text-2xl font-light text-foreground">{{ cnbTotal }}</div>
        <div class="text-xs text-muted-foreground">CNB 总文件</div>
      </div>
      <div class="rounded-lg border border-border/50 bg-card px-4 py-3 text-center">
        <div class="text-2xl font-light text-foreground">{{ kvTotal }}</div>
        <div class="text-xs text-muted-foreground">KV 索引记录</div>
      </div>
      <div class="rounded-lg border border-border/50 bg-card px-4 py-3 text-center">
        <div class="text-2xl font-light" :class="orphanCount > 0 ? 'text-destructive' : 'text-foreground'">
          {{ orphanCount }}
        </div>
        <div class="text-xs text-muted-foreground">孤儿文件</div>
      </div>
    </div>

    <!-- 扫描中 -->
    <div v-if="scanning" class="flex justify-center py-16">
      <Loader2 class="h-6 w-6 animate-spin text-muted-foreground/50" />
    </div>

    <!-- 孤儿列表 -->
    <div v-else-if="hasScanned && orphanCount > 0" class="space-y-2">
      <h2 class="mb-3 text-sm font-medium text-foreground">孤儿文件列表</h2>
      <div
        v-for="path in orphans"
        :key="path"
        class="flex items-center gap-3 rounded-lg border border-border/50 bg-card px-4 py-2.5"
      >
        <span
          class="inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[10px] font-medium"
          :class="isImage(path) ? 'bg-blue-500/10 text-blue-500' : 'bg-orange-500/10 text-orange-500'"
        >
          {{ isImage(path) ? 'IMG' : 'FILE' }}
        </span>
        <div class="min-w-0 flex-1">
          <div class="truncate text-sm text-foreground">{{ fileName(path) }}</div>
          <div class="truncate text-xs text-muted-foreground">{{ path }}</div>
        </div>
      </div>
    </div>

    <!-- 无孤儿 -->
    <div
      v-else-if="hasScanned && orphanCount === 0"
      class="flex flex-col items-center justify-center py-16 text-sm text-muted-foreground"
    >
      <Sparkles class="mb-2 h-8 w-8 text-green-500/50" />
      <p>未发现孤儿文件，CNB 存储与索引一致</p>
    </div>

    <!-- sweep 结果 -->
    <div v-if="sweepResult" class="mt-6">
      <h2 class="mb-3 text-sm font-medium text-foreground">
        过期记录清理结果（{{ sweepResult.cleaned }} 条）
      </h2>
      <div class="space-y-1.5">
        <div
          v-for="d in sweepResult.details"
          :key="d.service"
          class="flex items-center justify-between rounded-lg border border-border/50 bg-card px-4 py-2"
        >
          <span class="text-sm text-foreground">{{ d.service }}</span>
          <span
            class="text-xs"
            :class="d.cleaned > 0 ? 'text-destructive' : 'text-muted-foreground'"
          >
            {{ d.cleaned > 0 ? `清理 ${d.cleaned} 条` : '无过期' }}
          </span>
        </div>
      </div>
    </div>

    <!-- 未扫描初始状态 -->
    <div
      v-if="!hasScanned && !scanning && !sweepResult"
      class="flex flex-col items-center justify-center py-16 text-sm text-muted-foreground"
    >
      <Search class="mb-2 h-8 w-8 text-muted-foreground/30" />
      <p>点击「扫描对账」检查孤儿文件</p>
    </div>
  </div>
</template>
