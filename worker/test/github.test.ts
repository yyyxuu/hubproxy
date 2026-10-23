import { describe, expect, it } from 'vitest'
import { checkGitHubURL, handleGitHubProxy, rewriteScriptBody } from '../src/github/proxy'
import type { Env, FetchLike } from '../src/types'

// ---------- 测试辅助 ----------

// 内存假 KV：handleGitHubProxy 不读写 KV，但 Env 类型要求 TOKENS/MANIFESTS 绑定
function makeFakeKV(): KVNamespace {
  const store = new Map<string, string>()
  const kv = {
    get: (key: string) => Promise.resolve(store.get(key) ?? null),
    put: (key: string, value: string, _opts?: { expirationTtl?: number }) => {
      store.set(key, value)
      return Promise.resolve()
    },
  }
  return kv as unknown as KVNamespace
}

// 构造 Env：可覆盖任意 var（如 MAX_FILE_SIZE、REPO_BLACKLIST）
function makeEnv(overrides: Partial<Env> = {}): Env {
  return { TOKENS: makeFakeKV(), MANIFESTS: makeFakeKV(), ...overrides }
}

// mock fetchFn：记录收到的上游 URL/请求头/init，按 URL 返回预设响应
function makeGithubFetch(handler: (url: string, init?: RequestInit) => Response | null) {
  const calls: Array<{ url: string; headers: Headers; init?: RequestInit }> = []
  const fetchFn: FetchLike = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const headers = new Headers(init?.headers)
    calls.push({ url, headers, init })
    const resp = handler(url, init)
    return resp ?? new Response('not found', { status: 404 })
  }
  return { calls, fetchFn }
}

