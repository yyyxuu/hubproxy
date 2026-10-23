import { describe, expect, it } from 'vitest'
import { buildHandler } from '../src/index'
import type { Env } from '../src/types'

// 冒烟测试：验证 vitest 测试环境可用，桩 handler 对任意请求返回 404
describe('worker 脚手架', () => {
  it('对任意请求返回 404', async () => {
    const fetchFn = async () => new Response('x', { status: 200 })
    const handler = buildHandler(fetchFn)
    const env = {} as Env
    const response = await handler(new Request('https://example.com/'), env)
    expect(response.status).toBe(404)
  })
})
