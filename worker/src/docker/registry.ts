// ---------- Docker Registry API v2 代理 ----------
// 认证策略：代理在服务端内部完成上游认证（对齐 Go 原版 go-containerregistry 的匿名拉取行为）。
// docker 看到的始终是一个「无需认证」的 registry：ping 200，manifest/blob 由代理换好 token 后
// 直接返回 200，不会把 401 挑战透传给 docker（docker 客户端对「ping 200 + manifest 401」的
// 代理场景不会自动换发 token，会导致 unauthorized）。
import { loadConfig, type AppConfig } from '../config'
import {
  cleanSecurityHeaders,
  copyIncomingHeaders,
  makePassthroughResponse,
  rewriteAuthRealm,
} from '../utils/headers'
import { getCachedManifest, getCachedToken, setCachedManifest, setCachedToken } from '../utils/cache'
import type { Env, FetchLike } from '../types'

// Docker Hub 默认上游域名：repoPath 未命中配置表时的回退目标
const DEFAULT_DOMAIN = 'registry-1.docker.io'

// 缓存命中返回的 manifest Content-Type（对齐 brief 指定值）
const CACHED_MANIFEST_CONTENT_TYPE = 'application/vnd.docker.distribution.manifest.v2+json'

// token 缓存有效期上限（秒）：上游 token 通常 ~300s，留出安全余量，过期后靠 401 重试自愈
const TOKEN_CACHE_TTL_CAP = 240

/**
 * 识别 repo 所属的上游注册表：
 * repoPath 首段命中 cfg.upstreamRegistries 且该映射 enabled=true 的域名（如 ghcr.io）→ 该域名为上游、repo 去掉首段；
 * 否则（未命中或 enabled=false）回退默认 registry-1.docker.io、repo 原样（对齐 Go 版 isRegistryEnabled 语义）。
 */
export function detectRegistry(repoPath: string, cfg: AppConfig): { domain: string; repo: string } {
  const first = repoPath.split('/')[0]
  if (first !== '' && cfg.upstreamRegistries[first]?.enabled === true) {
    return { domain: first, repo: repoPath.slice(first.length + 1) }
  }
  return { domain: DEFAULT_DOMAIN, repo: repoPath }
}

// 上游 token 服务名：Docker Hub 用 registry.docker.io，其余直接用注册表域名
function serviceName(domain: string): string {
  return domain === DEFAULT_DOMAIN ? 'registry.docker.io' : domain
}

/**
 * 处理 Docker Registry API v2（/v2/*）请求：
 * /v2/ 本地应答 200；blobs/manifests/tags/list 由代理内部认证后转发；其余路径 404；非 GET/HEAD 一律 405。
 * 处理器内部自行加载配置（Ruling A）。
 */
export async function handleRegistryRequest(request: Request, env: Env, fetchFn: FetchLike): Promise<Response> {
  const cfg = loadConfig(env)
  const url = new URL(request.url)
  const path = url.pathname

  // 仅支持 GET/HEAD，其余方法一律 405
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('method not allowed', { status: 405 })
  }

  // /v2/ ping：返回 200（对齐 Go 原版 c.JSON(200, gin.H{})）。上游认证由代理内部完成。
  if (path === '/v2' || path === '/v2/') {
    return new Response('{}', {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Docker-Distribution-Api-Version': 'registry/2.0',
      },
    })
  }

  // 其余路径必须以 /v2/ 开头，否则 404
  if (!path.startsWith('/v2/')) {
    return new Response('not found', { status: 404 })
  }

  // 从尾部解析 /v2/<name>/<kind>/<ref>：name 可含斜杠（library/nginx、ghcr.io/owner/app 等）
  const rest = path.slice('/v2/'.length)
  const parts = rest.split('/')
  if (parts.length < 3) return new Response('not found', { status: 404 })
  const ref = parts[parts.length - 1]
  const kind = parts[parts.length - 2]
  const name = parts.slice(0, parts.length - 2).join('/')
  if (name === '') return new Response('not found', { status: 404 })

  const { domain, repo } = detectRegistry(name, cfg)
  // Docker Hub 官方镜像在 registry API 中带 library/ 前缀（如 library/nginx），
  // 但 docker pull <自定义域名>/nginx 时客户端只请求 /v2/nginx/...（不会自动补 library/）。
  // 对齐 Docker Hub 语义：仅默认 Docker Hub 上游、且仓库名为单段时补 library/。
  const normalizedRepo = domain === DEFAULT_DOMAIN && !repo.includes('/') ? `library/${repo}` : repo
  // 上游 URL 主机取 mapping.upstream（key 与 upstream 可能不同，如 docker.io → registry-1.docker.io）
  const upstreamHost = cfg.upstreamRegistries[domain]?.upstream ?? domain
  const baseUrl = `https://${url.host}`
  const upstreamUrl = `https://${upstreamHost}/v2/${normalizedRepo}/${kind}/${ref}${url.search}`
  const service = serviceName(domain)
  const scope = `repository:${normalizedRepo}:pull`

  if (kind === 'blobs') {
    return handleBlob(request, env, fetchFn, cfg, upstreamUrl, baseUrl, service, scope)
  }
  if (kind === 'manifests') {
    return handleManifest(
      request,
      env,
      fetchFn,
      cfg,
      upstreamUrl,
      baseUrl,
      `${domain}/${normalizedRepo}`,
      ref,
      service,
      scope,
    )
  }
  if (kind === 'tags' && ref === 'list') {
    return handleTags(request, env, fetchFn, cfg, upstreamUrl, baseUrl, service, scope)
  }
  return new Response('not found', { status: 404 })
}

