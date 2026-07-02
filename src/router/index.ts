import { createRouter, createWebHistory } from 'vue-router'
import { getToken } from '@/composables/useAuth'

// 登录路径由 KV 动态管理（GET/PUT /api/auth/login-path）。
// 首次部署后，第一个访问受保护页的人会触发 GET /login-path 自动生成路径并跳转（一次性）。
// 之后该端点变 403（已有路径需 JWT），访问受保护页无 token → 回根路径，需手动输入路径。
// 登录时 POST /login 会校验 Referer 里的路径是否匹配 KV 真实值，路径错直接 403。

// 拉取登录路径。仅在 KV 无路径（首次部署）时返回值，之后 403 返回 null。
async function fetchLoginPath(): Promise<string | null> {
  try {
    const res = await fetch('/api/auth/login-path')
    if (!res.ok) return null
    const json = await res.json()
    if (json.code === 0 && json.data?.loginPath) return json.data.loginPath
    return null
  } catch {
    return null
  }
}

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      // 主页对公众隐藏：跳转到随机图端点（复用现有边缘函数 /img，无需新建）。
      path: '/',
      name: 'root',
      component: () => import('../views/RootView.vue'),
    },
    {
      // 上传页（登录后），从原 '/' 迁移到 '/home'，受保护。
      path: '/home',
      name: 'home',
      component: () => import('../views/HomeView.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/gallery',
      name: 'gallery',
      component: () => import('../views/GalleryView.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/tags',
      name: 'tags',
      component: () => import('../views/TagsView.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/assets-keys',
      name: 'assets-keys',
      component: () => import('../views/AssetsKeysView.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/orphan-cleanup',
      name: 'orphan-cleanup',
      component: () => import('../views/OrphanCleanupView.vue'),
      meta: { requiresAuth: true },
    },
    {
      // 通行密钥设备管理（登录后）
      path: '/passkeys',
      name: 'passkeys',
      component: () => import('../views/PasskeysView.vue'),
      meta: { requiresAuth: true },
    },
    {
      // 动态登录路由：任何未知单段路径都匹配到 LoginView。
      // 守卫里验证是否为真实 login_path（非已登录用户访问时才校验）。
      path: '/:loginPath',
      name: 'login',
      component: () => import('../views/LoginView.vue'),
    },
  ],
})

router.beforeEach(async (to, _from, next) => {
  const token = getToken()

  // 受保护页：无 token → 尝试获取登录路径（仅首次部署有效）→ 跳转登录
  // 之后 GET /login-path 变 403（已有路径需 JWT），返回 null → 回主页
  if (to.meta.requiresAuth && !token) {
    const loginPath = await fetchLoginPath()
    if (loginPath) {
      // 首次部署：KV 刚生成路径，跳转过去
      next({ path: `/${loginPath}` })
    } else {
      // 路径已存在（403）或获取失败 → 回主页，用户需手动输入路径
      next({ name: 'root' })
    }
    return
  }

  // 已登录用户访问登录页 → 跳首页
  if (to.name === 'login' && token) {
    next({ name: 'home' })
    return
  }

  next()
})

export default router
