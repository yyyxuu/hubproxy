import type { Env, RegistryMapping } from './types'

/** 应用配置：由 loadConfig 从 Env 解析得到 */
export interface AppConfig {
  upstreamRegistries: Record<string, RegistryMapping>
  maxFileSize: number
  ipWhiteList: string[]
  ipBlackList: string[]
  repoWhiteList: string[]
  repoBlackList: string[]
  tokenCacheTTL: number
  manifestCacheTTL: number
}

// 默认注册表映射（取自 spec §4.1 与上游 Go 版 src/config/config.go 的 DefaultConfig）
const DEFAULT_REGISTRIES: Record<string, RegistryMapping> = {
  'registry-1.docker.io': {
    upstream: 'registry-1.docker.io',
    authHost: 'https://auth.docker.io/token',
    authType: 'anonymous',
    enabled: true,
  },
  'ghcr.io': {
    upstream: 'ghcr.io',
    authHost: 'https://ghcr.io/token',
    authType: 'github',
    enabled: true,
  },
  'gcr.io': {
    upstream: 'gcr.io',
    authHost: 'https://gcr.io/v2/token',
    authType: 'google',
    enabled: true,
  },
  'quay.io': {
    upstream: 'quay.io',
    authHost: 'https://quay.io/v2/auth',
    authType: 'quay',
    enabled: true,
  },
  'registry.k8s.io': {
    upstream: 'registry.k8s.io',
    authHost: 'https://registry.k8s.io/v2/',
    authType: 'anonymous',
    enabled: true,
  },
}

const DEFAULT_MAX_FILE_SIZE = 2147483648 // 2GB
const DEFAULT_TOKEN_CACHE_TTL = 1200 // 20 分钟（秒）
const DEFAULT_MANIFEST_CACHE_TTL = 3600 // 1 小时（秒）

// 解析正整数环境变量；未设置或非法时回退默认值（与上游 Go 版 "必须为正数" 语义一致）
function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return fallback
  return Number(raw.trim())
}

// 解析逗号分隔列表；去除每项首尾空白并丢弃空项
function parseList(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === '') return []
  return raw
    .split(',')
    .map(item => item.trim())
    .filter(item => item !== '')
}

/** 从 Env 解析配置 */
export function loadConfig(env: Env): AppConfig {
  // UPSTREAM_REGISTRIES：合法 JSON 覆盖/合并默认注册表；非法 JSON 回退默认且不抛错
  let upstreamRegistries = { ...DEFAULT_REGISTRIES }
  const rawRegistries = env.UPSTREAM_REGISTRIES?.trim()
  if (rawRegistries) {
    try {
      const parsed: unknown = JSON.parse(rawRegistries)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        upstreamRegistries = { ...DEFAULT_REGISTRIES, ...(parsed as Record<string, RegistryMapping>) }
      }
    } catch {
      // 非法 JSON：保持默认注册表
    }
  }

  return {
    upstreamRegistries,
    maxFileSize: parsePositiveInt(env.MAX_FILE_SIZE, DEFAULT_MAX_FILE_SIZE),
    ipWhiteList: parseList(env.IP_WHITELIST),
    ipBlackList: parseList(env.IP_BLACKLIST),
    repoWhiteList: parseList(env.REPO_WHITELIST),
    repoBlackList: parseList(env.REPO_BLACKLIST),
    tokenCacheTTL: parsePositiveInt(env.TOKEN_CACHE_TTL, DEFAULT_TOKEN_CACHE_TTL),
    manifestCacheTTL: parsePositiveInt(env.MANIFEST_CACHE_TTL, DEFAULT_MANIFEST_CACHE_TTL),
  }
}
