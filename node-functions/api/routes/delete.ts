import { Router } from 'express'
import { deleteFromCnb } from '../_utils'
import { reply } from '../_reply'
import { authMiddleware } from '../_auth'
import { isValidAssetPath } from '../_validation'

const router = Router()

// 单个删除：删除 CNB 上的实际文件（KV 索引由前端调 /kv-api/{id} 单独删）
// body: { path: string }  // assets.path，形如 /slug/-/imgs/<ID>/<uuid>.png
router.delete('/', authMiddleware, async (req, res) => {
  try {
    const { path } = req.body as { path?: string }
    if (!path) {
      return res.status(400).json(reply(1, '缺少 path 参数'))
    }
    if (!isValidAssetPath(path, process.env.SLUG_IMG || '')) {
      return res.status(400).json(reply(1, '非法路径'))
    }
    const result = await deleteFromCnb(path)
    res.json(reply(0, '删除成功', result))
  } catch (err: unknown) {
    // 服务端日志保留完整错误，客户端只返回通用信息（M2 脱敏）
    console.error('删除失败:', (err as Error).message)
    res.status(500).json(reply(1, '删除失败'))
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
    // 全量校验，有任何非法路径整体拒绝（避免部分删除掩盖越权尝试）
    const invalid = paths.filter((p) => !isValidAssetPath(p, process.env.SLUG_IMG || ''))
    if (invalid.length > 0) {
      return res.status(400).json(reply(1, `存在非法路径，已拒绝（共 ${invalid.length} 条）`))
    }
    const results = await Promise.all(
      paths.map(async (path) => {
        try {
          await deleteFromCnb(path)
          return { path, ok: true }
        } catch (e: unknown) {
          // 单条错误信息保留 message（用于定位哪条失败），但不透传上游 detail
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
    res.status(500).json(reply(1, '批量删除失败'))
  }
})

export default router
