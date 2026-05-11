<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuth } from '@/composables/useAuth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { toast } from 'vue-sonner'

const router = useRouter()
const { login } = useAuth()

const password = ref('')
const loading = ref(false)
const error = ref('')

async function handleLogin() {
  if (!password.value) return
  loading.value = true
  error.value = ''
  try {
    await login(password.value)
    toast.success('登录成功')
    router.push('/')
  } catch (e: unknown) {
    const err = e as { response?: { data?: { msg?: string } }; message?: string }
    error.value = err.response?.data?.msg || err.message || '登录失败'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="min-h-screen flex items-center justify-center bg-background px-4">
    <div class="w-full max-w-sm space-y-6">
      <div class="space-y-2 text-center">
        <h1 class="text-2xl font-normal tracking-wide text-foreground">HW 图床</h1>
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
            :disabled="loading"
          />
        </div>
        <Button type="submit" class="w-full" :disabled="loading">
          {{ loading ? '登录中...' : '登录' }}
        </Button>
        <p v-if="error" class="text-center text-sm text-destructive">{{ error }}</p>
      </form>
    </div>
  </div>
</template>
