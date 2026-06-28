import { timingSafeEqual } from 'node:crypto'
import type { Request, Response } from 'express'

// Assets API 多密钥鉴权：每个服务一把独立密钥，密钥即身份即命名空间。
//
// 配置：环境变量 ASSETS_KEYS = JSON 字符串，形如
//   {"koishi":"k_abc...","script":"k_def..."}
// 未配置时 fail-closed（所有 assets 请求 401）。
//
// 授权模型：key 反查到 service，URL 路径第一段必须等于该 service（强隔离）。
// koishi 的 key 只能操作 koishi/ 下的 key，越权写其他 service → 403。

type KeyMap = Map<string, string> // key → service

// 解析 ASSETS_KEYS。解析失败或为空时返回空 Map（fail-closed）。
function parseKeys(raw: string | undefined): KeyMap {
  const map: KeyMap = new Map()
  if (!raw) return map
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>
    for (const [service, key] of Object.entries(obj)) {
      if (typeof key === 'string' && key.length > 0 && service.length > 0) {
        map.set(key, service)
      }
    }
  } catch {
    // 静默 fail-closed：配置错误不应让密钥泄露或误放行
  }
  return map
}

// 常量时间比较两个等长字符串。长度不等直接返回 false（不泄露长度信息之外的侧信道）。
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

// 从请求头取 X-API-Key 并反查 service。
// 任何失败（缺头、未知 key、配置错误）一律返回 null，调用方应回 401 空响应。
export function checkApiKey(req: Request): string | null {
  const keys = parseKeys(process.env.ASSETS_KEYS)
  if (keys.size === 0) return null // fail-closed
  const provided = req.headers['x-api-key']
  const key = Array.isArray(provided) ? provided[0] : provided
  if (typeof key !== 'string' || key.length === 0) return null

  // 对每个已知 key 做常量时间比较，命中则返回对应 service。
  // 注意：遍历次数 = 已配置 key 数，这是可接受的（密钥数量少）。
  for (const [knownKey, service] of keys) {
    if (safeEqual(key, knownKey)) return service
  }
  return null
}

// 强隔离校验：URL 路径第一段（service）必须等于 key 绑定的 service。
// keyPath 形如 ["koishi","ocr","001.jpg"]，取第一段比较。
export function checkKeyBelongsToService(service: string, keyPath: string[]): boolean {
  if (keyPath.length === 0) return false
  return safeEqual(keyPath[0], service)
}

// 返回空响应（零信息泄露，沿用 proxy 安全风格）。
// 支持的状态：401 鉴权失败 / 403 越权 / 400 参数错 / 413 超限 / 404 不存在。
// 这些都不暴露 msg，调用方只能凭状态码判断。
export function deny(res: Response, status: 400 | 401 | 403 | 404 | 413): Response {
  return res.status(status).end()
}
