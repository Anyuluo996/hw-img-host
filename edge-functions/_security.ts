// 边缘函数共享的安全辅助纯函数，便于单元测试。
// 不依赖运行时全局，输入输出纯数据。

// N1 SSRF 防护：/img 端点 fetch 的目标必须落在 CNB 存储域名白名单内。
// 防止登录用户写入恶意 urlOriginal（如内网/云元数据端点）后，
// 通过 /img 触发边缘函数 SSRF 探测内网。
export function isAllowedImageHost(urlStr: string, allowedHosts: string[]): boolean {
  try {
    const u = new URL(urlStr)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false
    return allowedHosts.some(
      (h) => u.hostname === h || u.hostname.endsWith('.' + h),
    )
  } catch {
    return false
  }
}

// N2 文件名净化：去掉路径前缀（防 ../ 路径穿越）、控制字符、超长串。
// 仅保留 basename，避免把 fileName 当存储路径时写入非预期位置。
export function sanitizeFileName(name: string): string {
  // 只取最后一段 basename（兼容 / 和 \）
  const base = String(name).split(/[/\\]/).pop() || 'file'
  // 去掉控制字符（含空字符 \x00）
  return base.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200) || 'file'
}
