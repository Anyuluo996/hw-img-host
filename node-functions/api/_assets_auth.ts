import { timingSafeEqual } from 'node:crypto'
import jwt from 'jsonwebtoken'
import type { Request, Response } from 'express'

// Assets API 多密钥鉴权：每个服务一把独立密钥，密钥即身份即命名空间。
//
// 密钥存储（两级）：
//   1. KV 密钥库（ak_{name} / akidx_all）—— 页面增删，即时生效
//   2. 环境变量 ASSETS_KEYS（fallback）—— 兼容已部署的 test 密钥
//
// 授权模型：key 反查到 service，URL 路径第一段必须等于该 service（强隔离）。
// koishi 的 key 只能操作 koishi/ 下的 key，越权写其他 service → 403。
//
// 注意：node 无法直接访问 img_kv 绑定，所以密钥查询走 edge assets-api 的
// /resolve-service 端点（JWT 自签，与 _utils.checkDuplicateByHash 同机制）。

// 调用边缘 assets-api 反查 service。返回 service 名或 null。
async function resolveServiceEdge(providedKey: string): Promise<string | null> {
  const baseUrl = (process.env.BASE_IMG_URL || '').replace(/\/$/, '')
  const secret = process.env.JWT_SECRET || process.env.UPLOAD_PASSWORD
  if (!baseUrl || !secret) return null
  const token = jwt.sign({}, secret, { expiresIn: '5m' })
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 10000)
  try {
    const res = await fetch(`${baseUrl}/assets-api/resolve-service`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ key: providedKey }),
      signal: controller.signal,
    })
    if (!res.ok) return null
    const json = (await res.json()) as { code: number; data?: { service: string | null } }
    if (json.code !== 0) return null
    return json.data?.service || null
  } catch {
    return null // edge 不可用时 fail-closed（不 fallback 到本地环境变量查询，避免不一致）
  } finally {
    clearTimeout(timeoutId)
  }
}

// 从请求头取 X-API-Key 并反查 service（走 edge，支持 KV + 环境变量两级）。
// 任何失败（缺头、未知 key、edge 不可用）一律返回 null，调用方应回 401 空响应。
export async function checkApiKey(req: Request): Promise<string | null> {
  const provided = req.headers['x-api-key']
  const key = Array.isArray(provided) ? provided[0] : provided
  if (typeof key !== 'string' || key.length === 0) return null
  return resolveServiceEdge(key)
}

// 返回空响应（零信息泄露，沿用 proxy 安全风格）。
// 支持的状态：401 鉴权失败 / 403 越权 / 400 参数错 / 413 超限 / 404 不存在。
// 这些都不暴露 msg，调用方只能凭状态码判断。
export function deny(res: Response, status: 400 | 401 | 403 | 404 | 413): Response {
  return res.status(status).end()
}
