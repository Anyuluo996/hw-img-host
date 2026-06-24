import { Router } from 'express'
import { deleteFromCnb, getErrorDetail } from '../_utils'
import { reply } from '../_reply'
import { authMiddleware } from '../_auth'

const router = Router()

// 单个删除：删除 CNB 上的实际文件（KV 索引由前端调 /kv-api/{id} 单独删）
// body: { path: string }  // assets.path，形如 /slug/-/imgs/<ID>/<uuid>.png
router.delete('/', authMiddleware, async (req, res) => {
  try {
    const { path } = req.body as { path?: string }
    if (!path) {
      return res.status(400).json(reply(1, '缺少 path 参数'))
    }
    const result = await deleteFromCnb(path)
    res.json(reply(0, '删除成功', result))
  } catch (err: unknown) {
    const msg = (err as Error).message || '未知错误'
    const detail = getErrorDetail(err)
    console.error('删除失败:', msg, detail)
    res.status(500).json(reply(1, '删除失败', { message: msg, detail }))
  }
})

// 批量删除：body: { paths: string[] }
// 返回每个 path 的删除结果，单条失败不影响其他
router.post('/batch', authMiddleware, async (req, res) => {
  try {
    const { paths } = req.body as { paths?: string[] }
    if (!Array.isArray(paths) || paths.length === 0) {
      return res.status(400).json(reply(1, '缺少 paths 参数'))
    }
    const results = await Promise.all(
      paths.map(async (path) => {
        try {
          await deleteFromCnb(path)
          return { path, ok: true }
        } catch (e: unknown) {
          return { path, ok: false, error: (e as Error).message }
        }
      }),
    )
    const failed = results.filter((r) => !r.ok)
    res.json(
      reply(failed.length === 0 ? 0 : 1, failed.length === 0 ? '全部删除成功' : '部分删除失败', {
        results,
        total: paths.length,
        success: paths.length - failed.length,
        failed: failed.length,
      }),
    )
  } catch (err: unknown) {
    res.status(500).json(reply(1, '批量删除失败', { message: (err as Error).message }))
  }
})

export default router
