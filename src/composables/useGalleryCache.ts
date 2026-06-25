import { ref } from 'vue'

// 图库列表的全局缓存。
// 解决：每次打开图库都全量扫描 KV（list翻页 + get×N），数据多了首次加载慢。
// 思路：首次加载后存 localStorage，下次秒开；通过版本戳 + 跨标签页 storage 事件打脏缓存。

export interface ImageRecord {
  id: string
  url: string
  thumbnailUrl?: string
  urlOriginal?: string
  thumbnailOriginalUrl?: string
  name: string
  size: number
  type: string
  width: number
  height: number
  hasThumbnail: boolean
  thumbnailWidth: number
  thumbnailSize: number
  thumbnailHeight: number
  compressionRatio: number
  createdAt: string
  assetsPath?: string
  tags?: string[]
  // 旧记录可能没有，兼容字段
  _key?: string
}

const CACHE_KEY = 'hw_gallery_cache'
const VERSION_KEY = 'hw_gallery_version'

// 版本号：任何写入/删除/改tag 都递增它，让缓存失效。
// 跨标签页用 storage 事件同步（同一浏览器多标签场景），
// 同标签页用自定义事件 + 模块级 ref 同步（HomeView 上传 → GalleryView）。
const version = ref(Number(localStorage.getItem(VERSION_KEY)) || 0)

function bumpVersion() {
  version.value += 1
  localStorage.setItem(VERSION_KEY, String(version.value))
  // 同标签页内通知（storage 事件不触发本标签）
  window.dispatchEvent(new CustomEvent('gallery-cache-invalidated'))
}

function readCache(): ImageRecord[] | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr : null
  } catch {
    return null
  }
}

function writeCache(images: ImageRecord[]) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(images))
  } catch {
    // localStorage 满了或记录过大，静默失败（不影响功能，只是下次不缓存）
  }
}

function clearCache() {
  localStorage.removeItem(CACHE_KEY)
}

export function useGalleryCache() {
  return {
    version,
    bumpVersion,
    readCache,
    writeCache,
    clearCache,
  }
}
