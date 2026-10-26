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

/** 缓存的 manifest：body 与真实 Content-Type 必须一起存，避免命中时头体不一致
 *  （如 OCI index body 配上 v2 Content-Type，docker 会报 mediaType 不匹配）。 */
export interface CachedManifest {
  contentType: string
  body: string
}

/** 读取缓存的 manifest；未命中或旧格式无 contentType 时返回 null（视为未命中，重新拉取） */
export async function getCachedManifest(env: Env, repo: string, digest: string): Promise<CachedManifest | null> {
  const raw = await env.MANIFESTS.get(manifestCacheKey(repo, digest))
  if (raw === null) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null) {
      const obj = parsed as { contentType?: unknown; body?: unknown }
      if (typeof obj.contentType === 'string' && typeof obj.body === 'string') {
        return { contentType: obj.contentType, body: obj.body }
      }
    }
  } catch {
    // 旧格式（裸 body）或非法 JSON：视为未命中
  }
  return null
}

/** 写入 manifest 缓存（含真实 Content-Type），ttl 为过期秒数 */
export function setCachedManifest(
  env: Env,
  repo: string,
  digest: string,
  body: string,
  ttl: number,
  contentType: string,
): Promise<void> {
  const envelope: CachedManifest = { contentType, body }
  return env.MANIFESTS.put(manifestCacheKey(repo, digest), JSON.stringify(envelope), { expirationTtl: ttl })
}
