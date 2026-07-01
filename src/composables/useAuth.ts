import { ref, computed } from 'vue'
import axios from 'axios'

const TOKEN_KEY = 'hw_img_host_token'

const token = ref<string | null>(localStorage.getItem(TOKEN_KEY))
const isAuthenticated = computed(() => !!token.value)

axios.interceptors.request.use((config) => {
  if (token.value) {
    config.headers.Authorization = `Bearer ${token.value}`
  }
  return config
})

// 401 时清除 token，异步获取动态登录路径后跳转（不再硬编码）
axios.interceptors.response.use(
  (response) => response,
  async (error) => {
    if (error.response?.status === 401) {
      token.value = null
      localStorage.removeItem(TOKEN_KEY)
      try {
        const res = await fetch('/api/auth/login-path')
        const json = await res.json()
        if (json.code === 0 && json.data?.loginPath) {
          window.location.href = `/${json.data.loginPath}`
        } else {
          window.location.href = '/'
        }
      } catch {
        window.location.href = '/'
      }
    }
    return Promise.reject(error)
  },
)

async function login(password: string): Promise<void> {
  const res = await axios.post('/api/auth/login', { password })
  if (res.data.code === 0) {
    token.value = res.data.data.token
    localStorage.setItem(TOKEN_KEY, res.data.data.token)
  } else {
    throw new Error(res.data.msg || '登录失败')
  }
}

function logout() {
  token.value = null
  localStorage.removeItem(TOKEN_KEY)
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export function useAuth() {
  return { token, isAuthenticated, login, logout }
}
