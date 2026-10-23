// ---------- 请求头处理 ----------

/**
 * 将客户端请求头拷贝到目标 Headers。
 * 跳过 `Host`：Workers 会按代理域名重写 Host，透传原始值会导致上游报错。
 */
export function copyIncomingHeaders(request: Request, headers: Headers): void {
  for (const [name, value] of request.headers.entries()) {
    if (name.toLowerCase() === 'host') continue
    headers.set(name, value)
  }
}

/** 深拷贝响应/请求头：新建 Headers 并复制全部条目，修改副本不影响源 */
export function passthroughHeaders(source: Headers): Headers {
  const headers = new Headers()
  for (const [name, value] of source.entries()) {
    headers.set(name, value)
  }
  return headers
}

// ---------- 响应头处理 ----------

/** 需要从透传响应中删除的安全策略头（CSP/HSTS 等对代理域名反而有害） */
const SECURITY_HEADERS = ['Content-Security-Policy', 'Referrer-Policy', 'Strict-Transport-Security'] as const

/** 原地删除安全策略头，其余头保留不动 */
export function cleanSecurityHeaders(headers: Headers): void {
  for (const name of SECURITY_HEADERS) {
    headers.delete(name)
  }
}

/** 需要拦截的 HTML/XML 媒体类型（对齐上游 src/handlers/github.go 的 blockedContentTypes） */
const BLOCKED_CONTENT_TYPES = new Set(['text/html', 'application/xhtml+xml', 'text/xml', 'application/xml'])

/** 判断 Content-Type 是否为 HTML/XML（拦截 GitHub 返回的 HTML/XML 响应，避免把页面当 API 响应透传） */
export function isBlockedHtml(contentType: string | null): boolean {
  if (!contentType) return false
  // 取分号前的媒体类型部分（忽略 charset 等参数）再比较
  const mediaType = contentType.split(';')[0].trim().toLowerCase()
  return BLOCKED_CONTENT_TYPES.has(mediaType)
}

/**
 * 重写 WWW-Authenticate 中的 realm 指向自建域名：
 * 将 `realm="..."` 的值替换为 `baseUrl + "/token"`，其余字段（service/scope 等）原样保留。
 * 无 realm 字段时返回原值。
 */
export function rewriteAuthRealm(authValue: string, baseUrl: string): string {
  // 用替换函数而非替换串，避免 baseUrl 中的 `$` 序列被特殊解释
  return authValue.replace(/(realm\s*=\s*")[^"]*(")/i, (_match, open: string, close: string) => `${open}${baseUrl}/token${close}`)
}

// ---------- 透传响应构造 ----------

/**
 * 基于上游响应构造原样透传的 Response：
 * 复制上游状态码与全部响应头，body 使用调用方提供的流。
 * `encodeBody: 'manual'` 禁止运行时对 body 重新压缩/转码，保证逐字节透传
 * （上游已带 Content-Length/Content-Encoding 等头时不会与之矛盾）。
 * `streamBody` 为 null 时（如 HEAD 响应）构造无 body 的响应。
 */
export function makePassthroughResponse(upstream: Response, streamBody: ReadableStream | null): Response {
  return new Response(streamBody, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: passthroughHeaders(upstream.headers),
    encodeBody: 'manual',
  })
}
