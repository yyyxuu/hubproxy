// ---------- 镜像搜索 / 标签 API（对齐上游 src/handlers/search.go 的响应结构） ----------
import { jsonResponse, positiveInt } from './json'
import type { FetchLike } from '../types'

const HUB_API = 'https://registry.hub.docker.com/v2'

interface RawRepo {
  repo_name?: string
  short_description?: string
  is_official?: boolean
  star_count?: number
  pull_count?: number
  repo_owner?: string
  namespace?: string
}

interface RawTag {
  name?: string
  full_size?: number
  last_updated?: string
  images?: Array<{ architecture?: string; os?: string; variant?: string; size?: number }>
}

/** 规范化仓库信息：官方镜像归入 library，拆分命名空间与名称（对齐上游 normalizeRepository） */
function normalizeRepo(raw: RawRepo, nsHint = ''): {
  repo_name: string
  name: string
  namespace: string
  short_description: string
  is_official: boolean
  star_count: number
  pull_count: number
} {
  const rawName = (raw.repo_name ?? '').trim()
  const name = rawName.includes('/') ? rawName.slice(rawName.lastIndexOf('/') + 1) : rawName
  const official = raw.is_official === true
  const namespace = official
    ? 'library'
    : raw.namespace || nsHint || raw.repo_owner || rawName.slice(0, Math.max(rawName.lastIndexOf('/'), 0))

  return {
    repo_name: namespace ? `${namespace}/${name}` : name,
    name,
    namespace,
    short_description: raw.short_description ?? '',
    is_official: official,
    star_count: raw.star_count ?? 0,
    pull_count: raw.pull_count ?? 0,
  }
}

/**
 * GET /api/search?q=&page=&page_size=
 *
 * 查询含 `/` 时按命名空间列出仓库再按名称过滤（与上游一致）；
 * 其余查询走 Docker Hub 搜索接口。
 */
export async function handleSearch(request: Request, fetchFn: FetchLike): Promise<Response> {
  const url = new URL(request.url)
  const query = (url.searchParams.get('q') ?? '').trim()
  if (query === '') return jsonResponse({ error: '搜索关键词不能为空' }, 400)

  const page = positiveInt(url.searchParams.get('page'), 1)
  const pageSize = Math.min(positiveInt(url.searchParams.get('page_size'), 25), 100)

  const [ns, name] = query.includes('/') ? query.split('/', 2) : ['', '']
  const byNamespace = ns !== '' && name !== ''
  const upstream = byNamespace
    ? `${HUB_API}/repositories/${encodeURIComponent(ns)}/?page=${page}&page_size=${pageSize}`
    : `${HUB_API}/search/repositories/?query=${encodeURIComponent(query)}&page=${page}&page_size=${pageSize}`

  let resp: Response
  try {
    resp = await fetchFn(upstream, { headers: { Accept: 'application/json' } })
  } catch {
    return jsonResponse({ error: '请求 Docker Hub 失败，请稍后重试' }, 502)
  }
  if (resp.status === 404) return jsonResponse({ error: '未找到相关镜像' }, 404)
  if (resp.status === 429) return jsonResponse({ error: '请求过于频繁，请稍后重试' }, 429)
  if (!resp.ok) return jsonResponse({ error: `Docker Hub 请求失败（${resp.status}）` }, 502)

  const data = (await resp.json().catch(() => null)) as { count?: number; results?: RawRepo[] } | null
  if (data === null) return jsonResponse({ error: 'Docker Hub 响应解析失败' }, 502)
  let results = (data.results ?? []).map(raw => normalizeRepo(raw, byNamespace ? ns : ''))
  if (byNamespace) {
    const needle = name.toLowerCase()
    results = results.filter(r => r.namespace === ns && r.name.toLowerCase().includes(needle))
  }

  return jsonResponse({ count: results.length, results })
}

/**
 * GET /api/tags/:namespace/:name?page=&page_size=
 * 返回 { tags, has_more }，与上游 TagPageResult 一致。
 */
export async function handleTags(
  request: Request,
  fetchFn: FetchLike,
  namespace: string,
  name: string,
): Promise<Response> {
  if (namespace === '' || name === '') return jsonResponse({ error: '命名空间和名称不能为空' }, 400)

  const url = new URL(request.url)
  const page = positiveInt(url.searchParams.get('page'), 1)
  const pageSize = Math.min(positiveInt(url.searchParams.get('page_size'), 100), 100)
  const upstream =
    `${HUB_API}/repositories/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/tags` +
    `?page=${page}&page_size=${pageSize}&ordering=last_updated`

  let resp: Response
  try {
    resp = await fetchFn(upstream, { headers: { Accept: 'application/json' } })
  } catch {
    return jsonResponse({ error: '请求 Docker Hub 失败，请稍后重试' }, 502)
  }
  if (resp.status === 404) return jsonResponse({ error: '该镜像不存在或暂无标签' }, 404)
  if (!resp.ok) return jsonResponse({ error: `Docker Hub 请求失败（${resp.status}）` }, 502)

  const data = (await resp.json().catch(() => null)) as { next?: string | null; results?: RawTag[] } | null
  if (data === null) return jsonResponse({ error: 'Docker Hub 响应解析失败' }, 502)
  const tags = (data.results ?? []).map(tag => ({
    name: tag.name ?? '',
    full_size: tag.full_size ?? 0,
    last_updated: tag.last_updated ?? '',
    images: (tag.images ?? []).map(image => ({
      architecture: image.architecture ?? '',
      os: image.os ?? '',
      variant: image.variant ?? '',
      size: image.size ?? 0,
    })),
  }))

  return jsonResponse({ tags, has_more: Boolean(data.next) })
}
