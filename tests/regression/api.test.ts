import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import request from 'supertest'

// 必须在导入 app 前设置环境变量
const PASSWORD = 'test-password-123'
const SECRET = 'test-jwt-secret-456'
const SLUG = 'testuser/repo'

// mock CNB 网络调用，让 HTTP 回归测试不依赖外部服务
vi.mock('../../node-functions/api/_utils', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('../../node-functions/api/_utils')
  return {
    ...actual,
    deleteFromCnb: vi.fn(async (rawPath: string) => {
      // 模拟 CNB：删除成功
      return { ok: true, deletedUrl: `https://api.cnb.cool${rawPath}` }
    }),
    checkDuplicateByHash: vi.fn(async () => null),
    uploadToCnb: vi.fn(async ({ fileBuffer, fileName }: { fileBuffer: Buffer; fileName: string }) => ({
      assets: { path: `/${SLUG}/-/imgs/abc/${fileName}`, __type: 'imgs' },
      url: `/${SLUG}/-/imgs/abc/${fileName}`,
      type: 'imgs' as const,
    })),
  }
})

// 动态导入 app（在 env 设置 + mock 之后）
const app = (await import('../../node-functions/api/[[default]]')).default

describe('HTTP 回归测试：认证与授权', () => {
  const saved = { ...process.env }

  beforeEach(() => {
    process.env.UPLOAD_PASSWORD = PASSWORD
    process.env.JWT_SECRET = SECRET
    process.env.SLUG_IMG = SLUG
  })

  afterEach(() => {
    process.env = { ...saved }
  })

  it('正确密码登录返回 token', async () => {
    const res = await request(app)
      .post('/auth/login')
      .send({ password: PASSWORD })
      .expect(200)
    expect(res.body.code).toBe(0)
    expect(res.body.data.token).toBeTruthy()
    expect(String(res.body.data.token).split('.').length).toBe(3) // JWT 三段
  })

  it('错误密码返回 401', async () => {
    const res = await request(app).post('/auth/login').send({ password: 'wrong' }).expect(401)
    expect(res.body.code).toBe(1)
    expect(res.body.msg).toBe('密码错误')
  })

  it('未配置密码时登录返回 400', async () => {
    delete process.env.UPLOAD_PASSWORD
    const res = await request(app).post('/auth/login').send({ password: 'x' }).expect(400)
    expect(res.body.code).toBe(1)
  })

  it('无 token 访问受保护端点返回 401', async () => {
    await request(app).delete('/delete/').send({ path: '/x' }).expect(401)
  })

  it('有 token 访问受保护端点通过鉴权', async () => {
    const login = await request(app).post('/auth/login').send({ password: PASSWORD })
    const token = login.body.data.token
    // 有 token 但路径非法 → 400（鉴权已通过，被路径校验拦）
    const res = await request(app)
      .delete('/delete/')
      .set('Authorization', `Bearer ${token}`)
      .send({ path: '/illegal' })
    expect(res.status).toBe(400)
    expect(res.body.msg).toBe('非法路径')
  })
})

describe('HTTP 回归测试：H3 删除路径白名单', () => {
  const saved = { ...process.env }

  beforeEach(async () => {
    process.env.UPLOAD_PASSWORD = PASSWORD
    process.env.JWT_SECRET = SECRET
    process.env.SLUG_IMG = SLUG
    const { deleteFromCnb } = await import('../../node-functions/api/_utils')
    vi.mocked(deleteFromCnb).mockClear()
  })
  afterEach(() => {
    process.env = { ...saved }
  })

  async function getToken() {
    const login = await request(app).post('/auth/login').send({ password: PASSWORD })
    return login.body.data.token
  }

  it('合法 imgs 路径删除成功', async () => {
    const token = await getToken()
    const path = `/${SLUG}/-/imgs/abc/uuid.png`
    const res = await request(app)
      .delete('/delete/')
      .set('Authorization', `Bearer ${token}`)
      .send({ path })
    expect(res.body.code).toBe(0)
  })

  it('合法 files 路径删除成功', async () => {
    const token = await getToken()
    const path = `/${SLUG}/-/files/abc/uuid/doc.pdf`
    const res = await request(app)
      .delete('/delete/')
      .set('Authorization', `Bearer ${token}`)
      .send({ path })
    expect(res.body.code).toBe(0)
  })

  it('跨 repo 路径被拒绝（400）', async () => {
    const token = await getToken()
    const res = await request(app)
      .delete('/delete/')
      .set('Authorization', `Bearer ${token}`)
      .send({ path: '/victim/repo/-/imgs/abc/uuid.png' })
    expect(res.status).toBe(400)
    expect(res.body.msg).toBe('非法路径')
  })

  it('批量删除含非法路径整体拒绝', async () => {
    const token = await getToken()
    const res = await request(app)
      .post('/delete/batch')
      .set('Authorization', `Bearer ${token}`)
      .send({
        paths: [`/${SLUG}/-/imgs/abc/x.png`, '/evil/repo/-/imgs/y.png'],
      })
    expect(res.status).toBe(400)
    expect(res.body.msg).toContain('非法路径')
  })

  it('缺少 path 参数返回 400', async () => {
    const token = await getToken()
    const res = await request(app)
      .delete('/delete/')
      .set('Authorization', `Bearer ${token}`)
      .send({})
    expect(res.status).toBe(400)
  })
})

describe('HTTP 回归测试：M2 错误响应脱敏', () => {
  const saved = { ...process.env }

  beforeEach(async () => {
    process.env.UPLOAD_PASSWORD = PASSWORD
    process.env.JWT_SECRET = SECRET
    process.env.SLUG_IMG = SLUG
  })
  afterEach(() => {
    process.env = { ...saved }
  })

  it('删除失败时客户端不含 detail 字段', async () => {
    const { deleteFromCnb } = await import('../../node-functions/api/_utils')
    vi.mocked(deleteFromCnb).mockRejectedValueOnce(new Error('CNB internal: token expired at 2024'))
    const login = await request(app).post('/auth/login').send({ password: PASSWORD })
    const token = login.body.data.token
    const res = await request(app)
      .delete('/delete/')
      .set('Authorization', `Bearer ${token}`)
      .send({ path: `/${SLUG}/-/imgs/abc/x.png` })
    expect(res.status).toBe(500)
    expect(res.body.code).toBe(1)
    expect(res.body.msg).toBe('删除失败')
    // 关键：detail（含上游敏感信息）不应出现在响应体
    expect(res.body).not.toHaveProperty('detail')
    expect(JSON.stringify(res.body)).not.toContain('token expired')
  })
})
