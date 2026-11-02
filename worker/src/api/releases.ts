// ---------- GitHub Releases 解析 API ----------
import { jsonResponse, positiveInt } from './json'
import { loadConfig } from '../config'
import { checkRepoAccess } from '../utils/access'
import type { Env, FetchLike } from '../types'

// owner/repo：仅允许 GitHub 合法字符，避免路径注入
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
// 解析结果缓存时长（秒）：匿名 api.github.com 额度按出口 IP 共享，缓存可显著减少上游请求
const CACHE_TTL = 600

interface RawAsset {
  name?: string
  size?: number
  download_count?: number
  content_type?: string
  state?: string
}

interface RawRelease {
  tag_name?: string
  name?: string
  body?: string
  prerelease?: boolean
  draft?: boolean
  published_at?: string
  html_url?: string
  assets?: RawAsset[]
}

/**
 * GET /api/releases?repo=owner/repo&per_page=10
 *
 * 服务端向 api.github.com 取版本列表，资产下载地址统一改写为本 Worker 的加速路径，
 * 前端无需再拼接代理地址。
 */
export async function handleReleases(request: Request, env: Env, fetchFn: FetchLike): Promise<Response> {
  const url = new URL(request.url)
  const repo = (url.searchParams.get('repo') ?? '').trim().replace(/\.git$/, '')
  if (!REPO_RE.test(repo)) return jsonResponse({ error: '仓库格式应为 owner/repo' }, 400)

  const access = checkRepoAccess(repo, loadConfig(env))
  if (!access.allowed) return jsonResponse({ error: access.reason ?? '仓库被禁止访问' }, 403)

  const perPage = Math.min(positiveInt(url.searchParams.get('per_page'), 10), 30)

  // KV 缓存：key 带 host（资产下载地址按本站域名生成），减少对 api.github.com 的重复请求
  const cacheKey = `releases:${url.host}:${repo}:${perPage}`
  const cached = await env.MANIFESTS.get(cacheKey)
  if (cached !== null) {
    return new Response(cached, {
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Cache': 'HIT' },
    })
  }

  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'hubproxy-worker',
  }
  // 配置了 GITHUB_TOKEN 时用其提升 api.github.com 的速率上限（匿名额度按出口 IP 共享，很快耗尽）
  // trim：secret 用管道写入时可能带尾部换行，不裁剪会导致 401
  const token = env.GITHUB_TOKEN?.trim()
  if (token) headers.Authorization = `Bearer ${token}`

  let resp: Response
  try {
    resp = await fetchFn(`https://api.github.com/repos/${repo}/releases?per_page=${perPage}`, { headers })
  } catch {
    return jsonResponse({ error: '请求 GitHub API 失败，请稍后重试' }, 502)
  }
  if (resp.status === 404) return jsonResponse({ error: '仓库不存在或不可访问' }, 404)
  if (resp.status === 401) return jsonResponse({ error: 'GITHUB_TOKEN 无效或已过期，请重新设置 secret' }, 502)
  if (resp.status === 403 || resp.status === 429) {
    return jsonResponse({ error: 'GitHub API 触发频率限制，请稍后重试（可在部署配置中设置 GITHUB_TOKEN）' }, 429)
  }
  if (!resp.ok) return jsonResponse({ error: `GitHub API 请求失败（${resp.status}）` }, 502)

  const raw = (await resp.json().catch(() => null)) as RawRelease[] | null
  if (!Array.isArray(raw)) return jsonResponse({ error: 'GitHub API 响应解析失败' }, 502)

  const releases = raw
    .filter(release => release.draft !== true)
    .map(release => {
      const tag = release.tag_name ?? ''
      return {
        tag_name: tag,
        name: release.name || tag,
        prerelease: release.prerelease === true,
        published_at: release.published_at ?? '',
        html_url: release.html_url ?? '',
        notes: release.body ?? '',
        assets: (release.assets ?? [])
          .filter(asset => (asset.state ?? 'uploaded') === 'uploaded')
          .map(asset => {
            const name = asset.name ?? ''
            return {
              name,
              size: asset.size ?? 0,
              download_count: asset.download_count ?? 0,
              // 下载地址即 GitHub 原始路径，前置本 Worker 域名后由 catch-all 代理
              url:
                `https://${url.host}/https://github.com/${repo}/releases/download/` +
                `${encodeURIComponent(tag)}/${encodeURIComponent(name)}`,
            }
          }),
      }
    })

  const body = JSON.stringify({ repo, count: releases.length, releases })
  // 写缓存失败（如 KV 额度）不影响本次响应
  await env.MANIFESTS.put(cacheKey, body, { expirationTtl: CACHE_TTL }).catch(() => undefined)
  return new Response(body, {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Cache': 'MISS' },
  })
}
