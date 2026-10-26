import type { AppConfig } from '../config'

// ---------- 地址解析（手写实现，避免引入 ipaddr.js 等运行时依赖） ----------

/** 将 IPv4 字符串转为 32 位无符号整数；解析失败返回 null */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let out = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const n = Number(part)
    if (n > 255) return null
    out = out * 256 + n
  }
  return out >>> 0
}

/** 匹配 IPv4 尾部形式（如 ::ffff:192.168.1.1） */
const IPV4_MAPPED_RE = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i

/**
 * 将纯 IPv6 展开为 8 组 16 位数值；解析失败返回 null。
 * 支持 :: 压缩形式；不支持 IPv4 尾部形式与 zone id（由调用方先行处理）。
 */
function ipv6ToGroups(ip: string): number[] | null {
  if (ip.includes('%')) return null // zone id（如 fe80::1%eth0）
  const halves = ip.split('::')
  if (halves.length > 2) return null // :: 至多出现一次
  const groupRe = /^[0-9a-fA-F]{1,4}$/
  const head = halves[0] === '' ? [] : halves[0].split(':')
  const tail = halves.length === 2 && halves[1] !== '' ? halves[1].split(':') : []
  for (const g of [...head, ...tail]) {
    if (!groupRe.test(g)) return null
  }
  const fill = 8 - head.length - tail.length
  if (fill < 0 || (halves.length === 1 && fill !== 0)) return null
  const groups = head.map(g => parseInt(g, 16))
  for (let i = 0; i < fill; i++) groups.push(0)
  groups.push(...tail.map(g => parseInt(g, 16)))
  return groups
}

/** 地址的统一数值表示：IPv4 占低 32 位，IPv6 占满 128 位 */
interface AddrValue {
  value: bigint
  isV4: boolean
}

/** 将 IPv4/IPv6 字符串转为统一数值表示；解析失败返回 null（IPv4-mapped 按 IPv4 处理） */
function toAddrValue(ip: string): AddrValue | null {
  const mapped = IPV4_MAPPED_RE.exec(ip)
  if (mapped) return toAddrValue(mapped[1])
  if (!ip.includes(':')) {
    const n = ipv4ToInt(ip)
    return n === null ? null : { value: BigInt(n), isV4: true }
  }
  const groups = ipv6ToGroups(ip)
  if (!groups) return null
  let value = 0n
  for (const g of groups) value = (value << 16n) | BigInt(g)
  return { value, isV4: false }
}

// ---------- CIDR 与精确匹配 ----------

/** 判断 value 是否落在 CIDR 网段内（支持 IPv4/IPv6） */
function matchCIDR(value: string, cidr: string): boolean {
  const slash = cidr.lastIndexOf('/')
  if (slash <= 0) return false
  const prefixStr = cidr.slice(slash + 1)
  if (!/^\d{1,3}$/.test(prefixStr)) return false
  const v = toAddrValue(value)
  const b = toAddrValue(cidr.slice(0, slash))
  // 地址族不同或任一解析失败则不匹配
  if (!v || !b || v.isV4 !== b.isV4) return false
  const bits = v.isV4 ? 32 : 128
  const prefix = Number(prefixStr)
  if (prefix > bits) return false
  const shift = BigInt(bits - prefix)
  return v.value >> shift === b.value >> shift
}

/** 判断两个字符串是否为同一地址（解析成功按数值比较，否则退化为字符串比较） */
function sameAddress(a: string, b: string): boolean {
  const pa = toAddrValue(a)
  const pb = toAddrValue(b)
  if (pa && pb) return pa.isV4 === pb.isV4 && pa.value === pb.value
  return a === b
}

/**
 * 判断 value 是否命中列表：支持精确值与 CIDR（IPv4/IPv6）。
 * 列表项按数值比较，因此同一地址的不同书写形式（如 2001:db8::1 与 2001:db8:0:0:0:0:0:1）等价。
 */
export function matchesList(value: string, list: string[]): boolean {
  const v = value.trim()
  if (!v) return false
  for (const raw of list) {
    const entry = raw.trim()
    if (!entry) continue
    if (entry.includes('/')) {
      if (matchCIDR(v, entry)) return true
    } else if (sameAddress(v, entry)) {
      return true
    }
  }
  return false
}

// ---------- IPv6 /64 归一化 ----------

/** 将 8 组数值格式化为 IPv6 字符串，最长连续零段（≥2 组）压缩为 :: */
function formatGroups(groups: number[]): string {
  const hex = (g: number) => g.toString(16)
  let bestStart = -1
  let bestLen = 1 // 至少 2 个连续零才压缩
  let curStart = -1
  let curLen = 0
  for (let i = 0; i <= groups.length; i++) {
    if (i < groups.length && groups[i] === 0) {
      if (curStart < 0) curStart = i
      curLen++
    } else if (curStart >= 0) {
      if (curLen > bestLen) {
        bestLen = curLen
        bestStart = curStart
      }
      curStart = -1
      curLen = 0
    }
  }
  if (bestStart < 0) return groups.map(hex).join(':')
  const head = groups.slice(0, bestStart).map(hex).join(':')
  const tail = groups.slice(bestStart + bestLen).map(hex).join(':')
  return `${head}::${tail}`
}

/**
 * 归一化客户端 IP：
 * - IPv4 与 IPv4-mapped（::ffff:x.x.x.x）按 IPv4 返回；
 * - 纯 IPv6 保留前 64 位（前 4 组）、其余补 0，用于按 /64 段聚合；
 * - 无法解析时原样返回。
 */
export function normalizeIPv6(ip: string): string {
  const trimmed = ip.trim()
  if (!trimmed.includes(':')) return trimmed
  const mapped = IPV4_MAPPED_RE.exec(trimmed)
  if (mapped) return mapped[1]
  const groups = ipv6ToGroups(trimmed)
  if (!groups) return trimmed
  const masked = groups.map((g, i) => (i < 4 ? g : 0))
  return formatGroups(masked)
}

// ---------- 访问控制 ----------

/**
 * 检查 IP 是否放行：黑名单命中即拒绝，否则放行。
 * 白名单在无自建限流的前提下不拦请求（见 spec §4.4），仅作记录用途。
 * 除原始 IP 外同时检查其 /64 归一化形式，支持把整段 /64 写入黑名单。
 */
export function checkIP(ip: string, cfg: AppConfig): { allowed: boolean; reason?: string } {
  const value = ip.trim()
  if (matchesList(value, cfg.ipBlackList) || matchesList(normalizeIPv6(value), cfg.ipBlackList)) {
    return { allowed: false, reason: 'IP 在黑名单中' }
  }
  return { allowed: true }
}

/** 通配符匹配：仅 '*' 视为通配（转为 .*），其余字符按字面量整体匹配 */
export function wildcardMatch(pattern: string, value: string): boolean {
  const regexStr = pattern
    .split('*')
    .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${regexStr}$`).test(value)
}

/** 检查仓库访问权限：黑名单命中拒绝；白名单非空且未命中拒绝 */
export function checkRepoAccess(repo: string, cfg: AppConfig): { allowed: boolean; reason?: string } {
  const name = repo.trim()
  if (cfg.repoBlackList.some(pattern => wildcardMatch(pattern.trim(), name))) {
    return { allowed: false, reason: '仓库在黑名单中' }
  }
  if (cfg.repoWhiteList.length > 0 && !cfg.repoWhiteList.some(pattern => wildcardMatch(pattern.trim(), name))) {
    return { allowed: false, reason: '仓库不在白名单中' }
  }
  return { allowed: true }
}
