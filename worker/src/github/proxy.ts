// ---------- GitHub / Hugging Face 代理（catch-all） ----------
import { loadConfig } from '../config'
import { checkRepoAccess } from '../utils/access'
import {
  cleanSecurityHeaders,
  copyIncomingHeaders,
  isBlockedHtml,
  makePassthroughResponse,
  passthroughHeaders,
} from '../utils/headers'
import type { Env, FetchLike } from '../types'

/**
 * GitHub/HF URL 匹配正则列表（对齐上游 src/handlers/github.go 的 githubExps）。
 * 覆盖：github.com 的 releases/archive/blob/raw/info/git-* 路径、
 * raw.githubusercontent.com、gist、api.github.com/repos、githubassets、
 * huggingface.co、cdn-lfs.hf.co。
 */
const GITHUB_EXPS: RegExp[] = [
  /^(?:https?:\/\/)?github\.com\/([^/]+)\/([^/]+)\/(?:releases|archive)\/.*/,
  /^(?:https?:\/\/)?github\.com\/([^/]+)\/([^/]+)\/(?:blob|raw)\/.*/,
  /^(?:https?:\/\/)?github\.com\/([^/]+)\/([^/]+)\/(?:info|git-).*/,
  /^(?:https?:\/\/)?raw\.github(?:usercontent|)\.com\/([^/]+)\/([^/]+)\/.+?\/.+/,
  /^(?:https?:\/\/)?gist\.(?:githubusercontent|github)\.com\/([^/]+)\/([^/]+).*/,
  /^(?:https?:\/\/)?api\.github\.com\/repos\/([^/]+)\/([^/]+)(?:\/.*)?/,
  /^(?:https?:\/\/)?huggingface\.co(?:\/spaces)?\/([^/]+)\/(.+)/,
  /^(?:https?:\/\/)?cdn-lfs\.hf\.co(?:\/spaces)?\/([^/]+)\/([^/]+)(?:\/(.*))?/,
  /^(?:https?:\/\/)?(github|opengraph)\.githubassets\.com\/([^/]+)\/.+?/,
]

// github.com 的 blob/raw 路径（用于 blob → raw 改写判断，对齐上游 githubExps[1]）
const GITHUB_BLOB_RAW_RE = /^(?:https?:\/\/)?github\.com\/[^/]+\/[^/]+\/(?:blob|raw)\/.*/

/**
 * 检查 URL 是否为受支持的 GitHub/HF 链接。
 * 返回完整匹配数组（[0] 为整串匹配，[1]/[2] 为 owner/repo 等捕获组），不匹配返回 null。
 */
export function checkGitHubURL(u: string): RegExpMatchArray | null {
  for (const exp of GITHUB_EXPS) {
    const matches = u.match(exp)
    if (matches !== null) return matches
  }
  return null
}

/**
 * 自动补全 https:// 协议头（对齐上游 src/handlers/github.go）。
 * 处理 http:/、https:/ 畸形前缀（剥掉协议段），双斜杠已在上游由剥前缀处理。
 */
function fixScheme(rawPath: string): string {
  // 已是完整 https:// 前缀则无需处理
  if (rawPath.startsWith('https://')) return rawPath
  // 畸形前缀（少一个斜杠）：http:/ 或 https:/
  if (rawPath.startsWith('http:/') || rawPath.startsWith('https:/')) {
    rawPath = rawPath.replace('http:/', '')
    rawPath = rawPath.replace('https:/', '')
  } else if (rawPath.startsWith('http://')) {
    rawPath = rawPath.slice('http://'.length)
  }
  return 'https://' + rawPath
}

