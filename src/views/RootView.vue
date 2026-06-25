<script setup lang="ts">
// 主页对公众隐藏：直接跳转到现有的随机图边缘函数 /img。
// /img 已直接返回图片字节（浏览器内显示），无需新建边缘函数。
// 用 replace，避免在历史里留下 / 这一步。
import { onMounted } from 'vue'

onMounted(() => {
  window.location.replace('/img')
})
</script>

<template>
  <div class="flex min-h-screen items-center justify-center">
    <p class="text-sm text-muted-foreground">…</p>
  </div>
</template>
