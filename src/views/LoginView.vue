<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { Fingerprint } from 'lucide-vue-next'
import { useAuth } from '@/composables/useAuth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { toast } from 'vue-sonner'

const router = useRouter()
const { login, loginWithPasskey } = useAuth()

const password = ref('')
const loading = ref(false)
const passkeyLoading = ref(false)
const error = ref('')
// 前端防爆破：每次点击后冷却 2 秒，期间禁用按钮，降低暴力尝试速率。
const cooldown = ref(false)

async function handleLogin() {
  if (!password.value || loading.value || cooldown.value) return
  loading.value = true
  error.value = ''
  try {
    await login(password.value)
    toast.success('登录成功')
    router.push('/home')
  } catch (e: unknown) {
    const err = e as { response?: { data?: { msg?: string } }; message?: string }
    error.value = err.response?.data?.msg || err.message || '登录失败'
    // 失败后进入冷却（成功登录不需要冷却）
    cooldown.value = true
    setTimeout(() => {
      cooldown.value = false
    }, 2000)
  } finally {
    loading.value = false
  }
}

// 通行密钥登录：浏览器弹出系统认证（指纹/Face ID/PIN/安全密钥）
async function handlePasskeyLogin() {
  if (passkeyLoading.value || loading.value || cooldown.value) return
  // 浏览器不支持 WebAuthn 时直接提示
  if (typeof window === 'undefined' || !window.PublicKeyCredential) {
    error.value = '当前浏览器不支持通行密钥'
    return
  }
  passkeyLoading.value = true
  error.value = ''
  try {
    await loginWithPasskey()
    toast.success('登录成功')
    router.push('/home')
  } catch (e: unknown) {
    const err = e as { response?: { data?: { msg?: string } }; message?: string }
    // 用户取消系统认证弹窗时 simplewebauthn 抛 AbortError / NotAllowedError，静默即可
    const msg = err.message || ''
    if (/abort|cancel|notallowed/i.test(msg)) {
      // 用户主动取消，不展示错误
    } else {
      error.value = err.response?.data?.msg || msg || '通行密钥登录失败'
      cooldown.value = true
      setTimeout(() => {
        cooldown.value = false
      }, 2000)
    }
  } finally {
    passkeyLoading.value = false
  }
}
</script>

<template>
  <div class="min-h-screen flex items-center justify-center bg-background px-4">
    <div class="w-full max-w-sm space-y-6">
      <div class="space-y-2 text-center">
        <h1 class="text-2xl font-normal tracking-wide text-foreground">图床</h1>
        <p class="text-sm text-muted-foreground">请输入密码以继续</p>
      </div>
      <form class="space-y-4" @submit.prevent="handleLogin">
        <div class="space-y-2">
          <Label for="login-password">密码</Label>
          <Input
            id="login-password"
            v-model="password"
            type="password"
            placeholder="请输入密码"
            :disabled="loading || passkeyLoading"
          />
        </div>
        <Button type="submit" class="w-full" :disabled="loading || cooldown || passkeyLoading">
          {{ loading ? '登录中...' : cooldown ? '请稍候...' : '登录' }}
        </Button>
        <p v-if="error" class="text-center text-sm text-destructive">{{ error }}</p>
      </form>

      <div class="flex items-center gap-2 text-xs text-muted-foreground">
        <div class="h-px flex-1 bg-border"></div>
        <span>或</span>
        <div class="h-px flex-1 bg-border"></div>
      </div>

      <Button
        variant="outline"
        class="w-full"
        :disabled="passkeyLoading || loading || cooldown"
        @click="handlePasskeyLogin"
      >
        <Fingerprint class="mr-2 h-4 w-4" />
        {{ passkeyLoading ? '请完成认证...' : '使用通行密钥登录' }}
      </Button>
    </div>
  </div>
</template>
