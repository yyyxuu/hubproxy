// ---------- KV 缓存：token 与 manifest ----------
import type { Env } from '../types'

/** token 缓存 key：按 service + scope 区分 */
export function tokenCacheKey(service: string, scope: string): string {
  return `token:${service}:${scope}`
}

/** manifest 缓存 key：按 repo + digest 区分 */
export function manifestCacheKey(repo: string, digest: string): string {
  return `manifest:${repo}:${digest}`
}

/** 读取缓存的 token；未命中返回 null */
export function getCachedToken(env: Env, service: string, scope: string): Promise<string | null> {
  return env.TOKENS.get(tokenCacheKey(service, scope))
}

/** 写入 token 缓存，ttl 为过期秒数（透传给 expirationTtl） */
export function setCachedToken(
  env: Env,
  service: string,
  scope: string,
  token: string,
  ttl: number,
): Promise<void> {
  return env.TOKENS.put(tokenCacheKey(service, scope), token, { expirationTtl: ttl })
}

/** 读取缓存的 manifest；未命中返回 null */
export function getCachedManifest(env: Env, repo: string, digest: string): Promise<string | null> {
  return env.MANIFESTS.get(manifestCacheKey(repo, digest))
}

/** 写入 manifest 缓存，ttl 为过期秒数（透传给 expirationTtl） */
export function setCachedManifest(
  env: Env,
  repo: string,
  digest: string,
  body: string,
  ttl: number,
): Promise<void> {
  return env.MANIFESTS.put(manifestCacheKey(repo, digest), body, { expirationTtl: ttl })
}
