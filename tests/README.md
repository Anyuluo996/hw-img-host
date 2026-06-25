# 测试

使用 [vitest](https://vitest.dev) 作为测试框架，[supertest](https://github.com/ladjs/supertest) 做 HTTP 接口回归测试。

## 运行

```bash
pnpm test            # 跑全部测试一次
pnpm test:watch      # 监听模式（开发时用）
pnpm test:coverage   # 覆盖率报告
```

## 结构

```
tests/
├── unit/                  # 单元测试（纯函数，无网络/无 IO）
│   ├── validation.test.ts   # _validation.ts：H3 路径白名单
│   ├── utils.test.ts        # _utils.ts：文件类型判断/路径提取/SHA256
│   ├── auth.test.ts         # _auth.ts：H1 JWT 密钥分离、常量时间比较
│   └── kvapi-helpers.test.ts # kv-api/_helpers.ts：extractKeys/pickOrigin/base64url
└── regression/            # 回归测试（HTTP 接口，mock CNB）
    └── api.test.ts          # 认证/路径白名单/错误脱敏
```

## 测试策略

- **单元测试**覆盖纯函数逻辑：把边缘函数/node 函数里的纯逻辑提取到 `_validation.ts`、`_helpers.ts`，避免依赖运行时全局（`img_kv`、`Request`）。
- **回归测试**用 supertest 挂载 express app，mock 掉 CNB 网络调用（`deleteFromCnb`/`uploadToCnb`/`checkDuplicateByHash`），专注验证 HTTP 层行为。
- **安全断言**：回归测试显式断言「响应不含 detail」「跨 repo 路径被拒」「密码泄露不能伪造 token」等安全属性，防止安全修复被无意回退。

## 对应的安全修复

| 修复 | 测试 |
|------|------|
| H1 JWT 密钥分离 | `auth.test.ts` → 密码泄露 ≠ 能伪造 token |
| H3 路径白名单 | `validation.test.ts` + `api.test.ts` → 跨 repo 拒绝 |
| M2 错误脱敏 | `api.test.ts` → 响应不含 detail / token 信息 |
| M3 CORS 收紧 | `kvapi-helpers.test.ts` → pickOrigin 白名单匹配 |
