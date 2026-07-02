<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ArrowLeft, Fingerprint, Plus, Trash2, RefreshCw, Loader2 } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { toast } from 'vue-sonner'
import { useAuth, type PasskeyItem } from '@/composables/useAuth'

const router = useRouter()
const { listPasskeys, registerPasskey, removePasskey } = useAuth()

const items = ref<PasskeyItem[]>([])
const loading = ref(true)
const registering = ref(false)
// 注册时的可选名称
const newName = ref('')
const showAddForm = ref(false)

const sorted = computed(() =>
  [...items.value].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')),
)

const supported = ref(true)
async function checkSupport() {
  if (typeof window === 'undefined' || !window.PublicKeyCredential) {
    supported.value = false
  } else if (typeof window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable === 'function') {
    // 仅提示，不阻断（外部安全密钥也能用）
    supported.value = await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
  }
}

async function fetchList() {
  loading.value = true
  try {
    items.value = await listPasskeys()
  } catch (e) {
    toast.error((e as Error).message || '加载失败')
  } finally {
    loading.value = false
  }
}

async function handleRegister() {
  if (registering.value) return
  registering.value = true
  try {
    const name = newName.value.trim() || undefined
    await registerPasskey(name)
    toast.success('通行密钥已注册')
    newName.value = ''
    showAddForm.value = false
    await fetchList()
  } catch (e) {
    const msg = (e as Error).message || ''
    if (/abort|cancel|notallowed/i.test(msg)) {
      // 用户取消系统认证，静默
    } else {
      toast.error(msg || '注册失败')
    }
  } finally {
    registering.value = false
  }
}

async function handleDelete(item: PasskeyItem) {
  const label = item.name || item.id.slice(0, 8)
  if (!confirm(`确认删除通行密钥「${label}」？\n删除后该设备将无法用通行密钥登录。`)) return
  try {
    await removePasskey(item.id)
    toast.success(`「${label}」已删除`)
    await fetchList()
  } catch (e) {
    toast.error((e as Error).message || '删除失败')
  }
}

function formatTime(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function transportsLabel(t: string[]): string {
  if (!t || t.length === 0) return '未知'
  const map: Record<string, string> = {
    internal: '内置',
    usb: 'USB',
    nfc: 'NFC',
    ble: '蓝牙',
    hybrid: '混合',
    smartCard: '智能卡',
  }
  return t.map((x) => map[x] || x).join(' / ')
}

onMounted(async () => {
  await Promise.all([fetchList(), checkSupport()])
})
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
        <Fingerprint class="h-5 w-5" />
        通行密钥
      </h1>
      <Button variant="outline" size="sm" :disabled="loading" @click="fetchList">
        <RefreshCw class="mr-1.5 h-3.5 w-3.5" :class="{ 'animate-spin': loading }" />
        刷新
      </Button>
    </div>

    <div
      v-if="!supported"
      class="mb-4 rounded-md border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-xs text-amber-600 dark:text-amber-400"
    >
      当前浏览器不支持或未配置可用的平台认证器，可改用外部安全密钥（USB/NFC）或换用支持的浏览器。
    </div>

    <!-- 注册表单 -->
    <div v-if="showAddForm" class="mb-4 rounded-md border bg-card p-4">
      <div class="space-y-3">
        <div class="space-y-1.5">
          <Label for="pk-name">设备名称（可选）</Label>
          <Input
            id="pk-name"
            v-model="newName"
            placeholder="如：MacBook、iPhone、YubiKey"
            :disabled="registering"
            @keyup.enter="handleRegister"
          />
        </div>
        <div class="flex gap-2">
          <Button :disabled="registering" @click="handleRegister">
            <Loader2 v-if="registering" class="mr-1.5 h-3.5 w-3.5 animate-spin" />
            {{ registering ? '请在设备上完成认证...' : '开始注册' }}
          </Button>
          <Button variant="ghost" :disabled="registering" @click="showAddForm = false">
            取消
          </Button>
        </div>
      </div>
    </div>

    <!-- 注册按钮（未展开表单时） -->
    <Button v-else class="mb-4 w-full" @click="showAddForm = true">
      <Plus class="mr-1.5 h-4 w-4" /> 注册新通行密钥
    </Button>

    <!-- 列表 -->
    <div v-if="loading" class="flex justify-center py-12 text-muted-foreground">
      <Loader2 class="h-5 w-5 animate-spin" />
    </div>

    <div v-else-if="sorted.length === 0" class="py-12 text-center text-sm text-muted-foreground">
      还没有注册任何通行密钥。点击上方按钮添加第一个（建议至少注册 2 个设备作为备份）。
    </div>

    <div v-else class="space-y-2">
      <div
        v-for="item in sorted"
        :key="item.id"
        class="flex items-center justify-between rounded-md border bg-card px-4 py-3"
      >
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2">
            <Fingerprint class="h-4 w-4 shrink-0 text-muted-foreground" />
            <span class="truncate text-sm font-medium">
              {{ item.name || `设备 ${item.id.slice(0, 8)}` }}
            </span>
          </div>
          <div class="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
            <span>创建：{{ formatTime(item.createdAt) }}</span>
            <span>方式：{{ transportsLabel(item.transports) }}</span>
            <span class="font-mono opacity-60">id: {{ item.id.slice(0, 12) }}…</span>
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          class="ml-2 text-destructive hover:bg-destructive/10 hover:text-destructive"
          @click="handleDelete(item)"
        >
          <Trash2 class="h-4 w-4" />
        </Button>
      </div>
    </div>

    <div class="mt-6 space-y-1.5 text-xs text-muted-foreground">
      <p>• 通行密钥与当前域名（RP ID）绑定，更换域名后已注册的密钥将全部失效。</p>
      <p>• 通行密钥丢失会导致无法登录，建议至少保留 2 个设备或保留密码登录作为兜底。</p>
      <p>• 注册新设备需先登录（用密码或已有通行密钥），登录入口则公开。</p>
    </div>
  </div>
</template>
