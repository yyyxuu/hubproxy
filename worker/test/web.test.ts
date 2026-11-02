import { describe, expect, it } from 'vitest'
import { buildHandler } from '../src/index'
import type { Env, FetchLike } from '../src/types'

// ---------- 测试辅助 ----------

function makeFakeKV(): KVNamespace {
  const store = new Map<string, string>()
  const kv = {
    get: (key: string) => Promise.resolve(store.get(key) ?? null),
    put: (key: string, value: string) => {
      store.set(key, value)
      return Promise.resolve()
    },
  }
  return kv as unknown as KVNamespace
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return { TOKENS: makeFakeKV(), MANIFESTS: makeFakeKV(), ...overrides }
}

// 按主机名返回假响应的 fetch：全部离线
function makeFetch(routes: Record<string, { status?: number; body: unknown }>) {
  const calls: Array<{ url: string; headers: Headers }> = []
  const fetchFn: FetchLike = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    calls.push({ url, headers: new Headers(init?.headers ?? {}) })
    const route = routes[new URL(url).hostname]
    if (!route) return new Response('not found', { status: 404 })
    return new Response(JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  return { calls, fetchFn }
}

const HUB_ENTRY = 'hub.example.com'

// ---------- 内置 Web 界面 ----------

describe('GET / 内置 Web 界面', () => {
  it('返回 HTML，包含链接转换 / Releases / 镜像搜索三个区块', async () => {
    const handler = buildHandler(makeFetch({}).fetchFn)
    const res = await handler(new Request(`https://${HUB_ENTRY}/`), makeEnv())
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('text/html')
    const html = await res.text()
    for (const marker of ['转换链接', 'Releases 版本与资产下载', '镜像搜索', '/api/releases', '/api/search']) {
      expect(html).toContain(marker)
    }
  })

  it('GET /index.html 同样返回界面', async () => {
    const handler = buildHandler(makeFetch({}).fetchFn)
    const res = await handler(new Request(`https://${HUB_ENTRY}/index.html`), makeEnv())
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('HubProxy')
  })

  it('镜像搜索页与标签详情页（/search、/search/:ns/:name）返回同一份界面', async () => {
    const handler = buildHandler(makeFetch({}).fetchFn)
    for (const path of ['/search', '/search/library/nginx']) {
      const res = await handler(new Request(`https://${HUB_ENTRY}${path}`), makeEnv())
      expect(res.status).toBe(200)
      expect(res.headers.get('Content-Type')).toContain('text/html')
      const html = await res.text()
      expect(html).toContain('viewDetail')
      expect(html).toContain('复制镜像名')
    }
  })

  it('GET /favicon.ico 返回图标字节（与主项目 favicon 一致）', async () => {
    const handler = buildHandler(makeFetch({}).fetchFn)
    const res = await handler(new Request(`https://${HUB_ENTRY}/favicon.ico`), makeEnv())
    expect(res.status).toBe(200)
    const bytes = new Uint8Array(await res.arrayBuffer())
    expect(bytes.length).toBe(2092)
    // web/public/favicon.ico 实际是 PNG（89 50 4E 47），按魔数返回 Content-Type
    expect([bytes[0], bytes[1], bytes[2], bytes[3]]).toEqual([0x89, 0x50, 0x4e, 0x47])
    expect(res.headers.get('Content-Type')).toBe('image/png')
  })

  it('sticky 只作用于站点头部：不存在裸 header 选择器（避免版本标题吸顶盖住菜单栏）', async () => {
    const handler = buildHandler(makeFetch({}).fetchFn)
    const html = await (await handler(new Request(`https://${HUB_ENTRY}/`), makeEnv())).text()
    expect(html).toContain('.site-header{position:sticky')
    // 裸标签选择器 `header{...}`（前面不是 .site- 之类的复合选择器）会让 release 内的 <header> 也吸顶
    expect(/(^|[;}])\s*header\{/.test(html)).toBe(false)
    // 界面不缓存，部署后立即生效
    const res = await handler(new Request(`https://${HUB_ENTRY}/`), makeEnv())
    expect(res.headers.get('Cache-Control')).toBe('no-store')
  })

  it('未知 /api/* 路径返回 404 JSON，不再落到 GitHub catch-all 的 403', async () => {
    const handler = buildHandler(makeFetch({}).fetchFn)
    const res = await handler(new Request(`https://${HUB_ENTRY}/api/nope`), makeEnv())
    expect(res.status).toBe(404)
    await expect(res.json()).resolves.toEqual({ error: '接口不存在' })
  })
})

// ---------- 镜像搜索 / 标签 ----------

describe('GET /api/search', () => {
  it('代理 Docker Hub 搜索并规范化官方镜像（library 命名空间）', async () => {
    const { calls, fetchFn } = makeFetch({
      'registry.hub.docker.com': {
        body: {
          count: 1,
          results: [{ repo_name: 'nginx', short_description: 'Official build', is_official: true, star_count: 10, pull_count: 20 }],
        },
      },
    })
    const handler = buildHandler(fetchFn)
    const res = await handler(new Request(`https://${HUB_ENTRY}/api/search?q=nginx`), makeEnv())
    expect(res.status).toBe(200)
    expect(calls[0].url).toBe(
      'https://registry.hub.docker.com/v2/search/repositories/?query=nginx&page=1&page_size=25',
    )
    await expect(res.json()).resolves.toEqual({
      count: 1,
      results: [
        {
          repo_name: 'library/nginx',
          name: 'nginx',
          namespace: 'library',
          short_description: 'Official build',
          is_official: true,
          star_count: 10,
          pull_count: 20,
        },
      ],
    })
  })

  it('查询含 / 时按命名空间列出仓库并按名称过滤', async () => {
    const { calls, fetchFn } = makeFetch({
      'registry.hub.docker.com': {
        body: {
          count: 2,
          results: [{ repo_name: 'app' }, { repo_name: 'app2' }, { repo_name: 'other' }],
        },
      },
    })
    const handler = buildHandler(fetchFn)
    const res = await handler(new Request(`https://${HUB_ENTRY}/api/search?q=user/app`), makeEnv())
    expect(res.status).toBe(200)
    expect(calls[0].url).toBe(
      'https://registry.hub.docker.com/v2/repositories/user/?page=1&page_size=25',
    )
    const data = (await res.json()) as { count: number; results: Array<{ repo_name: string }> }
    expect(data.count).toBe(2)
    expect(data.results.map(r => r.repo_name)).toEqual(['user/app', 'user/app2'])
  })

  it('缺少 q 返回 400', async () => {
    const handler = buildHandler(makeFetch({}).fetchFn)
    const res = await handler(new Request(`https://${HUB_ENTRY}/api/search`), makeEnv())
    expect(res.status).toBe(400)
  })

  it('上游 404 映射为 404 未找到', async () => {
    const handler = buildHandler(makeFetch({ 'registry.hub.docker.com': { status: 404, body: {} } }).fetchFn)
    const res = await handler(new Request(`https://${HUB_ENTRY}/api/search?q=zzz`), makeEnv())
    expect(res.status).toBe(404)
    await expect(res.json()).resolves.toEqual({ error: '未找到相关镜像' })
  })
})

describe('GET /api/tags/:namespace/:name', () => {
  it('透传分页参数并映射为 { tags, has_more }', async () => {
    const { calls, fetchFn } = makeFetch({
      'registry.hub.docker.com': {
        body: {
          next: 'https://registry.hub.docker.com/v2/...page=3',
          results: [
            {
              name: '1.27-alpine',
              full_size: 12345,
              last_updated: '2026-01-02T03:04:05Z',
              images: [{ architecture: 'amd64', os: 'linux', size: 12345 }],
            },
          ],
        },
      },
    })
    const handler = buildHandler(fetchFn)
    const res = await handler(new Request(`https://${HUB_ENTRY}/api/tags/library/nginx?page=2`), makeEnv())
    expect(res.status).toBe(200)
    expect(calls[0].url).toBe(
      'https://registry.hub.docker.com/v2/repositories/library/nginx/tags?page=2&page_size=100&ordering=last_updated',
    )
    const data = (await res.json()) as { tags: Array<{ name: string }>; has_more: boolean }
    expect(data.has_more).toBe(true)
    expect(data.tags[0].name).toBe('1.27-alpine')
  })

  it('路径段数不足返回 400', async () => {
    const handler = buildHandler(makeFetch({}).fetchFn)
    const res = await handler(new Request(`https://${HUB_ENTRY}/api/tags/nginx`), makeEnv())
    expect(res.status).toBe(400)
  })
})

// ---------- GitHub Releases ----------

const RELEASE_FIXTURE = [
  {
    tag_name: 'v1.2.5',
    name: 'HubProxy v1.2.5',
    body: '修复若干问题',
    prerelease: false,
    draft: false,
    published_at: '2026-07-13T03:54:00Z',
    html_url: 'https://github.com/sky22333/hubproxy/releases/tag/v1.2.5',
    assets: [
      { name: 'hubproxy-linux-amd64.tar.gz', size: 7060000, download_count: 379, state: 'uploaded' },
      { name: 'draft.bin', size: 1, download_count: 0, state: 'starter' },
    ],
  },
  { tag_name: 'v1.2.0', name: '', draft: true, assets: [] },
]

describe('GET /api/releases', () => {
  it('解析 api.github.com 并改写资产下载地址为本站加速路径', async () => {
    const { calls, fetchFn } = makeFetch({ 'api.github.com': { body: RELEASE_FIXTURE } })
    const handler = buildHandler(fetchFn)
    const res = await handler(
      new Request(`https://${HUB_ENTRY}/api/releases?repo=sky22333/hubproxy`),
      makeEnv(),
    )
    expect(res.status).toBe(200)
    expect(calls[0].url).toBe('https://api.github.com/repos/sky22333/hubproxy/releases?per_page=10')
    expect(calls[0].headers.get('User-Agent')).toBe('hubproxy-worker')

    const data = (await res.json()) as {
      repo: string
      count: number
      releases: Array<{ tag_name: string; name: string; assets: Array<{ name: string; url: string; download_count: number; size: number }> }>
    }
    expect(data.repo).toBe('sky22333/hubproxy')
    // 草稿版本被过滤
    expect(data.count).toBe(1)
    expect(data.releases[0].name).toBe('HubProxy v1.2.5')
    // 非 uploaded 状态的资产被过滤
    expect(data.releases[0].assets).toHaveLength(1)
    expect(data.releases[0].assets[0]).toEqual({
      name: 'hubproxy-linux-amd64.tar.gz',
      size: 7060000,
      download_count: 379,
      url: 'https://hub.example.com/https://github.com/sky22333/hubproxy/releases/download/v1.2.5/hubproxy-linux-amd64.tar.gz',
    })
  })

  it('仓库格式非法返回 400', async () => {
    const handler = buildHandler(makeFetch({}).fetchFn)
    const res = await handler(new Request(`https://${HUB_ENTRY}/api/releases?repo=bad`), makeEnv())
    expect(res.status).toBe(400)
  })

  it('仓库命中黑名单返回 403', async () => {
    const handler = buildHandler(makeFetch({}).fetchFn)
    const res = await handler(
      new Request(`https://${HUB_ENTRY}/api/releases?repo=bad/repo`),
      makeEnv({ REPO_BLACKLIST: 'bad/*' }),
    )
    expect(res.status).toBe(403)
    await expect(res.json()).resolves.toEqual({ error: '仓库在黑名单中' })
  })

  it('上游 404 映射为 404 仓库不存在', async () => {
    const handler = buildHandler(makeFetch({ 'api.github.com': { status: 404, body: {} } }).fetchFn)
    const res = await handler(new Request(`https://${HUB_ENTRY}/api/releases?repo=a/b`), makeEnv())
    expect(res.status).toBe(404)
    await expect(res.json()).resolves.toEqual({ error: '仓库不存在或不可访问' })
  })

  it('配置 GITHUB_TOKEN 时以 Bearer 转发', async () => {
    const { calls, fetchFn } = makeFetch({ 'api.github.com': { body: [] } })
    const handler = buildHandler(fetchFn)
    await handler(new Request(`https://${HUB_ENTRY}/api/releases?repo=a/b`), makeEnv({ GITHUB_TOKEN: 'ghp_x' }))
    expect(calls[0].headers.get('Authorization')).toBe('Bearer ghp_x')
  })

  it('解析结果缓存到 KV：第二次请求命中缓存且不再访问上游', async () => {
    const { calls, fetchFn } = makeFetch({ 'api.github.com': { body: RELEASE_FIXTURE } })
    const handler = buildHandler(fetchFn)
    const env = makeEnv()

    const first = await handler(new Request(`https://${HUB_ENTRY}/api/releases?repo=a/b`), env)
    expect(first.headers.get('X-Cache')).toBe('MISS')
    const second = await handler(new Request(`https://${HUB_ENTRY}/api/releases?repo=a/b`), env)
    expect(second.headers.get('X-Cache')).toBe('HIT')
    expect(calls).toHaveLength(1)
    await expect(second.json()).resolves.toEqual(await first.json())
  })
})
