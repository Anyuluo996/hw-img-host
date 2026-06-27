import { createRouter, createWebHistory } from 'vue-router'
import { getToken } from '@/composables/useAuth'

// 登录页改用复杂字符串路径，避免主页暴露登录入口被爆破。
// 登出 / token 失效后回到主页（随机图），不向未授权访客暴露登录表单。
export const LOGIN_PATH = '/GfkcokTNJ5d3JzIerGZ7'

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
      // 秘密登录路径，不主动暴露。
      path: LOGIN_PATH,
      name: 'login',
      component: () => import('../views/LoginView.vue'),
    },
    {
      // 未匹配的任何路径都回主页（随机图），避免暴露 SPA 结构。
      path: '/:pathMatch(.*)*',
      redirect: '/',
    },
  ],
})

router.beforeEach((to, _from, next) => {
  const token = getToken()
  if (to.meta.requiresAuth && !token) {
    // 未授权访问受保护页：回主页（随机图），不暴露登录入口。
    next({ name: 'root' })
  } else if (to.name === 'login' && token) {
    next({ name: 'home' })
  } else {
    next()
  }
})

export default router
