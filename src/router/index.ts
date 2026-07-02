import { createRouter, createWebHistory } from 'vue-router'
import { getToken } from '@/composables/useAuth'

// 登录路径由 KV 动态管理（GET/PUT /api/auth/login-path）。
// 注意：前端不主动触发初始化，也不校验路径值——登录页是 catch-all（任意单段路径都渲染表单），
// 真实安全靠后端密码 + IP 限速。login_path 仅作可选秘密值，需管理员手动 curl 才会首次生成。

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

router.beforeEach((to, _from, next) => {
  const token = getToken()

  // 受保护页：无 token → 回主页（不跳登录，登录路径是秘密）
  // 用户需要直接输入登录路径 URL 才能访问登录页
  if (to.meta.requiresAuth && !token) {
    next({ name: 'root' })
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
