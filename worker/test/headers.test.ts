import { describe, expect, it } from 'vitest'
import {
  cleanSecurityHeaders,
  copyIncomingHeaders,
  isBlockedHtml,
  makePassthroughResponse,
  passthroughHeaders,
  rewriteAuthRealm,
} from '../src/utils/headers'

describe('copyIncomingHeaders', () => {
  it('拷贝普通请求头', () => {
    const request = new Request('https://example.com/v2/', {
      headers: { Accept: 'application/json', 'User-Agent': 'docker/24' },
    })
    const headers = new Headers()
    copyIncomingHeaders(request, headers)
    expect(headers.get('Accept')).toBe('application/json')
    expect(headers.get('User-Agent')).toBe('docker/24')
  })

  it('不拷贝 Host 头', () => {
    const request = new Request('https://example.com/v2/', {
      headers: { Host: 'registry-1.docker.io', Accept: '*/*' },
    })
    const headers = new Headers()
    copyIncomingHeaders(request, headers)
    expect(headers.get('Host')).toBeNull()
    expect(headers.get('Accept')).toBe('*/*')
  })
})

describe('passthroughHeaders', () => {
  it('深拷贝所有条目到新 Headers 对象', () => {
    const source = new Headers({ 'Content-Type': 'application/json', Etag: '"abc"' })
    const copied = passthroughHeaders(source)
    expect(copied.get('Content-Type')).toBe('application/json')
    expect(copied.get('Etag')).toBe('"abc"')
    // 新对象而非原引用
    expect(copied).not.toBe(source)
  })

  it('修改副本不影响源，反之亦然', () => {
    const source = new Headers({ 'X-A': '1' })
    const copied = passthroughHeaders(source)
    copied.set('X-B', '2')
    expect(source.get('X-B')).toBeNull()
    source.set('X-C', '3')
    expect(copied.get('X-C')).toBeNull()
  })
})

describe('isBlockedHtml', () => {
  it('四种 HTML/XML 媒体类型均判定为需要拦截', () => {
    // 对齐上游 src/handlers/github.go 的 blockedContentTypes
    expect(isBlockedHtml('text/html')).toBe(true)
    expect(isBlockedHtml('text/html; charset=utf-8')).toBe(true)
    expect(isBlockedHtml('application/xhtml+xml')).toBe(true)
    expect(isBlockedHtml('text/xml')).toBe(true)
    expect(isBlockedHtml('application/xml')).toBe(true)
    expect(isBlockedHtml('application/xml; charset=utf-8')).toBe(true)
  })

  it('application/octet-stream 判定为放行', () => {
    expect(isBlockedHtml('application/octet-stream')).toBe(false)
  })

  it('null 与空串判定为放行', () => {
    expect(isBlockedHtml(null)).toBe(false)
    expect(isBlockedHtml('')).toBe(false)
  })
})

describe('rewriteAuthRealm', () => {
  it('替换 realm 为 baseUrl/token，保留 service 与 scope', () => {
    const rewritten = rewriteAuthRealm(
      'Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/nginx:pull"',
      'https://hub.example.com',
    )
    expect(rewritten).toBe(
      'Bearer realm="https://hub.example.com/token",service="registry.docker.io",scope="repository:library/nginx:pull"',
    )
  })

  it('不含 realm 时原样返回', () => {
    const value = 'Basic charset="utf-8"'
    expect(rewriteAuthRealm(value, 'https://hub.example.com')).toBe(value)
  })
})

describe('cleanSecurityHeaders', () => {
  it('删除 CSP/Referrer-Policy/HSTS，保留其他头', () => {
    const headers = new Headers({
      'Content-Security-Policy': "default-src 'none'",
      'Referrer-Policy': 'no-referrer',
      'Strict-Transport-Security': 'max-age=31536000',
      'Content-Type': 'application/vnd.docker.distribution.manifest.v2+json',
      'Content-Length': '1234',
    })
    cleanSecurityHeaders(headers)
    expect(headers.get('Content-Security-Policy')).toBeNull()
    expect(headers.get('Referrer-Policy')).toBeNull()
    expect(headers.get('Strict-Transport-Security')).toBeNull()
    expect(headers.get('Content-Type')).toBe('application/vnd.docker.distribution.manifest.v2+json')
    expect(headers.get('Content-Length')).toBe('1234')
  })
})

describe('makePassthroughResponse', () => {
  it('状态码与头部与上游一致，流式 body 原样透传', async () => {
    const upstream = new Response('hello body', {
      status: 200,
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': '10' },
    })
    const streamBody = upstream.body!
    // 构造不抛错（encodeBody: 'manual' 在 Node 测试环境被忽略，在 Workers 运行时生效）
    const passthrough = makePassthroughResponse(upstream, streamBody)
    expect(passthrough.status).toBe(200)
    expect(passthrough.headers.get('Content-Type')).toBe('application/octet-stream')
    // 只断言 headers 与上游一致（Content-Length 不被运行时改写）
    expect(passthrough.headers.get('Content-Length')).toBe('10')
    expect(await passthrough.text()).toBe('hello body')
  })

  it('streamBody 为 null（HEAD 等无 body 响应）时构造成功且 body 为空', async () => {
    const upstream = new Response(null, {
      status: 200,
      headers: { 'Content-Type': 'application/vnd.docker.distribution.manifest.v2+json' },
    })
    const passthrough = makePassthroughResponse(upstream, null)
    expect(passthrough.status).toBe(200)
    expect(passthrough.headers.get('Content-Type')).toBe('application/vnd.docker.distribution.manifest.v2+json')
    expect(await passthrough.text()).toBe('')
  })
})
