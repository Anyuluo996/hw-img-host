import { ref, computed } from 'vue'
import axios from 'axios'
import { LOGIN_PATH } from '@/router'

const TOKEN_KEY = 'hw_img_host_token'

const token = ref<string | null>(localStorage.getItem(TOKEN_KEY))
const isAuthenticated = computed(() => !!token.value)

axios.interceptors.request.use((config) => {
  if (token.value) {
    config.headers.Authorization = `Bearer ${token.value}`
  }
  return config
})

axios.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      token.value = null
      localStorage.removeItem(TOKEN_KEY)
      window.location.href = LOGIN_PATH
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