// 构造上游请求：拷贝客户端请求头（跳过 Host），忽略客户端 Authorization（代理使用自己的匿名 token）
function buildUpstreamRequest(request: Request, upstreamUrl: string, token: string | null): Request {
  const headers = new Headers()
  copyIncomingHeaders(request, headers)
  headers.delete('Authorization')
  if (token !== null) headers.set('Authorization', `Bearer ${token}`)
  return new Request(upstreamUrl, { method: request.method, headers })
}

// 代理内部完成上游认证：
// 1) 先查 KV 缓存 token；2) 上游若 401，从挑战里解析 realm/service/scope 换取 token；
// 3) 用新 token 重试一次（过期 token 自愈）。返回最终上游响应（通常已是 200）。
async function fetchUpstreamWithAuth(
  request: Request,
  env: Env,
  fetchFn: FetchLike,
  cfg: AppConfig,
  upstreamUrl: string,
  service: string,
  scope: string,
): Promise<Response> {
  const redirect = 'follow' as const
  const cachedToken = await getCachedToken(env, service, scope)
  let upstream = await fetchFn(buildUpstreamRequest(request, upstreamUrl, cachedToken), { redirect })
  if (upstream.status !== 401) return upstream

  // 上游 401：解析 Bearer 挑战（realm 为真实 auth 服务地址），换发 token 后重试一次
  const challenge = parseBearerChallenge(upstream.headers.get('WWW-Authenticate'))
  if (challenge.realm === '') return upstream
  const acquired = await fetchUpstreamToken(
    fetchFn,
    challenge.realm,
    challenge.service !== '' ? challenge.service : service,
    challenge.scope !== '' ? challenge.scope : scope,
  )
  if (acquired === null) return upstream
  const ttl = Math.max(1, Math.min(cfg.tokenCacheTTL, acquired.expiresIn - 30, TOKEN_CACHE_TTL_CAP))
  await setCachedToken(env, service, scope, acquired.token, ttl).catch(() => {})
  upstream = await fetchFn(buildUpstreamRequest(request, upstreamUrl, acquired.token), { redirect })
  return upstream
}

// 从上游 auth 服务换取 token；失败返回 null
async function fetchUpstreamToken(
  fetchFn: FetchLike,
  realm: string,
  service: string,
  scope: string,
): Promise<{ token: string; expiresIn: number } | null> {
  try {
    const u = new URL(realm)
    if (service !== '') u.searchParams.set('service', service)
    if (scope !== '') u.searchParams.set('scope', scope)
    const resp = await fetchFn(u.toString(), { method: 'GET', headers: { Accept: 'application/json' } })
    if (resp.status !== 200) return null
    const json: unknown = await resp.json()
    if (typeof json !== 'object' || json === null) return null
    const obj = json as { token?: unknown; access_token?: unknown; expires_in?: unknown }
    const token = typeof obj.token === 'string' ? obj.token : typeof obj.access_token === 'string' ? obj.access_token : null
    if (token === null) return null
    const expiresIn = typeof obj.expires_in === 'number' && obj.expires_in > 0 ? obj.expires_in : 300
    return { token, expiresIn }
  } catch {
    return null
  }
}

