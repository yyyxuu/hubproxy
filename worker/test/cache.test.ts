import { describe, expect, it } from 'vitest'
import {
  getCachedManifest,
  getCachedToken,
  manifestCacheKey,
  setCachedManifest,
  setCachedToken,
  tokenCacheKey,
} from '../src/utils/cache'
import type { Env } from '../src/types'

// 内存假 KV：实现 get/put 并记录写入内容与 TTL，通过 unknown 断言对齐 KVNamespace
function makeFakeKV() {
  const store = new Map<string, string>()
  const ttls = new Map<string, number>()
  const kv = {
    get: (key: string) => Promise.resolve(store.get(key) ?? null),
    put: (key: string, value: string, opts?: { expirationTtl?: number }) => {
      store.set(key, value)
      if (opts?.expirationTtl !== undefined) ttls.set(key, opts.expirationTtl)
      return Promise.resolve()
    },
  }
  return { kv: kv as unknown as KVNamespace, store, ttls }
}

// 构造带内存假 KV 的 Env（TOKENS/MANIFESTS 均为真实可交互的假 KV）
function makeEnv() {
  const tokens = makeFakeKV()
  const manifests = makeFakeKV()
  const env: Env = { TOKENS: tokens.kv, MANIFESTS: manifests.kv }
  return { env, tokens, manifests }
}

describe('缓存 key 构造', () => {
  it('tokenCacheKey 由 service 与 scope 组成', () => {
    expect(tokenCacheKey('registry.docker.io', 'repository:library/nginx:pull')).toBe(
      'token:registry.docker.io:repository:library/nginx:pull',
    )
  })

  it('manifestCacheKey 由 repo 与 digest 组成', () => {
    expect(manifestCacheKey('ghcr.io/owner/app', 'sha256:abc')).toBe('manifest:ghcr.io/owner/app:sha256:abc')
  })
})

describe('token 缓存', () => {
  it('setCachedToken + getCachedToken 往返正确，key 含 service 与 scope，TTL 透传', async () => {
    const { env, tokens } = makeEnv()
    await setCachedToken(env, 'registry.docker.io', 'repository:library/nginx:pull', 't1', 60)
    expect(tokens.store.get('token:registry.docker.io:repository:library/nginx:pull')).toBe('t1')
    expect(tokens.ttls.get('token:registry.docker.io:repository:library/nginx:pull')).toBe(60)
    await expect(getCachedToken(env, 'registry.docker.io', 'repository:library/nginx:pull')).resolves.toBe('t1')
  })

  it('未命中时返回 null', async () => {
    const { env } = makeEnv()
    await expect(getCachedToken(env, 'registry.docker.io', 'repository:library/nginx:pull')).resolves.toBeNull()
  })

  it('不同 scope 的 key 不串', async () => {
    const { env, tokens } = makeEnv()
    await setCachedToken(env, 'registry.docker.io', 'repository:library/nginx:pull', 't1', 60)
    await setCachedToken(env, 'registry.docker.io', 'repository:library/redis:pull', 't2', 60)
    expect(tokens.store.get('token:registry.docker.io:repository:library/nginx:pull')).toBe('t1')
    expect(tokens.store.get('token:registry.docker.io:repository:library/redis:pull')).toBe('t2')
    await expect(getCachedToken(env, 'registry.docker.io', 'repository:library/nginx:pull')).resolves.toBe('t1')
    await expect(getCachedToken(env, 'registry.docker.io', 'repository:library/redis:pull')).resolves.toBe('t2')
  })

  it('不同 service 的 key 不串', async () => {
    const { env, tokens } = makeEnv()
    await setCachedToken(env, 'registry.docker.io', 'repository:library/nginx:pull', 't1', 60)
    await setCachedToken(env, 'ghcr.io', 'repository:library/nginx:pull', 't2', 60)
    expect(tokens.store.get('token:registry.docker.io:repository:library/nginx:pull')).toBe('t1')
    expect(tokens.store.get('token:ghcr.io:repository:library/nginx:pull')).toBe('t2')
    await expect(getCachedToken(env, 'registry.docker.io', 'repository:library/nginx:pull')).resolves.toBe('t1')
    await expect(getCachedToken(env, 'ghcr.io', 'repository:library/nginx:pull')).resolves.toBe('t2')
  })
})

describe('manifest 缓存', () => {
  it('setCachedManifest 后 getCachedManifest 返回 body + Content-Type，TTL 透传', async () => {
    const { env, manifests } = makeEnv()
    await setCachedManifest(env, 'ghcr.io/owner/app', 'sha256:abc', '{}', 60, 'application/vnd.oci.image.index.v1+json')
    expect(manifests.store.get('manifest:ghcr.io/owner/app:sha256:abc')).toBe(
      JSON.stringify({ contentType: 'application/vnd.oci.image.index.v1+json', body: '{}' }),
    )
    expect(manifests.ttls.get('manifest:ghcr.io/owner/app:sha256:abc')).toBe(60)
    await expect(getCachedManifest(env, 'ghcr.io/owner/app', 'sha256:abc')).resolves.toEqual({
      contentType: 'application/vnd.oci.image.index.v1+json',
      body: '{}',
    })
  })

  it('未命中时返回 null', async () => {
    const { env } = makeEnv()
    await expect(getCachedManifest(env, 'ghcr.io/owner/app', 'sha256:abc')).resolves.toBeNull()
  })

  it('旧格式（裸 body，无 contentType）视为未命中，避免头体不一致', async () => {
    const { env, manifests } = makeEnv()
    manifests.store.set('manifest:ghcr.io/owner/app:sha256:abc', '{"schemaVersion":2}')
    await expect(getCachedManifest(env, 'ghcr.io/owner/app', 'sha256:abc')).resolves.toBeNull()
  })

  it('不同 digest 的 key 不串', async () => {
    const { env, manifests } = makeEnv()
    await setCachedManifest(env, 'ghcr.io/owner/app', 'sha256:abc', '{}', 60, 'application/vnd.oci.image.index.v1+json')
    await setCachedManifest(env, 'ghcr.io/owner/app', 'sha256:def', '{"x":1}', 60, 'application/vnd.docker.distribution.manifest.v2+json')
    expect(manifests.store.get('manifest:ghcr.io/owner/app:sha256:abc')).toContain('"body":"{}"')
    expect(manifests.store.get('manifest:ghcr.io/owner/app:sha256:def')).toContain('"body":"{\\"x\\":1}"')
    await expect(getCachedManifest(env, 'ghcr.io/owner/app', 'sha256:abc')).resolves.toEqual({
      contentType: 'application/vnd.oci.image.index.v1+json',
      body: '{}',
    })
    await expect(getCachedManifest(env, 'ghcr.io/owner/app', 'sha256:def')).resolves.toEqual({
      contentType: 'application/vnd.docker.distribution.manifest.v2+json',
      body: '{"x":1}',
    })
  })
})
