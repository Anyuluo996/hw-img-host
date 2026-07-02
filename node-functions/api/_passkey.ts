import jwt from 'jsonwebtoken'
import { randomBytes } from 'node:crypto'
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type VerifiedRegistrationResponse,
  type VerifiedAuthenticationResponse,
} from '@simplewebauthn/server'

/**
 * 通行密钥（WebAuthn）支持
 *
 * 设计要点：
 * - 凭证存储在 EdgeOne KV（node 无法直连 img_kv，走 HTTP 回环）。
 * - 单聚合 key `passkeys` = {ver, items} 作为唯一真相源，避开最终一致性竞态。
 * - challenge 存 `pkch_{nonce}` 单 key，内嵌过期时间，懒清理。
 * - 验证用 @simplewebauthn/server（COSE/CBOR/签名一键搞定）。
 */

// ---------- 类型 ----------

export interface PasskeyCredential {
  /** base64url 编码的 credential id */
  id: string
  /** base64url 编码的 SPKI 公钥（verifyRegistrationResponse.credential.publicKey） */
  publicKey: string
  /** 签名计数器，防克隆 */
  counter: number
  /** 设备传输方式（usb/nfc/ble/internal...），用于登录时提示 */
  transports: string[]
  /** 用户起的名称，如 "MacBook" */
  name?: string
  createdAt: string
}

interface CredentialStore {
  ver: number
  items: PasskeyCredential[]
}

interface StoredChallenge {
  challenge: string
  expiresAt: number
}

// ---------- 常量 ----------

const CHALLENGE_TTL_MS = 5 * 60 * 1000

// ---------- RP 配置 ----------

/**
 * 从 BASE_IMG_URL 解析 WebAuthn RP 配置。
 * rpID 必须是 hostname（不含端口/路径），expectedOrigin 是完整 origin（含协议端口）。
 *
 * WebAuthn 对 localhost 放行（http 也可用），生产必须 https。
 */
export function getRpConfig(): { rpID: string; expectedOrigin: string[] } {
  const base = (process.env.BASE_IMG_URL || '').trim().replace(/\/$/, '')
  if (!base) throw new Error('BASE_IMG_URL 未配置，无法启用通行密钥')

  let origin = base
  // 兼容用户填了不带协议的域名
  if (!/^https?:\/\//i.test(origin)) origin = `https://${origin}`
  const u = new URL(origin)
  const rpID = u.hostname

  // 允许的 origin：生产域名 + 本地 dev 端口（vue+vite 5173，preview 4173）
  const expectedOrigin = [`${u.protocol}//${u.host}`]
  if (rpID !== 'localhost') {
    expectedOrigin.push('http://localhost:5173', 'http://localhost:4173')
  }
  return { rpID, expectedOrigin }
}

// ---------- KV 回环（node → edge HTTP fetch） ----------

function selfSignToken(): string {
  const secret = process.env.JWT_SECRET || process.env.UPLOAD_PASSWORD
  if (!secret) throw new Error('JWT_SECRET 或 UPLOAD_PASSWORD 未配置')
  return jwt.sign({}, secret, { expiresIn: '5m' })
}

function baseUrl(): string {
  const b = (process.env.BASE_IMG_URL || '').replace(/\/$/, '')
  if (!b) throw new Error('BASE_IMG_URL 未配置')
  return b
}

async function callEdge(path: string, init: RequestInit = {}): Promise<globalThis.Response> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 15000)
  try {
    return await fetch(`${baseUrl()}/kv-api/webauthn${path}`, {
      ...init,
      headers: { ...(init.headers || {}), Authorization: `Bearer ${selfSignToken()}` },
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeoutId)
  }
}

async function callEdgeJson<T>(path: string, init?: RequestInit): Promise<T | null> {
  try {
    const r = await callEdge(path, init)
    if (!r.ok) return null
    const json = (await r.json()) as { code: number; data?: T }
    return json.code === 0 ? (json.data as T) : null
  } catch {
    return null
  }
}

// ---------- 凭证读写 ----------

export async function listCredentials(): Promise<PasskeyCredential[]> {
  const store = await callEdgeJson<CredentialStore>('')
  return store?.items || []
}

/**
 * 保存凭证列表（整体替换）。带 ver 乐观并发：失败自动重试 reread-merge-rewrite。
 * 凭证总数极小（通常 <10），冲突概率极低。
 */
async function saveCredentialsWithMerge(
  mutator: (current: PasskeyCredential[]) => PasskeyCredential[],
): Promise<CredentialStore> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = await callEdgeJson<CredentialStore>('')
    const ver = current?.ver ?? 0
    const items = current?.items ?? []
    const next = mutator(items)
    const r = await callEdge('', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ver, items: next }),
    })
    const json = (await r.json()) as { code: number }
    if (json.code === 0) {
      return { ver: ver + 1, items: next }
    }
    // ver 不匹配 → 并发冲突，重试
  }
  throw new Error('保存通行密钥失败（并发冲突）')
}

export async function addCredential(cred: PasskeyCredential): Promise<void> {
  await saveCredentialsWithMerge((items) => [...items, cred])
}

export async function removeCredential(id: string): Promise<boolean> {
  let removed = false
  await saveCredentialsWithMerge((items) => {
    const next = items.filter((c) => c.id !== id)
    removed = next.length !== items.length
    return next
  })
  return removed
}

