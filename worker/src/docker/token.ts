// ---------- Docker token 换发 ----------
import { loadConfig, type AppConfig } from '../config'
import { setCachedToken } from '../utils/cache'
import { copyIncomingHeaders } from '../utils/headers'
import type { Env, FetchLike } from '../types'

// docker 官方 auth 服务地址：别名 service 的固定回退目标
const DOCKER_AUTH_HOST = 'https://auth.docker.io/token'

// 已知 service → authHost 固定映射，优先于配置表
const KNOWN_AUTH_HOSTS: Record<string, string> = {
  'registry.docker.io': DOCKER_AUTH_HOST,
  'registry-1.docker.io': DOCKER_AUTH_HOST,
}

/**
 * 解析 service 对应的上游 authHost：
 * 已知别名表 → 配置表 `cfg.upstreamRegistries[service].authHost` → 回退 docker 官方 auth。
 */
export function findAuthHost(service: string, cfg: AppConfig): string {
  return KNOWN_AUTH_HOSTS[service] ?? cfg.upstreamRegistries[service]?.authHost ?? DOCKER_AUTH_HOST
}

/**
 * 处理 /token 请求：向对应注册表的 auth 服务换发 token。
 * 查询串（service/scope）原样透传，Authorization 等请求头透传给上游；
 * 上游 200 时解析 JSON 提取 token 字段写入 KV 缓存，其余状态码原样返回。
 */
export async function handleTokenRequest(request: Request, env: Env, fetchFn: FetchLike): Promise<Response> {
  // 处理器内部自行加载配置
  const cfg = loadConfig(env)
  const url = new URL(request.url)
  const service = url.searchParams.get('service') ?? ''
  const scope = url.searchParams.get('scope') ?? ''

  // 查询串原样透传（含前导 ?；无查询时直接使用 authHost）
  const upstreamUrl = `${findAuthHost(service, cfg)}${url.search}`

  // 拷贝客户端请求头（含 Authorization，跳过 Host）到新请求
  const headers = new Headers()
  copyIncomingHeaders(request, headers)

  const upstream = await fetchFn(new Request(upstreamUrl, { method: 'GET', headers }))

  // 仅成功响应写缓存（缓存读取在缓存命中判定处另行处理）。
  // 缓存是尽力而为的附加功能：KV put 失败绝不能让上游 200 响应失效，静默忽略。
  if (upstream.status === 200) {
    const token = await extractToken(upstream)
    if (token !== null) {
      await setCachedToken(env, service, scope, token, cfg.tokenCacheTTL).catch(() => {})
    }
  }
  return upstream
}

/** 从上游 200 响应中提取 token 字段；body 非 JSON 或缺少 token 字段时返回 null（不缓存） */
async function extractToken(upstream: Response): Promise<string | null> {
  try {
    const parsed: unknown = JSON.parse(await upstream.clone().text())
    if (typeof parsed === 'object' && parsed !== null && 'token' in parsed) {
      const token = (parsed as { token: unknown }).token
      if (typeof token === 'string') return token
    }
  } catch {
    // 非 JSON body：跳过缓存，响应仍原样透传
  }
  return null
}
