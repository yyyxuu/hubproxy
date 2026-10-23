import { handleRegistryRequest } from './docker/registry'
import { handleTokenRequest } from './docker/token'
import { handleGitHubProxy } from './github/proxy'
import { loadConfig } from './config'
import { checkIP } from './utils/access'
import type { Env, FetchLike } from './types'

/**
 * 从请求头解析客户端 IP：
 * 优先取 CF-Connecting-IP（Cloudflare 入口注入），缺失时回退到 X-Forwarded-For 首项。
 * 两者皆无时返回空串（checkIP 对空串放行）。
 */
function clientIP(request: Request): string {
  const cfIP = request.headers.get('CF-Connecting-IP')
  if (cfIP !== null && cfIP.trim() !== '') return cfIP.trim()
  const xff = request.headers.get('X-Forwarded-For')
  if (xff !== null) {
    const first = xff.split(',')[0]?.trim() ?? ''
    if (first !== '') return first
  }
  return ''
}

/**
 * 构建请求处理器：按路径分发到各子处理器（Ruling A：子处理器各自 loadConfig，这里只做分发）。
 *
 * 入口先做 IP 黑名单拦截（Ruling B，spec §4.4 的消费点），命中即 403；
 * 然后按 pathname 路由：
 * - /ready → 200 JSON（健康检查，验收清单 step 0 用）
 * - /v2、/v2/* → Docker Registry 代理
 * - /token、/token/* → Docker token 换发
 * - 其余 → GitHub / Hugging Face 代理（catch-all）
 */
export function buildHandler(
  fetchFn: FetchLike,
): (request: Request, env: Env) => Promise<Response> {
  return async (request: Request, env: Env): Promise<Response> => {
    // 入口 IP 黑名单拦截：路由前先消费 Task 2 的 checkIP
    const access = checkIP(clientIP(request), loadConfig(env))
    if (!access.allowed) {
      return new Response(access.reason ?? 'forbidden', { status: 403 })
    }

    const path = new URL(request.url).pathname

    // 健康检查端点：验收清单 step 0 用 curl -I 探测
    if (path === '/ready') {
      return new Response(JSON.stringify({ ready: true, service: 'hubproxy-worker' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // Docker Registry API v2（/v2 与 /v2/*）
    if (path === '/v2' || path.startsWith('/v2/')) {
      return handleRegistryRequest(request, env, fetchFn)
    }

    // Docker token 换发（/token 与 /token/*）
    if (path === '/token' || path.startsWith('/token/')) {
      return handleTokenRequest(request, env, fetchFn)
    }

    // 其余路径一律走 GitHub / HF 代理（catch-all）
    return handleGitHubProxy(request, env, fetchFn)
  }
}

// 真实上游 fetch：直接透传全局 fetch，签名对齐 FetchLike
const realFetch: FetchLike = (input, init) => fetch(input as RequestInfo, init)

export default {
  fetch: buildHandler(realFetch),
}
