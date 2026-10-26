// ---------- Docker Registry API v2 代理 ----------
import { loadConfig, type AppConfig } from '../config'
import {
  cleanSecurityHeaders,
  copyIncomingHeaders,
  makePassthroughResponse,
  rewriteAuthRealm,
} from '../utils/headers'
import { getCachedManifest, setCachedManifest } from '../utils/cache'
import type { Env, FetchLike } from '../types'

// Docker Hub 默认上游域名：repoPath 未命中配置表时的回退目标
const DEFAULT_DOMAIN = 'registry-1.docker.io'

// 缓存命中返回的 manifest Content-Type（对齐 brief 指定值）
const CACHED_MANIFEST_CONTENT_TYPE = 'application/vnd.docker.distribution.manifest.v2+json'

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

/**
 * 处理 Docker Registry API v2（/v2/*）请求：
 * /v2/ 本地应答 200；blobs/manifests/tags/list 转发上游；其余路径 404；非 GET/HEAD 一律 405。
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

  // /v2/ ping：
  // - 无 Authorization → 401 + Bearer challenge（对齐 Docker Hub 真实行为）。
  //   docker 客户端依据 ping 的 401 challenge 武装 Bearer token 认证；
  //   若这里返回 200（声称免认证），docker 不会进入 token 换发流程，
  //   后续 manifest 的 401 就会直接以 "unauthorized: authentication required" 失败。
  // - 带 Authorization → 转发到默认上游 /v2/ 验证 token，返回上游结果（有 token 时 200，与 Docker Hub 一致）
  if (path === '/v2' || path === '/v2/') {
    const baseUrl = `https://${url.host}`
    if (!request.headers.has('Authorization')) {
      return new Response(null, {
        status: 401,
        headers: {
          'Docker-Distribution-Api-Version': 'registry/2.0',
          'WWW-Authenticate': `Bearer realm="${baseUrl}/token",service="registry.docker.io"`,
        },
      })
    }
    const upstreamHost = cfg.upstreamRegistries[DEFAULT_DOMAIN]?.upstream ?? DEFAULT_DOMAIN
    const upstreamUrl = `https://${upstreamHost}/v2/${url.search}`
    const upstream = await fetchFn(buildUpstreamRequest(request, upstreamUrl), { redirect: 'follow' })
    return passthroughResponse(upstream, request.method === 'HEAD' ? null : upstream.body, baseUrl)
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
  // 401 响应的 realm 改写指向自建 token 端点：https://<请求 Host>/token
  const baseUrl = `https://${url.host}`
  const upstreamUrl = `https://${upstreamHost}/v2/${normalizedRepo}/${kind}/${ref}${url.search}`

  if (kind === 'blobs') {
    return handleBlob(request, fetchFn, upstreamUrl, baseUrl)
  }
  if (kind === 'manifests') {
    return handleManifest(request, env, fetchFn, cfg, upstreamUrl, baseUrl, `${domain}/${normalizedRepo}`, ref)
  }
  if (kind === 'tags' && ref === 'list') {
    return handleTags(request, fetchFn, upstreamUrl, baseUrl)
  }
  return new Response('not found', { status: 404 })
}

// 构造上游请求：拷贝客户端请求头（跳过 Host），保留原方法
function buildUpstreamRequest(request: Request, upstreamUrl: string): Request {
  const headers = new Headers()
  copyIncomingHeaders(request, headers)
  return new Request(upstreamUrl, { method: request.method, headers })
}

// blob：GET/HEAD 转发，服务端跟随 CDN 重定向后流式透传最终 body，绝不下发 3xx
async function handleBlob(request: Request, fetchFn: FetchLike, upstreamUrl: string, baseUrl: string): Promise<Response> {
  const upstream = await fetchFn(buildUpstreamRequest(request, upstreamUrl), { redirect: 'follow' })
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
  const upstream = await fetchFn(buildUpstreamRequest(request, upstreamUrl), { redirect: 'follow' })
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

// tags/list：原样转发
async function handleTags(request: Request, fetchFn: FetchLike, upstreamUrl: string, baseUrl: string): Promise<Response> {
  const upstream = await fetchFn(buildUpstreamRequest(request, upstreamUrl), { redirect: 'follow' })
  return passthroughResponse(upstream, upstream.body, baseUrl)
}

// 构造透传响应：复制上游状态码与全部响应头、流式 body、清理安全策略头；
// 401 时把 WWW-Authenticate 的 realm 改写为自建 token 端点
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
