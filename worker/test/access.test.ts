import { describe, expect, it } from 'vitest'
import { loadConfig, type AppConfig } from '../src/config'
import { checkIP, checkRepoAccess, matchesList, normalizeIPv6, wildcardMatch } from '../src/utils/access'
import type { Env } from '../src/types'

// 基于默认配置构造测试用 AppConfig
const makeCfg = (overrides: Partial<AppConfig> = {}): AppConfig => ({
  ...loadConfig({} as Env),
  ...overrides,
})

describe('normalizeIPv6', () => {
  it('纯 IPv6 掩成 /64：前 4 组保留、其余补 0', () => {
    expect(normalizeIPv6('2001:db8:85a3::8a2e:370:7334')).toBe('2001:db8:85a3::')
  })

  it('IPv4-mapped 地址按 IPv4 处理', () => {
    expect(normalizeIPv6('::ffff:192.168.1.1')).toBe('192.168.1.1')
  })

  it('纯 IPv4 原样返回', () => {
    expect(normalizeIPv6('192.168.1.1')).toBe('192.168.1.1')
  })
})

describe('matchesList', () => {
  it('精确匹配', () => {
    expect(matchesList('10.0.0.1', ['10.0.0.1', '10.0.0.2'])).toBe(true)
    expect(matchesList('10.0.0.3', ['10.0.0.1', '10.0.0.2'])).toBe(false)
  })

  it('IPv4 CIDR 内外判定', () => {
    const list = ['192.168.100.0/24']
    expect(matchesList('192.168.100.55', list)).toBe(true)
    expect(matchesList('192.168.101.1', list)).toBe(false)
  })

  it('IPv6 CIDR 匹配', () => {
    const list = ['2001:db8:85a3::/48']
    expect(matchesList('2001:db8:85a3::8a2e:370:7334', list)).toBe(true)
    expect(matchesList('2001:db8:85a4::1', list)).toBe(false)
  })
})

describe('checkIP', () => {
  it('黑名单中的 IP 拒绝', () => {
    const cfg = makeCfg({ ipBlackList: ['192.168.1.1'] })
    expect(checkIP('192.168.1.1', cfg)).toEqual({ allowed: false, reason: expect.any(String) })
  })

  it('黑名单外的 IP 放行', () => {
    const cfg = makeCfg({ ipBlackList: ['192.168.1.1'] })
    expect(checkIP('10.0.0.9', cfg)).toEqual({ allowed: true })
  })

  it('黑名单 CIDR 命中拒绝', () => {
    const cfg = makeCfg({ ipBlackList: ['10.10.0.0/16'] })
    expect(checkIP('10.10.2.3', cfg).allowed).toBe(false)
  })
})

describe('wildcardMatch', () => {
  it('前缀通配', () => {
    expect(wildcardMatch('*/malicious-repo', 'anyuser/malicious-repo')).toBe(true)
  })

  it('后缀通配', () => {
    expect(wildcardMatch('baduser/*', 'baduser/anything')).toBe(true)
  })

  it('不匹配返回 false', () => {
    expect(wildcardMatch('baduser/*', 'other/anything')).toBe(false)
  })
})

describe('checkRepoAccess', () => {
  it('黑名单命中拒绝', () => {
    const cfg = makeCfg({ repoBlackList: ['baduser/*'] })
    expect(checkRepoAccess('baduser/app', cfg).allowed).toBe(false)
  })

  it('黑名单未命中放行', () => {
    const cfg = makeCfg({ repoBlackList: ['baduser/*'] })
    expect(checkRepoAccess('gooduser/app', cfg).allowed).toBe(true)
  })

  it('白名单非空时未列出的仓库拒绝、列出的放行', () => {
    const cfg = makeCfg({ repoWhiteList: ['gooduser/app'] })
    expect(checkRepoAccess('other/app', cfg).allowed).toBe(false)
    expect(checkRepoAccess('gooduser/app', cfg).allowed).toBe(true)
  })

  it('白名单为空时不限制', () => {
    const cfg = makeCfg({ repoWhiteList: [] })
    expect(checkRepoAccess('any/app', cfg).allowed).toBe(true)
  })
})