/** 更新登录后的 counter（防克隆）。失败不阻断登录。 */
export async function updateCounter(id: string, newCounter: number): Promise<void> {
  try {
    await saveCredentialsWithMerge((items) =>
      items.map((c) => (c.id === id ? { ...c, counter: Math.max(c.counter, newCounter) } : c)),
    )
  } catch {
    // counter 更新失败不阻断登录流程
  }
}

// ---------- challenge 读写 ----------

function randomNonce(): string {
  return randomBytes(16).toString('hex')
}

export async function storeChallenge(challenge: string): Promise<string> {
  const nonce = randomNonce()
  const ok = await callEdgeJson<boolean>(`/challenge/${nonce}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challenge, expiresAt: Date.now() + CHALLENGE_TTL_MS }),
  })
  if (!ok) throw new Error('存储 challenge 失败')
  return nonce
}

/** 取出并立即删除 challenge（一次性使用）。过期返回 null。 */
export async function consumeChallenge(nonce: string): Promise<string | null> {
  const stored = await callEdgeJson<StoredChallenge>(`/challenge/${nonce}`)
  // 删除（不管是否过期）—— callEdgeJson 内部已 catch，不会再抛
  await callEdgeJson(`/challenge/${nonce}`, { method: 'DELETE' })
  if (!stored) return null
  if (stored.expiresAt < Date.now()) return null
  return stored.challenge
}

// ---------- WebAuthn 流程 ----------

/**
 * 开始注册。返回 PublicKeyCredentialCreationOptions JSON（前端直接传给 startRegistration）。
 * excludeExisting 防止同一 authenticator 重复注册。
 */
export async function beginRegistration(name?: string) {
  const { rpID } = getRpConfig()
  const existing = await listCredentials()
  const options = await generateRegistrationOptions({
    rpName: '图床',
    rpID,
    userName: 'admin',
    userDisplayName: name || '管理员',
    attestationType: 'none',
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'preferred',
    },
    excludeCredentials: existing.map((c) => ({
      id: c.id,
      type: 'public-key',
      transports: c.transports as AuthenticatorTransport[],
    })),
  })
  const nonce = await storeChallenge(options.challenge)
  return { options, nonce }
}

/**
 * 验证注册响应，返回新凭证（未持久化，由调用方 addCredential）。
 */
export async function verifyRegistration(
  resp: unknown,
  expectedChallenge: string,
): Promise<PasskeyCredential> {
  const { rpID, expectedOrigin } = getRpConfig()
  let verification: VerifiedRegistrationResponse
  try {
    verification = await verifyRegistrationResponse({
      response: resp as Parameters<typeof verifyRegistrationResponse>[0]['response'],
      expectedChallenge,
      expectedOrigin,
      expectedRPID: rpID,
    })
  } catch (e) {
    throw new Error(`注册验证失败：${(e as Error).message}`)
  }
  if (!verification.verified || !verification.registrationInfo) {
    throw new Error('注册验证未通过')
  }
  const info = verification.registrationInfo
  return {
    id: info.credential.id,
    publicKey: info.credential.publicKey,
    counter: info.credential.counter,
    transports: (info.credential.transports || []) as string[],
    createdAt: new Date().toISOString(),
  }
}

/**
 * 开始认证。返回 PublicKeyCredentialRequestOptions JSON（前端直接传给 startAuthentication）。
 * allowCredentials 列出全部已注册凭证，让 authenticator 选择。
 */
export async function beginAuthentication() {
  const { rpID } = getRpConfig()
  const existing = await listCredentials()
  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: 'preferred',
    allowCredentials: existing.map((c) => ({
      id: c.id,
      type: 'public-key',
      transports: c.transports as AuthenticatorTransport[],
    })),
  })
  const nonce = await storeChallenge(options.challenge)
  return { options, nonce }
}

/**
 * 验证认证响应，返回命中的 credential id + 新 counter。失败抛错。
 */
export async function verifyAuthentication(
  resp: unknown,
  expectedChallenge: string,
): Promise<{ credentialId: string; newCounter: number }> {
  const { rpID, expectedOrigin } = getRpConfig()
  const existing = await listCredentials()
  const credMap = new Map(existing.map((c) => [c.id, c]))

  // response.id 标识用户用了哪个凭证，据此取出对应的公钥和 counter
  const respObj = resp as { id?: string }
  const credId = respObj.id
  if (!credId) throw new Error('认证响应缺少 credential id')
  const cred = credMap.get(credId)
  if (!cred) throw new Error('未找到匹配的凭证')

  let verification: VerifiedAuthenticationResponse
  try {
    verification = await verifyAuthenticationResponse({
      response: resp as Parameters<typeof verifyAuthenticationResponse>[0]['response'],
      expectedChallenge,
      expectedOrigin,
      expectedRPID: rpID,
      credential: {
        id: cred.id,
        publicKey: cred.publicKey,
        counter: cred.counter,
        transports: cred.transports as AuthenticatorTransport[],
      },
    })
  } catch (e) {
    throw new Error(`认证验证失败：${(e as Error).message}`)
  }
  if (!verification.verified) throw new Error('认证验证未通过')
  return {
    credentialId: cred.id,
    newCounter: verification.authenticationInfo.newCounter,
  }
}