// 用 Web API CompressionStream 生成 gzip 字节（避免引入 node:zlib 类型依赖）
async function gzipBytes(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

// ---------- checkGitHubURL ----------

describe('checkGitHubURL', () => {
  it('匹配 github.com release 路径，组为 owner/repo', () => {
    const m = checkGitHubURL('https://github.com/owner/repo/releases/download/v1/app.tar.gz')
    expect(m).not.toBeNull()
    expect(m![1]).toBe('owner')
    expect(m![2]).toBe('repo')
  })

  it('匹配 raw / archive / info / git-* 与 .git 后缀路径', () => {
    expect(checkGitHubURL('https://github.com/owner/repo/raw/main/x.sh')).not.toBeNull()
    expect(checkGitHubURL('https://github.com/owner/repo/archive/refs/heads/main.zip')).not.toBeNull()
    expect(checkGitHubURL('https://github.com/owner/repo/info/refs?service=git-upload-pack')).not.toBeNull()
    expect(checkGitHubURL('https://github.com/owner/repo.git/info/refs?service=git-upload-pack')).not.toBeNull()
  })

  it('匹配 raw.githubusercontent / gist / api.github.com / HF / cdn-lfs', () => {
    expect(checkGitHubURL('https://raw.githubusercontent.com/owner/repo/main/file')).not.toBeNull()
    expect(checkGitHubURL('https://gist.github.com/user/gistid')).not.toBeNull()
    expect(checkGitHubURL('https://api.github.com/repos/owner/repo/releases')).not.toBeNull()
    expect(checkGitHubURL('https://huggingface.co/org/model/resolve/main/x.bin')).not.toBeNull()
    expect(checkGitHubURL('https://cdn-lfs.hf.co/org/model/x')).not.toBeNull()
  })

  it('不匹配其他主机', () => {
    expect(checkGitHubURL('https://example.com/file.zip')).toBeNull()
  })
})

// ---------- rewriteScriptBody ----------

describe('rewriteScriptBody', () => {
  it('将 github.com / raw.githubusercontent.com URL 改写为代理域名，其余文本不变', () => {
    const input =
      '#!/bin/bash\n' +
      'curl -L https://github.com/foo/bar/raw/main/a.sh -o a.sh\n' +
      'curl -L https://raw.githubusercontent.com/x/y/main/z -o z\n' +
      'echo done\n'
    const out = rewriteScriptBody(input, 'hub.example.com')
    expect(out).toContain('https://hub.example.com/https://github.com/foo/bar/raw/main/a.sh')
    expect(out).toContain('https://hub.example.com/https://raw.githubusercontent.com/x/y/main/z')
    // 其余文本保持不变
    expect(out).toContain('#!/bin/bash')
    expect(out).toContain('-o a.sh')
    expect(out).toContain('-o z')
    expect(out).toContain('echo done')
  })
})

// ---------- handleGitHubProxy ----------

describe('handleGitHubProxy', () => {
  it('Review Focus 4：畸形 scheme（https:/）与双斜杠都能正确补全并转发', async () => {
    const { calls, fetchFn } = makeGithubFetch(() => new Response('data', { status: 200 }))
    // https:/ 畸形 scheme
    const r1 = await handleGitHubProxy(
      new Request('https://hub.example.com/https:/github.com/owner/repo/releases/download/v1/a.tar.gz'),
      makeEnv(),
      fetchFn,
    )
    expect(r1.status).toBe(200)
    expect(calls[0].url).toBe('https://github.com/owner/repo/releases/download/v1/a.tar.gz')

    // 双斜杠
    const r2 = await handleGitHubProxy(
      new Request('https://hub.example.com//github.com/owner/repo/raw/main/x'),
      makeEnv(),
      fetchFn,
    )
    expect(r2.status).toBe(200)
    expect(calls[1].url).toBe('https://github.com/owner/repo/raw/main/x')
  })

  it('Review Focus 1：info/refs 的 query 字符串原样转发到上游', async () => {
    const { calls, fetchFn } = makeGithubFetch(() => new Response('refs', { status: 200 }))
    const response = await handleGitHubProxy(
      new Request('https://hub.example.com/https://github.com/owner/repo/info/refs?service=git-upload-pack'),
      makeEnv(),
      fetchFn,
    )
    expect(response.status).toBe(200)
    expect(calls[0].url).toBe('https://github.com/owner/repo/info/refs?service=git-upload-pack')
  })

  it('release 下载（GET）：上游响应体流式透传、关键头（Content-Length/Content-Type）一致', async () => {
    const body = 'release-binary-data'
    const { calls, fetchFn } = makeGithubFetch(
      () =>
        new Response(body, {
          status: 200,
          headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(body.length) },
        }),
    )
    const response = await handleGitHubProxy(
      new Request('https://hub.example.com/https://github.com/owner/repo/releases/download/v1/app.tar.gz'),
      makeEnv(),
      fetchFn,
    )
    expect(response.status).toBe(200)
    expect(calls[0].url).toBe('https://github.com/owner/repo/releases/download/v1/app.tar.gz')
    // 手动重定向：非 GitHub 链接由服务端跟随
    expect(calls[0].init?.redirect).toBe('manual')
    await expect(response.text()).resolves.toBe(body)
    expect(response.headers.get('Content-Type')).toBe('application/octet-stream')
    expect(response.headers.get('Content-Length')).toBe(String(body.length))
  })

  it('blob 路径转发为 raw', async () => {
    const { calls, fetchFn } = makeGithubFetch(() => new Response('x', { status: 200 }))
    const response = await handleGitHubProxy(
      new Request('https://hub.example.com/https://github.com/owner/repo/blob/main/install.sh'),
      makeEnv(),
      fetchFn,
    )
    expect(response.status).toBe(200)
    expect(calls[0].url).toBe('https://github.com/owner/repo/raw/main/install.sh')
  })

  it('Review Focus 5：gzip 编码的 .sh 解压后含改写后的 URL，且无 Content-Encoding / Content-Length', async () => {
    const original = '#!/bin/bash\ncurl -L https://github.com/foo/bar/raw/main/a.sh -o a.sh\n'
    const gzipped = await gzipBytes(original)
    const { fetchFn } = makeGithubFetch(
      () =>
        new Response(gzipped, {
          status: 200,
          headers: { 'Content-Encoding': 'gzip', 'Content-Type': 'text/x-shellscript' },
        }),
    )
    const response = await handleGitHubProxy(
      new Request('https://hub.example.com/https://github.com/owner/repo/raw/main/install.sh'),
      makeEnv(),
      fetchFn,
    )
    const text = await response.text()
    expect(text).toContain('https://hub.example.com/https://github.com/foo/bar/raw/main/a.sh')
    expect(response.headers.get('Content-Encoding')).toBeNull()
    expect(response.headers.get('Content-Length')).toBeNull()
  })

  it('非 gzip 的 .sh 缓冲后改写 URL', async () => {
    const original = 'echo https://github.com/foo/bar/raw/main/a.sh'
    const { fetchFn } = makeGithubFetch(() => new Response(original, { status: 200 }))
    const response = await handleGitHubProxy(
      new Request('https://hub.example.com/https://github.com/owner/repo/raw/main/install.sh'),
      makeEnv(),
      fetchFn,
    )
    const text = await response.text()
    expect(text).toContain('https://hub.example.com/https://github.com/foo/bar/raw/main/a.sh')
  })

  it('上游 Content-Type: text/html 且 GET → 403', async () => {
    const { calls, fetchFn } = makeGithubFetch(
      () => new Response('<html></html>', { status: 200, headers: { 'Content-Type': 'text/html' } }),
    )
    const response = await handleGitHubProxy(
      new Request('https://hub.example.com/https://github.com/owner/repo/releases/download/v1/file'),
      makeEnv(),
      fetchFn,
    )
    expect(response.status).toBe(403)
    expect(calls).toHaveLength(1)
  })

  it('上游 302 且 Location 为 GitHub 链接 → 客户端 302，Location 改写为 /{location}', async () => {
    const { fetchFn } = makeGithubFetch(
      () => new Response(null, { status: 302, headers: { Location: 'https://github.com/other/repo/raw/main/x' } }),
    )
    const response = await handleGitHubProxy(
      new Request('https://hub.example.com/https://github.com/owner/repo/raw/main/y'),
      makeEnv(),
      fetchFn,
    )
    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toBe('/https://github.com/other/repo/raw/main/x')
  })

  it('非 GitHub Location → 服务端跟随，客户端看到最终 200 与 CDN body', async () => {
    const initialUrl = 'https://github.com/owner/repo/releases/download/v1/file'
    const cdnUrl = 'https://objects.githubusercontent.com/owner/repo/file'
    const cdnBody = 'cdn-binary-data'
    const { calls, fetchFn } = makeGithubFetch((url) => {
      if (url === initialUrl) {
        return new Response(null, { status: 302, headers: { Location: cdnUrl } })
      }
      if (url === cdnUrl) {
        return new Response(cdnBody, {
          status: 200,
          headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(cdnBody.length) },
        })
      }
      return null
    })
    const response = await handleGitHubProxy(
      new Request(`https://hub.example.com/${initialUrl}`),
      makeEnv(),
      fetchFn,
    )
    expect(response.status).toBe(200)
    // mock 收到两次请求：先原始 URL，再跟随到 CDN URL
    expect(calls).toHaveLength(2)
    expect(calls[0].url).toBe(initialUrl)
    expect(calls[1].url).toBe(cdnUrl)
    await expect(response.text()).resolves.toBe(cdnBody)
    expect(response.headers.get('Content-Type')).toBe('application/octet-stream')
    expect(response.headers.get('Content-Length')).toBe(String(cdnBody.length))
  })

  it('.sh URL 上游 302 到非 .sh 二进制 → 最终响应原样透传、不做改写', async () => {
    const shUrl = 'https://github.com/owner/repo/raw/main/install.sh'
    const binUrl = 'https://objects.githubusercontent.com/owner/repo/install.bin'
    const binBody = new Uint8Array([0x00, 0x01, 0x02, 0xff])
    const { calls, fetchFn } = makeGithubFetch((url) => {
      if (url === shUrl) {
        return new Response(null, { status: 302, headers: { Location: binUrl } })
      }
      if (url === binUrl) {
        return new Response(binBody, {
          status: 200,
          headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(binBody.length) },
        })
      }
      return null
    })
    const response = await handleGitHubProxy(
      new Request(`https://hub.example.com/${shUrl}`),
      makeEnv(),
      fetchFn,
    )
    expect(response.status).toBe(200)
    expect(calls).toHaveLength(2)
    expect(calls[1].url).toBe(binUrl)
    // 脚本分类按最终 URL（binUrl 非 .sh）→ 进入透传，字节与 Content-Type 原样保留
    expect(Buffer.from(await response.arrayBuffer()).equals(Buffer.from(binBody))).toBe(true)
    expect(response.headers.get('Content-Type')).toBe('application/octet-stream')
    expect(response.headers.get('Content-Length')).toBe(String(binBody.length))
  })

  it('重定向循环 → 返回 508，不挂起', async () => {
    const loopUrl = 'https://example.com/loop'
    const { calls, fetchFn } = makeGithubFetch(
      () => new Response(null, { status: 302, headers: { Location: loopUrl } }),
    )
    const response = await handleGitHubProxy(
      new Request('https://hub.example.com/https://github.com/owner/repo/releases/download/v1/file'),
      makeEnv(),
      fetchFn,
    )
    expect(response.status).toBe(508)
    // 首次请求 + MAX_REDIRECTS(10) 次跟随后触发上限，共 11 次
    expect(calls).toHaveLength(11)
  })

  it('Ruling E：br 编码的 .sh 原样透传、不做改写/解压', async () => {
    const body = 'echo https://github.com/foo/bar/raw/main/a.sh'
    const { fetchFn } = makeGithubFetch(
      () => new Response(body, { status: 200, headers: { 'Content-Encoding': 'br', 'Content-Type': 'text/plain' } }),
    )
    const response = await handleGitHubProxy(
      new Request('https://hub.example.com/https://github.com/owner/repo/raw/main/install.sh'),
      makeEnv(),
      fetchFn,
    )
    expect(response.status).toBe(200)
    // 保持 br 编码原样透传，body 未被改写（仍为原始 GitHub URL）
    expect(response.headers.get('Content-Encoding')).toBe('br')
    const text = await response.text()
    expect(text).toContain('https://github.com/foo/bar/raw/main/a.sh')
    expect(text).not.toContain('https://hub.example.com/https://github.com/foo/bar/raw/main/a.sh')
  })

  it('Ruling E：.ps1 与 .sh 同样被改写', async () => {
    const original = 'Write-Host https://github.com/foo/bar/raw/main/a.ps1'
    const { fetchFn } = makeGithubFetch(() => new Response(original, { status: 200 }))
    const response = await handleGitHubProxy(
      new Request('https://hub.example.com/https://github.com/owner/repo/raw/main/install.ps1'),
      makeEnv(),
      fetchFn,
    )
    const text = await response.text()
    expect(text).toContain('https://hub.example.com/https://github.com/foo/bar/raw/main/a.ps1')
  })

  it('不支持的主机（example.com）→ 403，且不访问上游', async () => {
    const { calls, fetchFn } = makeGithubFetch(() => new Response('x', { status: 200 }))
    const response = await handleGitHubProxy(
      new Request('https://hub.example.com/https://example.com/file.zip'),
      makeEnv(),
      fetchFn,
    )
    expect(response.status).toBe(403)
    expect(calls).toHaveLength(0)
  })

  it('api.github.com 路径透传客户端 Authorization 头', async () => {
    const { calls, fetchFn } = makeGithubFetch(() => new Response('{}', { status: 200 }))
    const response = await handleGitHubProxy(
      new Request('https://hub.example.com/https://api.github.com/repos/owner/repo/releases', {
        headers: { Authorization: 'Bearer t' },
      }),
      makeEnv(),
      fetchFn,
    )
    expect(response.status).toBe(200)
    expect(calls[0].headers.get('Authorization')).toBe('Bearer t')
  })

  it('非 api.github.com 路径剥离 Authorization 头', async () => {
    const { calls, fetchFn } = makeGithubFetch(() => new Response('x', { status: 200 }))
    const response = await handleGitHubProxy(
      new Request('https://hub.example.com/https://github.com/owner/repo/releases/download/v1/file', {
        headers: { Authorization: 'Bearer t' },
      }),
      makeEnv(),
      fetchFn,
    )
    expect(response.status).toBe(200)
    expect(calls[0].headers.get('Authorization')).toBeNull()
  })

  it('clone 透传（.git/info/refs）：二进制 body 与头字节一致、不做改写', async () => {
    const bodyBytes = new Uint8Array([0x00, 0x01, 0x02, 0xff, 0xfe, 0x0a])
    const { calls, fetchFn } = makeGithubFetch(
      () =>
        new Response(bodyBytes, {
          status: 200,
          headers: {
            'Content-Type': 'application/x-git-upload-pack-advertisement',
            'Content-Encoding': 'gzip',
            'Content-Length': String(bodyBytes.length),
            'Cache-Control': 'no-cache',
          },
        }),
    )
    const response = await handleGitHubProxy(
      new Request('https://hub.example.com/https://github.com/owner/repo.git/info/refs?service=git-upload-pack'),
      makeEnv(),
      fetchFn,
    )
    expect(response.status).toBe(200)
    expect(calls[0].url).toBe('https://github.com/owner/repo.git/info/refs?service=git-upload-pack')
    const buf = Buffer.from(await response.arrayBuffer())
    expect(buf.equals(Buffer.from(bodyBytes))).toBe(true)
    expect(response.headers.get('Content-Encoding')).toBe('gzip')
    expect(response.headers.get('Content-Type')).toBe('application/x-git-upload-pack-advertisement')
    expect(response.headers.get('Content-Length')).toBe(String(bodyBytes.length))
    expect(response.headers.get('Cache-Control')).toBe('no-cache')
  })

  it('Content-Length 超过 MAX_FILE_SIZE → 413', async () => {
    const { calls, fetchFn } = makeGithubFetch(
      () =>
        new Response('small', {
          status: 200,
          headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': '500' },
        }),
    )
    const response = await handleGitHubProxy(
      new Request('https://hub.example.com/https://github.com/owner/repo/releases/download/v1/big.bin'),
      makeEnv({ MAX_FILE_SIZE: '100' }),
      fetchFn,
    )
    expect(response.status).toBe(413)
    expect(calls).toHaveLength(1)
  })

  it('仓库黑名单命中 → 403，且不访问上游', async () => {
    const { calls, fetchFn } = makeGithubFetch(() => new Response('x', { status: 200 }))
    const response = await handleGitHubProxy(
      new Request('https://hub.example.com/https://github.com/owner/repo/releases/download/v1/file'),
      makeEnv({ REPO_BLACKLIST: 'owner/repo' }),
      fetchFn,
    )
    expect(response.status).toBe(403)
    expect(calls).toHaveLength(0)
  })
})
