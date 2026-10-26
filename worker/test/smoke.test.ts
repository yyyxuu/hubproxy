import { describe, expect, it } from 'vitest'
import { buildHandler } from '../src/index'
import type { Env, FetchLike } from '../src/types'

// 冒烟测试：验证测试环境可用、buildHandler 已装配真实路由（/ready 健康检查可达）。
// 注意：Task 1 桩已由 Task 7 的路由装配替换，/ready 不再返回 404。
// 内存假 KV：Env 类型要求 TOKENS/MANIFESTS 绑定，用 unknown 断言对齐 KVNamespace
function makeFakeKV(): KVNamespace {
  const store = new Map<string, string>()
  const kv = {
    get: (key: string) => Promise.resolve(store.get(key) ?? null),
    put: (key: string, value: string, _opts?: { expirationTtl?: number }) => {
      store.set(key, value)
      return Promise.resolve()
    },
  }
  return kv as unknown as KVNamespace
}

describe('worker 脚手架', () => {
  it('buildHandler 装配后 /ready 返回 200 健康检查 JSON', async () => {
    const fetchFn: FetchLike = async () => new Response('x', { status: 200 })
    const handler = buildHandler(fetchFn)
    const env: Env = { TOKENS: makeFakeKV(), MANIFESTS: makeFakeKV() }
    const response = await handler(new Request('https://example.com/ready'), env)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ready: true, service: 'hubproxy-worker' })
  })
})
