import { createRouter, createWebHistory } from 'vue-router'
import { getToken } from '@/composables/useAuth'

// 登录路径不再硬编码，改为 KV 动态管理：
// 首次访问受保护页时，守卫调 GET /api/auth/login-path 获取（无则随机生成写入 KV），
// 然后跳转到该路径。改路径 = PUT /api/auth/login-path 重置。

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
