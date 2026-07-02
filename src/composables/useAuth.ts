import { ref, computed } from 'vue'
import axios from 'axios'
import { startRegistration, startAuthentication } from '@simplewebauthn/browser'

const TOKEN_KEY = 'hw_img_host_token'

const token = ref<string | null>(localStorage.getItem(TOKEN_KEY))
const isAuthenticated = computed(() => !!token.value)

axios.interceptors.request.use((config) => {
  if (token.value) {
    config.headers.Authorization = `Bearer ${token.value}`
  }
  return config
})

// 401 时清除 token，跳转主页（登录路径是秘密，不自动跳转登录页）
axios.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      token.value = null
      localStorage.removeItem(TOKEN_KEY)
      window.location.href = '/'
    }
    return Promise.reject(error)
  },
)

function storeToken(t: string) {
  token.value = t
  localStorage.setItem(TOKEN_KEY, t)
}

function authHeaders(): Record<string, string> {
  const t = localStorage.getItem(TOKEN_KEY)
  return t ? { Authorization: `Bearer ${t}` } : {}
}

async function login(password: string): Promise<void> {
  const res = await axios.post('/api/auth/login', { password })
  if (res.data.code === 0) {
    storeToken(res.data.data.token)
  } else {
    throw new Error(res.data.msg || '登录失败')
  }
}

/** 通行密钥登录：begin → navigator.credentials.get → verify → 存 token */
async function loginWithPasskey(): Promise<void> {
  // 1. 取 options
  const beginRes = await axios.post('/api/auth/passkey/login/begin')
  if (beginRes.data.code !== 0) throw new Error(beginRes.data.msg || '登录初始化失败')
  const { options, nonce } = beginRes.data.data
  // 2. 调用 authenticator
  const cred = await startAuthentication({ optionsJSON: options })
  // 3. 验证
  const verifyRes = await axios.post('/api/auth/passkey/login/verify', { resp: cred, nonce })
  if (verifyRes.data.code === 0) {
    storeToken(verifyRes.data.data.token)
  } else {
    throw new Error(verifyRes.data.msg || '通行密钥验证失败')
  }
}

function logout() {
  token.value = null
  localStorage.removeItem(TOKEN_KEY)
}

// ====== 通行密钥设备管理（需登录） ======

export interface PasskeyItem {
  id: string
  publicKey: string
  counter: number
  transports: string[]
  name?: string
  createdAt: string
}

async function listPasskeys(): Promise<PasskeyItem[]> {
  const res = await fetch('/api/auth/passkey/list', { headers: authHeaders() })
  const json = await res.json()
  if (json.code !== 0) throw new Error(json.msg || '获取列表失败')
  return json.data.items
}

/** 注册新通行密钥（需已登录会话）。name 可选。 */
async function registerPasskey(name?: string): Promise<void> {
  const beginRes = await fetch('/api/auth/passkey/register/begin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ name }),
  })
  const beginJson = await beginRes.json()
  if (beginJson.code !== 0) throw new Error(beginJson.msg || '注册初始化失败')
  const { options, nonce } = beginJson.data
  const cred = await startRegistration({ optionsJSON: options })
  const verifyRes = await fetch('/api/auth/passkey/register/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ resp: cred, nonce, name }),
  })
  const verifyJson = await verifyRes.json()
  if (verifyJson.code !== 0) throw new Error(verifyJson.msg || '注册验证失败')
}

async function removePasskey(id: string): Promise<void> {
  const res = await fetch(`/api/auth/passkey/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: authHeaders(),
  })
  const json = await res.json()
  if (json.code !== 0) throw new Error(json.msg || '删除失败')
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export function useAuth() {
  return {
    token,
    isAuthenticated,
    login,
    loginWithPasskey,
    logout,
    listPasskeys,
    registerPasskey,
    removePasskey,
  }
}