// 解析 WWW-Authenticate: Bearer realm="...",service="...",scope="..." → { realm, service, scope }
function parseBearerChallenge(header: string | null): { realm: string; service: string; scope: string } {
  const result = { realm: '', service: '', scope: '' }
  if (header === null) return result
  const bearer = header.match(/^Bearer\s+(.+)$/i)
  if (bearer === null) return result
  const attr = /(\w+)="([^"]*)"/g
  let m: RegExpExecArray | null
  while ((m = attr.exec(bearer[1])) !== null) {
    const key = m[1].toLowerCase()
    if (key === 'realm') result.realm = m[2]
    else if (key === 'service') result.service = m[2]
    else if (key === 'scope') result.scope = m[2]
  }
  return result
}

// blob：GET/HEAD 转发，服务端跟随 CDN 重定向后流式透传最终 body，绝不下发 3xx
async function handleBlob(
  request: Request,
  env: Env,
  fetchFn: FetchLike,
  cfg: AppConfig,
  upstreamUrl: string,
  baseUrl: string,
  service: string,
  scope: string,
): Promise<Response> {
  const upstream = await fetchUpstreamWithAuth(request, env, fetchFn, cfg, upstreamUrl, service, scope)
  // HEAD 响应无 body，显式传 null 保证客户端 body 为空
  return passthroughResponse(upstream, request.method === 'HEAD' ? null : upstream.body, baseUrl)
}

// manifests：ref 为 digest 时先查缓存；上游 200 且带 Docker-Content-Digest 时缓冲 body 写缓存
async function handleManifest(
  request: Request,
  env: Env,
  fetchFn: FetchLike,
  cfg: AppConfig,
  upstreamUrl: string,
  baseUrl: string,
  cacheRepo: string,
  ref: string,
  service: string,
  scope: string,
): Promise<Response> {
  // 缓存 key 按 Ruling C 带上游域名（如 registry-1.docker.io/library/nginx），避免跨注册表串
  if (ref.includes(':')) {
    const cached = await getCachedManifest(env, cacheRepo, ref)
    if (cached !== null) {
      const headers = { 'Content-Type': CACHED_MANIFEST_CONTENT_TYPE, 'Docker-Content-Digest': ref }
      // HEAD 请求缓存命中时返回无 body 响应（仅头）
      if (request.method === 'HEAD') {
        return new Response(null, { status: 200, headers })
      }
      return new Response(cached, { status: 200, headers })
    }
  }
  const upstream = await fetchUpstreamWithAuth(request, env, fetchFn, cfg, upstreamUrl, service, scope)
  // 仅 200 且带 digest 时缓存；manifest 体积小允许缓冲，clone 读取不影响原 body 透传。
  // HEAD 请求上游 body 为 null（fetch 规范），禁止写缓存，避免空 manifest 污染 KV。
  // 缓存是尽力而为的附加功能：KV put 失败绝不能让上游 200 响应失效，静默忽略。
  if (upstream.status === 200 && request.method !== 'HEAD') {
    const digest = upstream.headers.get('Docker-Content-Digest')
    if (digest) {
      const body = await upstream.clone().text()
      await setCachedManifest(env, cacheRepo, digest, body, cfg.manifestCacheTTL).catch(() => {})
    }
  }
  return passthroughResponse(upstream, upstream.body, baseUrl)
}

// tags/list：认证后转发
async function handleTags(
  request: Request,
  env: Env,
  fetchFn: FetchLike,
  cfg: AppConfig,
  upstreamUrl: string,
  baseUrl: string,
  service: string,
  scope: string,
): Promise<Response> {
  const upstream = await fetchUpstreamWithAuth(request, env, fetchFn, cfg, upstreamUrl, service, scope)
  return passthroughResponse(upstream, upstream.body, baseUrl)
}

// 构造透传响应：复制上游状态码与全部响应头、流式 body、清理安全策略头；
// 仍为 401 时（认证兜底失败）把 WWW-Authenticate 的 realm 改写为自建 token 端点
function passthroughResponse(upstream: Response, streamBody: ReadableStream | null, baseUrl: string): Response {
  const response = makePassthroughResponse(upstream, streamBody)
  cleanSecurityHeaders(response.headers)
  if (upstream.status === 401) {
    const auth = upstream.headers.get('WWW-Authenticate')
    if (auth) {
      response.headers.set('WWW-Authenticate', rewriteAuthRealm(auth, baseUrl))
    }
  }
  return response
}
