import { describe, expect, it } from 'vitest'
import { detectRegistry, handleRegistryRequest } from '../src/docker/registry'
import { getCachedManifest } from '../src/utils/cache'
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

// 构造带内存假 KV 的 Env（MANIFESTS 为真实可交互的假 KV）
function makeEnv() {
  const manifests = makeFakeKV()
  const env: Env = { TOKENS: makeFakeKV().kv, MANIFESTS: manifests.kv }
  return { env, manifests }
}

// mock fetchFn：记录收到的上游请求（URL/请求头/init），按 URL 返回预设响应
function makeRoutedFetch(handler: (url: string, init?: RequestInit) => Response | null) {
  const calls: Array<{ url: string; headers: Headers; init?: RequestInit }> = []
  const fetchFn: FetchLike = async (input, init) => {
    const req = input instanceof Request ? input : new Request(input)
    calls.push({ url: req.url, headers: req.headers, init })
    const resp = handler(req.url, init)
    return resp ?? new Response('not found', { status: 404 })
  }
  return { calls, fetchFn }
}

describe('detectRegistry', () => {
  const cfg = loadConfig(makeEnv().env)

  it('repoPath 首段命中配置域名时，该域名为上游、repo 去掉首段', () => {
    expect(detectRegistry('ghcr.io/owner/app', cfg)).toEqual({ domain: 'ghcr.io', repo: 'owner/app' })
  })

  it('未命中配置时回退 docker hub（registry-1.docker.io），repo 原样', () => {
    expect(detectRegistry('library/nginx', cfg)).toEqual({ domain: 'registry-1.docker.io', repo: 'library/nginx' })
  })
})

