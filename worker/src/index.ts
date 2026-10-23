import type { Env, FetchLike } from './types'

/**
 * 构建请求处理器。
 *
 * 当前为脚手架桩：对任意请求统一返回 404 "not found"。
 * 路由分发逻辑将在 Task 7 实现，届时通过 fetchFn 向上游注册表发起请求，
 * 并使用 env 中的 KV 命名空间（TOKENS / MANIFESTS）与访问控制配置。
 */
export function buildHandler(
  fetchFn: FetchLike,
): (request: Request, env: Env) => Promise<Response> {
  // fetchFn 暂未使用（路由在 Task 7 接入），显式标记为有意保留
  void fetchFn
  return async (_request: Request, _env: Env): Promise<Response> => {
    return new Response('not found', { status: 404 })
  }
}

// 真实上游 fetch：直接透传全局 fetch，签名对齐 FetchLike
const realFetch: FetchLike = (input, init) => fetch(input as RequestInfo, init)

export default {
  fetch: buildHandler(realFetch),
}