// 需要改写为代理域名的脚本 URL 前缀（对齐上游 src/utils/proxy_shell.go 的 githubRegex）
const SCRIPT_URL_RE =
  /(?:^|[\s'"(=,\[{;|&<>])https?:\/\/(?:github\.com|raw\.githubusercontent\.com|raw\.github\.com|gist\.githubusercontent\.com|gist\.github\.com|api\.github\.com)[^\s'")]*/g

/** 将单个 GitHub URL 改写为经代理域名访问（对齐上游 transformURL） */
function transformScriptURL(url: string, host: string): string {
  // 已含代理域名则原样返回，防止重复改写
  if (url.includes(host)) return url
  if (url.startsWith('http://')) {
    url = 'https' + url.slice(4)
  } else if (!url.startsWith('https://') && !url.startsWith('//')) {
    url = 'https://' + url
  }
  let base = host
  if (!base.startsWith('http://') && !base.startsWith('https://')) {
    base = 'https://' + base
  }
  base = base.replace(/\/+$/, '')
  return base + '/' + url
}

/**
 * 改写脚本（.sh/.ps1）内的 GitHub URL 为代理域名（对齐上游 processGitHubURLs）。
 * 保留匹配开头的前缀分隔符（空白/引号等），避免破坏脚本语法。
 */
export function rewriteScriptBody(body: string, host: string): string {
  return body.replace(SCRIPT_URL_RE, (match) => {
    // 若匹配以分隔符开头（非 'h'），保留分隔符再改写其后的 URL
    if (match.length > 0 && match[0] !== 'h') {
      return match[0] + transformScriptURL(match.slice(1), host)
    }
    return transformScriptURL(match, host)
  })
}

// .sh / .ps1 结尾的脚本路径（对齐上游 HasSuffix 判断，脚本体积小允许整体缓冲改写）
function isScriptUrl(url: string): boolean {
  const lower = url.toLowerCase()
  return lower.endsWith('.sh') || lower.endsWith('.ps1')
}

// 服务端跟随重定向的最大次数（对齐上游 proxyGitHubWithRedirect 的 maxRedirects，改用 10）
const MAX_REDIRECTS = 10

/** 是否为带 Location 的 3xx 重定向响应 */
function isRedirect(resp: Response): boolean {
  return resp.status >= 300 && resp.status < 400 && resp.headers.get('Location') !== null
}

/**
 * GitHub / HF 代理入口（catch-all）：路径即目标 URL。
 *
 * 流程（对齐上游 src/handlers/github.go）：
 * 1. rawPath = pathname + search，剥掉开头所有 /
 * 2. 自动补 https://（处理 http:/、https:/ 畸形前缀与双斜杠）
 * 3. checkGitHubURL 不匹配 → 403；匹配则 checkRepoAccess（owner/name 去 .git）不过 → 403
 * 4. blob → raw 改写
 * 5. api.github.com 路径透传 Authorization 头，其他路径剥离；redirect: 'manual'
 * 6. 手动处理重定向：Location 为 GitHub/HF 链接 → 回 3xx 并把 Location 改写为 /{location}
 *    （客户端经本 Worker 再访问）；否则服务端跟随，上限 MAX_REDIRECTS 超出 → 508
 * 7. 对最终响应：GET 且上游为 HTML/XML → 403；Content-Length 超 cfg.maxFileSize → 413
 * 8. .sh/.ps1 按最终 URL（跟随后的 currentUrl）判定：gzip 先解压（失败 → 502）、再改写 URL，
 *    响应去掉 Content-Encoding/Content-Length；br/deflate 等其他编码不做改写
 * 9. clone（info/refs、git-*）与其余二进制：原样流式透传（encodeBody: 'manual'），绝不改写 body
 */
export async function handleGitHubProxy(request: Request, env: Env, fetchFn: FetchLike): Promise<Response> {
  const cfg = loadConfig(env)
  const requestUrl = new URL(request.url)
  // 脚本 URL 改写所用的公开主机名：优先取 Host 头，回退到请求 URL 主机
  const host = request.headers.get('Host') ?? requestUrl.host

  // 1. 取 pathname + search，剥掉开头所有 /
  let rawPath = requestUrl.pathname + requestUrl.search
  while (rawPath.startsWith('/')) {
    rawPath = rawPath.slice(1)
  }

  // 2. 自动补全 https://
  const fixedPath = fixScheme(rawPath)

  // 3. 识别 GitHub/HF URL 并做仓库访问控制
  const matches = checkGitHubURL(fixedPath)
  if (matches === null) {
    return new Response('forbidden', { status: 403 })
  }
  const owner = matches[1]
  const repoName = matches[2].replace(/\.git$/, '')
  const access = checkRepoAccess(`${owner}/${repoName}`, cfg)
  if (!access.allowed) {
    return new Response(access.reason ?? 'forbidden', { status: 403 })
  }

  // 4. blob 链接改写为 raw
  let upstreamUrl = fixedPath
  if (GITHUB_BLOB_RAW_RE.test(upstreamUrl) && upstreamUrl.includes('/blob/')) {
    upstreamUrl = upstreamUrl.replace('/blob/', '/raw/')
  }

  // 5. 构造上游请求：拷贝客户端头（跳过 Host）；仅 api.github.com 透传 Authorization
  const headers = new Headers()
  copyIncomingHeaders(request, headers)
  if (!upstreamUrl.startsWith('https://api.github.com/')) {
    headers.delete('Authorization')
  }
  const init: RequestInit = { method: request.method, headers, redirect: 'manual' }
  if (request.body !== null) {
    init.body = request.body
  }

  // 6. 手动处理重定向：GitHub/HF Location 回 3xx 经本 Worker 再访问；否则服务端跟随
  let currentUrl = upstreamUrl
  let redirectCount = 0
  let upstream = await fetchFn(currentUrl, init)
  while (isRedirect(upstream)) {
    const location = upstream.headers.get('Location')!
    if (checkGitHubURL(location) !== null) {
      // Location 指向受支持链接：改写为 /{location} 的 3xx 返回客户端（不做 body 改写）
      const redirectHeaders = passthroughHeaders(upstream.headers)
      cleanSecurityHeaders(redirectHeaders)
      redirectHeaders.set('Location', '/' + location)
      return new Response(upstream.body, {
        status: upstream.status,
        headers: redirectHeaders,
        encodeBody: 'manual',
      })
    }
    // 非 GitHub/HF 链接 → 服务端跟随（相对 Location 基于当前 URL 解析）
    redirectCount++
    if (redirectCount > MAX_REDIRECTS) {
      return new Response('重定向次数过多，可能存在循环重定向', { status: 508 })
    }
    currentUrl = new URL(location, currentUrl).toString()
    upstream = await fetchFn(currentUrl, init)
  }

  // 7. 最终响应：GET 且上游为 HTML/XML 类内容 → 403（避免把网页当代理内容透传）
  if (request.method === 'GET' && isBlockedHtml(upstream.headers.get('Content-Type'))) {
    return new Response('forbidden', { status: 403 })
  }

  // 8. Content-Length 超上限 → 413
  const contentLength = upstream.headers.get('Content-Length')
  if (contentLength !== null && Number(contentLength) > cfg.maxFileSize) {
    return new Response('too large', { status: 413 })
  }

  // 9. .sh/.ps1 按最终 URL（跟随后的 currentUrl）判定改写（Ruling E）
  if (isScriptUrl(currentUrl)) {
    const contentEncoding = upstream.headers.get('Content-Encoding')?.toLowerCase() ?? ''
    if (contentEncoding === 'gzip' || contentEncoding === '') {
      // 注意：CF Workers 运行时会对 fetch() 响应自动解压 gzip，但可能仍保留
      // Content-Encoding: gzip 头。因此不能仅凭头判断，需按 gzip 魔数(1f 8b)
      // 判断 body 是否真的是压缩字节（脚本体积小，允许整体缓冲）。
      let bodyText: string
      try {
        const raw = new Uint8Array(await upstream.arrayBuffer())
        if (contentEncoding === 'gzip' && raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b) {
          const decompressed = new Blob([raw]).stream().pipeThrough(new DecompressionStream('gzip'))
          bodyText = await new Response(decompressed).text()
        } else {
          bodyText = new TextDecoder().decode(raw)
        }
      } catch {
        // 对齐上游 github.go：脚本处理失败 → 502
        return new Response('脚本处理失败', { status: 502 })
      }
      const rewritten = rewriteScriptBody(bodyText, host)
      const scriptHeaders = passthroughHeaders(upstream.headers)
      cleanSecurityHeaders(scriptHeaders)
      scriptHeaders.delete('Content-Encoding')
      scriptHeaders.delete('Content-Length')
      scriptHeaders.set('Content-Type', 'text/plain')
      const scriptResponse = new Response(rewritten, { status: upstream.status, headers: scriptHeaders })
      // 运行时可能为字符串 body 自动补 Content-Length，显式删除确保与改写后的 body 不矛盾
      scriptResponse.headers.delete('Content-Length')
      return scriptResponse
    }
    // br/deflate 等其他编码：不做改写，落入下方原样透传
  }

  // 10. clone（info/refs、git-*）与其余二进制：原样流式透传，绝不改写 body
  const passthrough = makePassthroughResponse(upstream, request.method === 'HEAD' ? null : upstream.body)
  cleanSecurityHeaders(passthrough.headers)
  return passthrough
}
