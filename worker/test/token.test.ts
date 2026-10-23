import { describe, expect, it } from 'vitest'
import { findAuthHost, handleTokenRequest } from '../src/docker/token'
import { getCachedToken } from '../src/utils/cache'
import { loadConfig } from '../src/config'
import type { Env, FetchLike } from '../src/types'

// 内存假 KV：实现 get/put 并记录写入内容，通过 unknown 断言对齐 KVNamespace
function makeFakeKV() {
  const store = new Map<string, string>()
  const kv = {
    get: (key: string) => Promise.resolve(store.get(key) ?? null),
    put: (key: string, value: string, _opts?: { expirationTtl?: number }) => {
      store.set(key, value)
      return Promise.resolve()
    },
  }
  return { kv: kv as unknown as KVNamespace, store }
}

// 构造带内存假 KV 的 Env（TOKENS 为真实可交互的假 KV）
function makeEnv() {
  const tokens = makeFakeKV()
  const env: Env = { TOKENS: tokens.kv, MANIFESTS: makeFakeKV().kv }
  return { env, tokens }
}

// mock fetchFn：记录收到的上游请求（URL 与请求头），返回预设响应
function makeFetch(response: Response) {
  const calls: Array<{ url: string; headers: Headers }> = []
  const fetchFn: FetchLike = async input => {
    const req = input instanceof Request ? input : new Request(input)
    calls.push({ url: req.url, headers: req.headers })
    return response
  }
  return { calls, fetchFn }
}

describe('findAuthHost', () => {
  const cfg = loadConfig(makeEnv().env)

  it('registry.docker.io 与 registry-1.docker.io 固定映射到 docker 官方 auth', () => {
    expect(findAuthHost('registry.docker.io', cfg)).toBe('https://auth.docker.io/token')
    expect(findAuthHost('registry-1.docker.io', cfg)).toBe('https://auth.docker.io/token')
  })

  it('其余 service 取配置表中的 authHost', () => {
    expect(findAuthHost('ghcr.io', cfg)).toBe('https://ghcr.io/token')
    expect(findAuthHost('gcr.io', cfg)).toBe('https://gcr.io/v2/token')
  })

  it('未知 service 回退 docker 官方 auth', () => {
    expect(findAuthHost('unknown.example.com', cfg)).toBe('https://auth.docker.io/token')
  })
})

describe('handleTokenRequest', () => {
  it('查询串原样透传给上游 auth（docker 默认）', async () => {
    const { env } = makeEnv()
    const { calls, fetchFn } = makeFetch(new Response('{"token":"t1"}', { status: 200 }))
    const request = new Request('https://proxy.example.com/token?service=registry.docker.io&scope=repository:library/nginx:pull')

    await handleTokenRequest(request, env, fetchFn)

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/nginx:pull')
  })

  it('Authorization 头透传给上游', async () => {
    const { env } = makeEnv()
    const { calls, fetchFn } = makeFetch(new Response('{"token":"t1"}', { status: 200 }))
    const request = new Request('https://proxy.example.com/token?service=registry.docker.io&scope=repository:library/nginx:pull', {
      headers: { Authorization: 'Basic xxx' },
    })

    await handleTokenRequest(request, env, fetchFn)

    expect(calls[0].headers.get('Authorization')).toBe('Basic xxx')
  })

  it('上游 200 时返回体原样，且 token 写入缓存', async () => {
    const { env, tokens } = makeEnv()
    const { fetchFn } = makeFetch(new Response('{"token":"t1"}', { status: 200 }))
    const request = new Request('https://proxy.example.com/token?service=registry.docker.io&scope=repository:library/nginx:pull')

    const response = await handleTokenRequest(request, env, fetchFn)

    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toBe('{"token":"t1"}')
    expect(tokens.store.get('token:registry.docker.io:repository:library/nginx:pull')).toBe('t1')
    await expect(getCachedToken(env, 'registry.docker.io', 'repository:library/nginx:pull')).resolves.toBe('t1')
  })

  it('service=ghcr.io 时上游为 ghcr.io/token', async () => {
    const { env } = makeEnv()
    const { calls, fetchFn } = makeFetch(new Response('{"token":"t1"}', { status: 200 }))
    const request = new Request('https://proxy.example.com/token?service=ghcr.io&scope=repository:owner/app:pull')

    await handleTokenRequest(request, env, fetchFn)

    expect(calls[0].url).toBe('https://ghcr.io/token?service=ghcr.io&scope=repository:owner/app:pull')
  })

  it('未知 service 回退 docker 官方 auth', async () => {
    const { env } = makeEnv()
    const { calls, fetchFn } = makeFetch(new Response('{"token":"t1"}', { status: 200 }))
    const request = new Request('https://proxy.example.com/token?service=unknown.example.com&scope=repository:foo/bar:pull')

    await handleTokenRequest(request, env, fetchFn)

    expect(calls[0].url).toBe('https://auth.docker.io/token?service=unknown.example.com&scope=repository:foo/bar:pull')
  })

  it('上游 401 时原样返回 401，且不写缓存', async () => {
    const { env, tokens } = makeEnv()
    const { fetchFn } = makeFetch(new Response('unauthorized', { status: 401 }))
    const request = new Request('https://proxy.example.com/token?service=registry.docker.io&scope=repository:library/nginx:pull')

    const response = await handleTokenRequest(request, env, fetchFn)

    expect(response.status).toBe(401)
    await expect(response.text()).resolves.toBe('unauthorized')
    expect(tokens.store.size).toBe(0)
    await expect(getCachedToken(env, 'registry.docker.io', 'repository:library/nginx:pull')).resolves.toBeNull()
  })
})