describe('handleRegistryRequest', () => {
  it('GET /v2/ 本地应答 200 且含 Docker-Distribution-Api-Version', async () => {
    const { env } = makeEnv()
    const { fetchFn } = makeRoutedFetch(() => null)
    const response = await handleRegistryRequest(new Request('https://hub.example.com/v2/'), env, fetchFn)
    expect(response.status).toBe(200)
    expect(response.headers.get('Docker-Distribution-Api-Version')).toBe('registry/2.0')
  })

  it('manifests 转发到 docker hub 上游且 Accept 头透传', async () => {
    const { env } = makeEnv()
    const { calls, fetchFn } = makeRoutedFetch(
      () =>
        new Response('{}', {
          status: 200,
          headers: { 'Content-Type': 'application/vnd.docker.distribution.manifest.v2+json' },
        }),
    )
    const request = new Request('https://hub.example.com/v2/library/nginx/manifests/latest', {
      headers: { Accept: 'application/vnd.docker.distribution.manifest.v2+json' },
    })
    const response = await handleRegistryRequest(request, env, fetchFn)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://registry-1.docker.io/v2/library/nginx/manifests/latest')
    expect(calls[0].headers.get('Accept')).toBe('application/vnd.docker.distribution.manifest.v2+json')
    expect(response.status).toBe(200)
  })

  it('上游 401 时 WWW-Authenticate 的 realm 改写为 https://<请求Host>/token', async () => {
    const { env } = makeEnv()
    const { fetchFn } = makeRoutedFetch(
      () =>
        new Response('unauthorized', {
          status: 401,
          headers: { 'WWW-Authenticate': 'Bearer realm="https://auth.docker.io/token",service="registry.docker.io"' },
        }),
    )
    const response = await handleRegistryRequest(
      new Request('https://hub.example.com/v2/library/nginx/manifests/latest'),
      env,
      fetchFn,
    )
    expect(response.status).toBe(401)
    expect(response.headers.get('WWW-Authenticate')).toBe(
      'Bearer realm="https://hub.example.com/token",service="registry.docker.io"',
    )
  })

  it('上游 200 带 Docker-Content-Digest 时 body 写入缓存，二次按 digest 请求命中缓存不再调上游', async () => {
    const { env, manifests } = makeEnv()
    const body = '{"schemaVersion":2,"mediaType":"application/vnd.docker.distribution.manifest.v2+json"}'
    const { calls, fetchFn } = makeRoutedFetch(
      () =>
        new Response(body, {
          status: 200,
          headers: {
            'Content-Type': 'application/vnd.docker.distribution.manifest.v2+json',
            'Docker-Content-Digest': 'sha256:abc',
          },
        }),
    )
    // 首次按 tag 请求：必须访问上游；body 按 digest 写缓存（缓存 key 按 Ruling C 带上游域名）
    const first = await handleRegistryRequest(new Request('https://hub.example.com/v2/library/nginx/manifests/latest'), env, fetchFn)
    expect(first.status).toBe(200)
    await expect(getCachedManifest(env, 'registry-1.docker.io/library/nginx', 'sha256:abc')).resolves.toBe(body)
    expect(manifests.store.get('manifest:registry-1.docker.io/library/nginx:sha256:abc')).toBe(body)

    // 二次按 digest 请求：缓存命中，直接返回缓存体、不再调 mock
    const second = await handleRegistryRequest(
      new Request('https://hub.example.com/v2/library/nginx/manifests/sha256:abc'),
      env,
      fetchFn,
    )
    expect(second.status).toBe(200)
    expect(second.headers.get('Content-Type')).toBe('application/vnd.docker.distribution.manifest.v2+json')
    await expect(second.text()).resolves.toBe(body)
    expect(calls).toHaveLength(1)
  })

  it('HEAD blob：200、Content-Length 透传、body 为空（Review Focus 2）', async () => {
    const { env } = makeEnv()
    const { fetchFn } = makeRoutedFetch(
      () =>
        new Response(null, {
          status: 200,
          headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': '5' },
        }),
    )
    const response = await handleRegistryRequest(
      new Request('https://hub.example.com/v2/library/nginx/blobs/sha256:abc', { method: 'HEAD' }),
      env,
      fetchFn,
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Length')).toBe('5')
    await expect(response.text()).resolves.toBe('')
  })

  it('GET blob 跟随 CDN 重定向：客户端看到 200（非 3xx）且 body 与关键头透传', async () => {
    const { env } = makeEnv()
    const blobUrl = 'https://registry-1.docker.io/v2/library/nginx/blobs/sha256:abc'
    const cdnUrl = 'https://cdn.example.com/nginx-blob'
    const blobBody = 'blob-data'
    const { calls, fetchFn } = makeRoutedFetch((url, init) => {
      // 实现以 redirect: 'follow' 请求 → mock 模拟服务端跟随 302 到 CDN 后的最终 200
      if (url === blobUrl && init?.redirect === 'follow') {
        return new Response(blobBody, {
          status: 200,
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(blobBody.length),
            'Docker-Content-Digest': 'sha256:abc',
            ETag: '"etag-1"',
          },
        })
      }
      if (url === blobUrl) return new Response(null, { status: 302, headers: { Location: cdnUrl } })
      if (url === cdnUrl) {
        return new Response(blobBody, {
          status: 200,
          headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(blobBody.length) },
        })
      }
      return null
    })
    const response = await handleRegistryRequest(
      new Request('https://hub.example.com/v2/library/nginx/blobs/sha256:abc'),
      env,
      fetchFn,
    )
    expect(response.status).toBe(200)
    expect(calls[0].init?.redirect).toBe('follow')
    await expect(response.text()).resolves.toBe(blobBody)
    expect(response.headers.get('Content-Type')).toBe('application/octet-stream')
    expect(response.headers.get('Content-Length')).toBe('9')
    expect(response.headers.get('Docker-Content-Digest')).toBe('sha256:abc')
    expect(response.headers.get('ETag')).toBe('"etag-1"')
  })

  it('ghcr.io 命名空间转发到 ghcr.io 上游', async () => {
    const { env } = makeEnv()
    const { calls, fetchFn } = makeRoutedFetch(() => new Response('{}', { status: 200 }))
    const response = await handleRegistryRequest(
      new Request('https://hub.example.com/v2/ghcr.io/owner/app/manifests/latest'),
      env,
      fetchFn,
    )
    expect(calls[0].url).toBe('https://ghcr.io/v2/owner/app/manifests/latest')
    expect(response.status).toBe(200)
  })

  it('tags/list 转发到上游', async () => {
    const { env } = makeEnv()
    const { calls, fetchFn } = makeRoutedFetch(
      () => new Response('{"name":"library/nginx","tags":["latest"]}', { status: 200 }),
    )
    const response = await handleRegistryRequest(
      new Request('https://hub.example.com/v2/library/nginx/tags/list'),
      env,
      fetchFn,
    )
    expect(calls[0].url).toBe('https://registry-1.docker.io/v2/library/nginx/tags/list')
    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toBe('{"name":"library/nginx","tags":["latest"]}')
  })

  it('未知 /v2/* 路径返回 404', async () => {
    const { env } = makeEnv()
    const { fetchFn } = makeRoutedFetch(() => null)
    const response = await handleRegistryRequest(new Request('https://hub.example.com/v2/foo/bar/uploads/'), env, fetchFn)
    expect(response.status).toBe(404)
  })

  it('非 GET/HEAD 方法返回 405', async () => {
    const { env } = makeEnv()
    const { fetchFn } = makeRoutedFetch(() => null)
    const response = await handleRegistryRequest(
      new Request('https://hub.example.com/v2/foo/bar/manifests/latest', { method: 'POST' }),
      env,
      fetchFn,
    )
    expect(response.status).toBe(405)
  })
})
