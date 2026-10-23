import { describe, expect, it } from 'vitest'
import { buildHandler } from '../src/index'
import type { Env, FetchLike } from '../src/types'

// ---------- 测试辅助 ----------

// 内存假 KV：实现 get/put，通过 unknown 断言对齐 KVNamespace
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

// 构造 Env：TOKENS/MANIFESTS 为真实可交互的假 KV，可覆盖任意 var（如 IP_BLACKLIST）
function makeEnv(overrides: Partial<Env> = {}): Env {
  return { TOKENS: makeFakeKV(), MANIFESTS: makeFakeKV(), ...overrides }
}

// 按上游主机路由的 mock fetchFn：auth.docker.io / registry-1.docker.io / github.com / raw.githubusercontent.com
// 各返回合适假响应，其余主机 404；同时记录收到的上游 URL（全程无真实网络）
function makeRoutedFetch() {
  const calls: Array<{ url: string }> = []
  const fetchFn: FetchLike = async input => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    calls.push({ url })
    const hostname = new URL(url).hostname
    if (hostname === 'auth.docker.io') {
      return new Response('{"token":"t1"}', { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (hostname === 'registry-1.docker.io') {
      return new Response('{}', {
        status: 200,
        headers: { 'Content-Type': 'application/vnd.docker.distribution.manifest.v2+json' },
      })
    }
    if (hostname === 'github.com' || hostname === 'raw.githubusercontent.com') {
      return new Response('release-data', {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': '12' },
      })
    }
    return new Response('not found', { status: 404 })
  }
  return { calls, fetchFn }
}

// ---------- 路由装配（集成测试） ----------

describe('buildHandler 路由装配', () => {
  it('GET /ready → 200 JSON：ready true、service hubproxy-worker', async () => {
    const handler = buildHandler(makeRoutedFetch().fetchFn)
    const response = await handler(new Request('https://hub.example.com/ready'), makeEnv())
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toContain('application/json')
    await expect(response.json()).resolves.toEqual({ ready: true, service: 'hubproxy-worker' })
  })

  it('GET /v2/ → 401 + Bearer challenge（本地应答，不访问上游）', async () => {
    const { calls, fetchFn } = makeRoutedFetch()
    const handler = buildHandler(fetchFn)
    const response = await handler(new Request('https://hub.example.com/v2/'), makeEnv())
    expect(response.status).toBe(401)
    expect(response.headers.get('Docker-Distribution-Api-Version')).toBe('registry/2.0')
    expect(response.headers.get('WWW-Authenticate')).toBe(
      'Bearer realm="https://hub.example.com/token",service="registry.docker.io"',
    )
    expect(calls).toHaveLength(0)
  })

  it('GET /v2（无斜杠）同样路由到 registry 代理', async () => {
    const { fetchFn } = makeRoutedFetch()
    const handler = buildHandler(fetchFn)
    const response = await handler(new Request('https://hub.example.com/v2'), makeEnv())
    expect(response.status).toBe(401)
    expect(response.headers.get('Docker-Distribution-Api-Version')).toBe('registry/2.0')
    expect(response.headers.get('WWW-Authenticate')).toContain('realm="https://hub.example.com/token"')
  })

  it('GET /token?service=...&scope=... → 200 token JSON，query 原样透传给 auth.docker.io', async () => {
    const { calls, fetchFn } = makeRoutedFetch()
    const handler = buildHandler(fetchFn)
    const request = new Request(
      'https://hub.example.com/token?service=registry.docker.io&scope=repository:library/nginx:pull',
    )
    const response = await handler(request, makeEnv())
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ token: 't1' })
    expect(calls[0].url).toBe(
      'https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/nginx:pull',
    )
  })

  it('GET /token（无斜杠）同样路由到 token 换发', async () => {
    const { calls, fetchFn } = makeRoutedFetch()
    const handler = buildHandler(fetchFn)
    const request = new Request('https://hub.example.com/token?service=registry.docker.io&scope=repository:a/b:pull')
    const response = await handler(request, makeEnv())
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ token: 't1' })
    expect(calls[0].url).toBe(
      'https://auth.docker.io/token?service=registry.docker.io&scope=repository:a/b:pull',
    )
  })

  it('GET /https://github.com/.../releases/download/... → 200 转发，上游为 github.com', async () => {
    const { calls, fetchFn } = makeRoutedFetch()
    const handler = buildHandler(fetchFn)
    const response = await handler(
      new Request('https://hub.example.com/https://github.com/owner/repo/releases/download/v1/x'),
      makeEnv(),
    )
    expect(response.status).toBe(200)
    expect(calls[0].url).toBe('https://github.com/owner/repo/releases/download/v1/x')
    await expect(response.text()).resolves.toBe('release-data')
  })

  it('GET /https://example.com/x → 403（非 GitHub 主机）', async () => {
    const handler = buildHandler(makeRoutedFetch().fetchFn)
    const response = await handler(new Request('https://hub.example.com/https://example.com/x'), makeEnv())
    expect(response.status).toBe(403)
  })

  it('GET /foo/bar（无法识别路径）→ 走 GitHub catch-all → 403（非 GitHub 主机）', async () => {
    const handler = buildHandler(makeRoutedFetch().fetchFn)
    const response = await handler(new Request('https://hub.example.com/foo/bar'), makeEnv())
    expect(response.status).toBe(403)
  })
})

// ---------- 入口 IP 黑名单拦截（Ruling B，spec §4.4 的消费点） ----------

describe('buildHandler 入口 IP 黑名单拦截', () => {
  it('CF-Connecting-IP 命中黑名单 → 403 且返回理由', async () => {
    const handler = buildHandler(makeRoutedFetch().fetchFn)
    const env = makeEnv({ IP_BLACKLIST: '203.0.113.5' })
    const request = new Request('https://hub.example.com/ready', {
      headers: { 'CF-Connecting-IP': '203.0.113.5' },
    })
    const response = await handler(request, env)
    expect(response.status).toBe(403)
    await expect(response.text()).resolves.toBe('IP 在黑名单中')
  })

  it('无 CF-Connecting-IP 时取 X-Forwarded-For 首项，命中黑名单 → 403', async () => {
    const handler = buildHandler(makeRoutedFetch().fetchFn)
    const env = makeEnv({ IP_BLACKLIST: '203.0.113.5' })
    const request = new Request('https://hub.example.com/ready', {
      headers: { 'X-Forwarded-For': '203.0.113.5, 10.0.0.1' },
    })
    const response = await handler(request, env)
    expect(response.status).toBe(403)
  })

  it('IP 不在黑名单 → 放行并正常路由到 /ready', async () => {
    const handler = buildHandler(makeRoutedFetch().fetchFn)
    const env = makeEnv({ IP_BLACKLIST: '203.0.113.5' })
    const request = new Request('https://hub.example.com/ready', {
      headers: { 'CF-Connecting-IP': '192.0.2.1' },
    })
    const response = await handler(request, env)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ready: true, service: 'hubproxy-worker' })
  })

  it('无任何客户端 IP 头 → 放行', async () => {
    const handler = buildHandler(makeRoutedFetch().fetchFn)
    const env = makeEnv({ IP_BLACKLIST: '203.0.113.5' })
    const response = await handler(new Request('https://hub.example.com/ready'), env)
    expect(response.status).toBe(200)
  })
})
