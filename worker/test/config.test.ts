import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config'
import type { Env } from '../src/types'

// 构造仅含环境变量字符串的 Env（KV 绑定与配置解析无关，此处以空对象占位）
const makeEnv = (vars: Record<string, string> = {}): Env => ({
  TOKENS: {} as KVNamespace,
  MANIFESTS: {} as KVNamespace,
  ...vars,
})

describe('loadConfig 默认值', () => {
  it('空 env 时使用默认限额', () => {
    const cfg = loadConfig(makeEnv())
    expect(cfg.maxFileSize).toBe(2147483648) // 2GB
    expect(cfg.tokenCacheTTL).toBe(1200) // 20 分钟（秒）
    expect(cfg.manifestCacheTTL).toBe(3600) // 1 小时（秒）
  })

  it('默认注册表包含五个常见镜像源', () => {
    const cfg = loadConfig(makeEnv())
    expect(Object.keys(cfg.upstreamRegistries).sort()).toEqual([
      'gcr.io',
      'ghcr.io',
      'quay.io',
      'registry-1.docker.io',
      'registry.k8s.io',
    ])
    expect(cfg.upstreamRegistries['registry-1.docker.io']).toEqual({
      upstream: 'registry-1.docker.io',
      authHost: 'https://auth.docker.io/token',
      authType: 'anonymous',
      enabled: true,
    })
    expect(cfg.upstreamRegistries['ghcr.io']).toEqual({
      upstream: 'ghcr.io',
      authHost: 'https://ghcr.io/token',
      authType: 'github',
      enabled: true,
    })
    expect(cfg.upstreamRegistries['gcr.io'].authHost).toBe('https://gcr.io/v2/token')
    expect(cfg.upstreamRegistries['quay.io'].authHost).toBe('https://quay.io/v2/auth')
    expect(cfg.upstreamRegistries['registry.k8s.io'].authHost).toBe('https://registry.k8s.io/v2/')
  })
})

describe('loadConfig 环境变量覆盖', () => {
  it('UPSTREAM_REGISTRIES 为合法 JSON 时覆盖默认注册表', () => {
    const cfg = loadConfig(
      makeEnv({
        UPSTREAM_REGISTRIES: JSON.stringify({
          'ghcr.io': {
            upstream: 'ghcr.example.com',
            authHost: 'https://ghcr.example.com/token',
            authType: 'github',
            enabled: true,
          },
          'mirror.example.com': {
            upstream: 'mirror.example.com',
            authHost: 'https://mirror.example.com/token',
            authType: 'anonymous',
            enabled: true,
          },
        }),
      }),
    )
    // 同名键被覆盖
    expect(cfg.upstreamRegistries['ghcr.io'].upstream).toBe('ghcr.example.com')
    // 新增键被合并
    expect(cfg.upstreamRegistries['mirror.example.com'].upstream).toBe('mirror.example.com')
  })

  it('UPSTREAM_REGISTRIES 为非法 JSON 时回退默认注册表且不抛错', () => {
    expect(() => loadConfig(makeEnv({ UPSTREAM_REGISTRIES: '{not-json' }))).not.toThrow()
    const cfg = loadConfig(makeEnv({ UPSTREAM_REGISTRIES: '{not-json' }))
    expect(cfg.upstreamRegistries['ghcr.io'].upstream).toBe('ghcr.io')
  })

  it('IP 与仓库列表按逗号分隔解析为数组', () => {
    const cfg = loadConfig(
      makeEnv({
        IP_WHITELIST: ' 10.0.0.1 ,10.0.0.2',
        IP_BLACKLIST: '192.168.100.0/24,2001:db8::/48',
        REPO_WHITELIST: 'user/good',
        REPO_BLACKLIST: 'baduser/*,*/malicious-repo',
      }),
    )
    expect(cfg.ipWhiteList).toEqual(['10.0.0.1', '10.0.0.2'])
    expect(cfg.ipBlackList).toEqual(['192.168.100.0/24', '2001:db8::/48'])
    expect(cfg.repoWhiteList).toEqual(['user/good'])
    expect(cfg.repoBlackList).toEqual(['baduser/*', '*/malicious-repo'])
  })

  it('数值变量非法时回退默认值', () => {
    const cfg = loadConfig(
      makeEnv({
        MAX_FILE_SIZE: 'abc',
        TOKEN_CACHE_TTL: '',
        MANIFEST_CACHE_TTL: '-5',
      }),
    )
    expect(cfg.maxFileSize).toBe(2147483648)
    expect(cfg.tokenCacheTTL).toBe(1200)
    expect(cfg.manifestCacheTTL).toBe(3600)
  })

  it('数值变量合法时覆盖默认值', () => {
    const cfg = loadConfig(
      makeEnv({
        MAX_FILE_SIZE: '1024',
        TOKEN_CACHE_TTL: '60',
        MANIFEST_CACHE_TTL: '1800',
      }),
    )
    expect(cfg.maxFileSize).toBe(1024)
    expect(cfg.tokenCacheTTL).toBe(60)
    expect(cfg.manifestCacheTTL).toBe(1800)
  })
})
