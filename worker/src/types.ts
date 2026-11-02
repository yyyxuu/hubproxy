export interface Env {
  UPSTREAM_REGISTRIES?: string // JSON: Record<domain, RegistryMapping>
  MAX_FILE_SIZE?: string
  IP_WHITELIST?: string // 逗号分隔
  IP_BLACKLIST?: string
  REPO_WHITELIST?: string
  REPO_BLACKLIST?: string
  TOKEN_CACHE_TTL?: string // 秒
  MANIFEST_CACHE_TTL?: string // 秒
  GITHUB_TOKEN?: string // 可选：提升 api.github.com 速率上限（Releases 解析用）
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
