export interface Env {
  UPSTREAM_REGISTRIES?: string // JSON: Record<domain, RegistryMapping>
  MAX_FILE_SIZE?: string
  IP_WHITELIST?: string // 逗号分隔
  IP_BLACKLIST?: string
  REPO_WHITELIST?: string
  REPO_BLACKLIST?: string
  TOKEN_CACHE_TTL?: string // 秒
  MANIFEST_CACHE_TTL?: string // 秒
  TOKENS: KVNamespace
  MANIFESTS: KVNamespace
}

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export interface RegistryMapping {
  upstream: string
  authHost: string
  authType: string
  enabled: boolean
}
