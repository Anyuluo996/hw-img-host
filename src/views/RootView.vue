<script setup lang="ts">
// 主页：随机图 API 使用说明（简洁静态页）。
// 不暴露登录入口、不暴露后台结构。
import { ref } from 'vue'

const copied = ref('')
const examples = [
  { label: '随机一张', url: 'https://cdn.anyul.cn/img' },
  { label: '指定标签', url: 'https://cdn.anyul.cn/img?tag=鸣潮' },
  { label: '多个标签（任一命中）', url: 'https://cdn.anyul.cn/img?tag=鸣潮,原神' },
]

async function copy(url: string) {
  try {
    await navigator.clipboard.writeText(url)
    copied.value = url
    setTimeout(() => {
      if (copied.value === url) copied.value = ''
    }, 1500)
  } catch {
    /* ignore */
  }
}
</script>

<template>
  <div class="min-h-screen bg-background text-foreground">
    <div class="mx-auto max-w-2xl px-6 py-16">
      <h1 class="text-2xl font-normal tracking-wide">随机图 API</h1>
      <p class="mt-2 text-sm text-muted-foreground">
        直接返回图片字节，可作为网页背景、头像、占位图使用。
      </p>

      <div class="mt-8 space-y-3">
        <div
          v-for="ex in examples"
          :key="ex.url"
          class="flex items-center justify-between gap-3 rounded-lg border border-border/50 bg-card px-4 py-3"
        >
          <div class="min-w-0">
            <p class="text-xs text-muted-foreground">{{ ex.label }}</p>
            <code class="block truncate text-sm text-foreground/80">{{ ex.url }}</code>
          </div>
          <button
            class="shrink-0 rounded-md border border-border/50 px-3 py-1.5 text-xs transition hover:bg-muted"
            @click="copy(ex.url)"
          >
            {{ copied === ex.url ? '已复制' : '复制' }}
          </button>
        </div>
      </div>

      <div class="mt-8 space-y-2 text-sm text-muted-foreground">
        <p><span class="text-foreground/70">用法</span>：把链接当作普通图片 URL 即可。</p>
        <pre class="overflow-x-auto rounded-lg bg-muted/40 p-3 text-xs"><code>&lt;img src="https://cdn.anyul.cn/img" /&gt;
background: url('https://cdn.anyul.cn/img?tag=鸣潮');</code></pre>
        <p class="pt-2 text-xs text-muted-foreground/70">每次请求随机返回一张，刷新即换图。</p>
      </div>
    </div>
  </div>
</template>
