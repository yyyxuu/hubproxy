# HubProxy Cloudflare Worker 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 HubProxy 的核心功能（GitHub 加速 + Docker 镜像拉取加速）重写为 TypeScript Cloudflare Worker，部署在用户自定义域名上，个人使用，免费计划内运行。

**Architecture:** 单个 Worker + 单个子域名，所有流量进一个 `fetch` handler 按路径分发：`/v2/*`、`/token*` → Docker Registry 代理（流式转发 + 服务端跟随 CDN 重定向 + Token/Manifest 缓存到 KV）；其余 → GitHub/HF 代理 catch-all（含 `.sh`/`.ps1` URL 改写、api.github.com Token 透传、git clone 字节精确透传）。上游访问通过注入的 `FetchLike` 函数，便于本地 mock 测试。

**Tech Stack:** TypeScript（strict）、Cloudflare Workers（wrangler）、Cloudflare KV（Token/Manifest 缓存）、vitest（纯本地、无网络依赖测试）、`@cloudflare/workers-types`。无运行时依赖。

**Spec:** `docs/superpowers/specs/2026-10-23-hubproxy-worker-design.md`（本计划以其为依据，执行者需同时阅读 spec 与本计划）

## Global Constraints

- 仅 TypeScript；strict 模式；**无运行时依赖**（dependencies 为空，只用 devDependencies：`wrangler`、`typescript`、`@cloudflare/workers-types`、`vitest`）
- Node >= 24（沿用仓库 engines 约定）；`worker/` 目录内独立 `package.json`
- 代码注释、日志、用户可见文案用中文（沿用仓库惯例）
- **本地测试绝不访问真实网络**：所有处理器通过注入的 `FetchLike` 调上游；KV 通过缓存函数读取 `Env` 上的 KV 绑定，测试里用内存假 KV
- 流式处理大响应，绝不整体缓冲（仅 `.sh`/`.ps1` 脚本体与 manifest（小 JSON）允许缓冲）
- 原 Go 实现（`src/`、`web/`、`docs/`）一律不动
- URL 解析用 WHATWG `URL`，不要手写字符串切 query

## Review Focus

以下输入类/失败模式是 spec 隐含但单看各任务容易漏测的，已在对应任务里补了测试：

1. **Query 字符串必须原样转发**：docker `/token?service=...&scope=...`、git `/info/refs?service=git-upload-pack` 都靠 query。→ Task 4、Task 6
2. **HEAD 请求只回头不回体**：docker 对 blob 发 HEAD。→ Task 5
3. **IPv4 映射的 IPv6（`::ffff:a.b.c.d`）要按 IPv4 处理**，不能被 /64 掩码搞坏。→ Task 2
4. **畸形 scheme / 双斜杠不能破坏自动补全**：`https:/github.com`、`//github.com/...`。→ Task 6
5. **gzip 编码的 `.sh` 脚本要先解压再改写 URL**，并清除 `Content-Encoding`/`Content-Length`。→ Task 6

---

### Task 1: 项目脚手架与测试环境

**Files:**
- Create: `worker/package.json`
- Create: `worker/tsconfig.json`
- Create: `worker/wrangler.toml`
- Create: `worker/vitest.config.ts`
- Create: `worker/src/types.ts`
- Create: `worker/src/index.ts`
- Create: `worker/test/smoke.test.ts`
- Modify: `.gitignore`（追加 `worker/node_modules/`、`worker/.wrangler/`、`worker/.dev.vars`、`worker/wrangler.local.json`）

**Interfaces:**
- Consumes: 无
- Produces: `src/types.ts` 定义 `Env`、`FetchLike`、`RegistryMapping`；`src/index.ts` 导出 `buildHandler(fetchFn: FetchLike): (request: Request, env: Env) => Promise<Response>` 与 `default { fetch }`

- [ ] **Step 1: 创建 `worker/package.json`**

```jsonc
{
  "name": "hubproxy-worker",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24" },
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "cf-typegen": "wrangler types"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4",
    "typescript": "^5",
    "vitest": "^3",
    "wrangler": "^4"
  }
}
```

- [ ] **Step 2: 创建 `worker/tsconfig.json`**（strict、`moduleResolution: "bundler"`、`module: "ESNext"`、`target: "ES2022"`、`types: ["@cloudflare/workers-types"]`、`noEmit: true`、`include: ["src", "test", "vitest.config.ts"]`）

- [ ] **Step 3: 创建 `worker/wrangler.toml`**（`name = "hubproxy-worker"`、`main = "src/index.ts"`、`compatibility_date` 用当前最新日期、`kv_namespaces` 两个占位：`TOKENS`、`MANIFESTS`，id 留空并注释"部署前先 `wrangler kv namespace create` 填入"；vars 占位注释列出 Task 8 会填的默认值）

- [ ] **Step 4: 创建 `worker/vitest.config.ts`**（`environment: 'node'`，test 目录 `test/`）

- [ ] **Step 5: 创建 `worker/src/types.ts`**

```ts
export interface Env {
  UPSTREAM_REGISTRIES?: string // JSON: Record<domain, RegistryMapping>
  MAX_FILE_SIZE?: string
  IP_WHITELIST?: string // 逗号分隔
  IP_BLACKLIST?: string
  REPO_WHITELIST?: string
  REPO_BLACKLIST?: string
  TOKEN_CACHE_TTL?: string // 秒
  MANIFEST_CACHE_TTL?: string // 秒
  TOKENS: KVNamespace
  MANIFESTS: KVNamespace
}

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export interface RegistryMapping {
  upstream: string
  authHost: string
  authType: string
  enabled: boolean
}
```

- [ ] **Step 6: 创建 `worker/src/index.ts` 桩**：`buildHandler(fetchFn)` 返回的 handler 对任意请求返回 `404 "not found"`；`export default { fetch: buildHandler(realFetch) }`，其中 `realFetch` 就是 `(input, init) => fetch(input as RequestInfo, init)`。注释用中文，标明路由会在 Task 7 实现。

- [ ] **Step 7: 创建 `worker/test/smoke.test.ts`**：`buildHandler(async () => new Response("x", { status: 200 }))` 处理一个 `new Request("https://example.com/")`，断言返回 404。目的是验证测试环境可用。

- [ ] **Step 8: 运行验证并提交**

Run: `npm install`；`npm run typecheck`；`npm test`
Expected: install 成功；typecheck 无错误；vitest 1 个测试 PASS

```bash
git add .gitignore worker/
git commit -m "feat(worker): scaffold hubproxy worker with vitest harness"
```

---

### Task 2: 配置解析与访问控制

**Files:**
- Create: `worker/src/config.ts`
- Create: `worker/src/utils/access.ts`
- Test: `worker/test/config.test.ts`
- Test: `worker/test/access.test.ts`

**Interfaces:**
- Consumes: `Env`（Task 1）
- Produces: `config.ts` → `AppConfig`（字段见 Step 1）与 `loadConfig(env: Env): AppConfig`；`access.ts` → `normalizeIPv6(ip: string): string`、`matchesList(value: string, list: string[]): boolean`、`checkIP(ip: string, cfg: AppConfig): { allowed: boolean; reason?: string }`、`wildcardMatch(pattern: string, value: string): boolean`、`checkRepoAccess(repo: string, cfg: AppConfig): { allowed: boolean; reason?: string }`

- [ ] **Step 1: 先写 `worker/src/config.ts` 的测试（`config.test.ts`）**

断言（用精确值）：
- 空 env 时默认：`maxFileSize === 2147483648`（2GB）、`tokenCacheTTL === 1200`、`manifestCacheTTL === 3600`
- 默认注册表包含：`registry-1.docker.io`（upstream，authHost `https://auth.docker.io/token`）、`ghcr.io`（upstream `ghcr.io`，authHost `https://ghcr.io/token`）、`gcr.io`（authHost `https://gcr.io/v2/token`）、`quay.io`（authHost `https://quay.io/v2/auth`）、`registry.k8s.io`（authHost `https://registry.k8s.io/v2/`）
- `UPSTREAM_REGISTRIES` 为合法 JSON 时覆盖默认注册表；为非法 JSON 时回退默认且不抛错
- `IP_WHITELIST`/`IP_BLACKLIST` 逗号分隔被解析为数组；`MAX_FILE_SIZE`/`TOKEN_CACHE_TTL`/`MANIFEST_CACHE_TTL` 非法值回退默认

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL（`loadConfig`/`AppConfig` 未定义）

- [ ] **Step 3: 实现 `worker/src/config.ts`**

`AppConfig`：`{ upstreamRegistries: Record<string, RegistryMapping>; maxFileSize: number; ipWhiteList: string[]; ipBlackList: string[]; repoWhiteList: string[]; repoBlackList: string[]; tokenCacheTTL: number; manifestCacheTTL: number }`。`loadConfig` 从 `Env` 读 vars，`JSON.parse(UPSTREAM_REGISTRIES)` 覆盖默认注册表（try/catch 回退）。默认注册表值取自 spec §4.1 与上游 Go 版 `src/config/config.go` 的 `DefaultConfig`。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/config.test.ts`
Expected: PASS

- [ ] **Step 5: 先写 `worker/src/utils/access.ts` 的测试（`access.test.ts`）**

断言（Review Focus 3 在这里）：
- `normalizeIPv6("2001:db8:85a3::8a2e:370:7334")` 掩成 /64（断言前 4 组 16 进制保留、其余为 0，如 `2001:db8:85a3::`）
- `normalizeIPv6("::ffff:192.168.1.1")` 返回 `192.168.1.1`（按 IPv4 处理）
- `normalizeIPv6("192.168.1.1")` 原样返回
- `matchesList`：精确匹配 true；`192.168.100.0/24` CIDR 内 true、外 false
- `checkIP`：黑名单里的 IP → `allowed: false`；黑名单外 → `allowed: true`
- `wildcardMatch("*/malicious-repo", "anyuser/malicious-repo")` true；`wildcardMatch("baduser/*", "baduser/anything")` true；`wildcardMatch("baduser/*", "other/anything")` false
- `checkRepoAccess("baduser/app", {黑名单含 "baduser/*"})` → `allowed: false`；`repoWhiteList` 非空时未列出的 repo → `allowed: false`

- [ ] **Step 6: 运行测试确认失败**

Run: `npx vitest run test/access.test.ts`
Expected: FAIL

- [ ] **Step 7: 实现 `worker/src/utils/access.ts`**

`normalizeIPv6`：IPv4 与 IPv4-mapped 直接返回；纯 IPv6 保留前 64 位（前 4 组）其余补 0（用 `ipaddr.js` 亦可，但优先手写避免新依赖——若手写解析复杂，允许加 `ipaddr.js` 为唯一 dependencies）。`matchesList` 支持精确值与 CIDR（IPv4/IPv6）。`checkIP`：黑名单命中即 deny；否则 allow（白名单在无自建限流的前提下不拦请求，spec §4.4）。`wildcardMatch`：把 `*` 转成正则 `.*` 匹配整体。`checkRepoAccess`：黑名单命中 deny；白名单非空且未命中 deny。

- [ ] **Step 8: 运行测试确认通过**

Run: `npx vitest run test/access.test.ts`
Expected: PASS

- [ ] **Step 9: 提交**

```bash
git add worker/src/config.ts worker/src/utils/access.ts worker/test/config.test.ts worker/test/access.test.ts
git commit -m "feat(worker): config parsing and access control lists"
```

---

### Task 3: 响应/请求头工具

**Files:**
- Create: `worker/src/utils/headers.ts`
- Test: `worker/test/headers.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `copyIncomingHeaders(request: Request, headers: Headers): void`（跳过 `Host`）、`passthroughHeaders(source: Headers): Headers`（深拷贝）、`isBlockedHtml(contentType: string | null): boolean`、`rewriteAuthRealm(authValue: string, baseUrl: string): string`、`cleanSecurityHeaders(headers: Headers): void`、`makePassthroughResponse(upstream: Response, streamBody: ReadableStream | null): Response`（用 `{ encodeBody: 'manual' }` 构造原样透传响应）

- [ ] **Step 1: 先写测试（`headers.test.ts`）**

断言：
- `copyIncomingHeaders` 拷贝普通头、不拷贝 `Host`
- `isBlockedHtml("text/html; charset=utf-8")` true；`isBlockedHtml("application/octet-stream")` false
- `rewriteAuthRealm('Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/nginx:pull"', "https://hub.example.com")` → `Bearer realm="https://hub.example.com/token",service="registry.docker.io",scope="repository:library/nginx:pull"`
- `cleanSecurityHeaders` 删除 `Content-Security-Policy`/`Referrer-Policy`/`Strict-Transport-Security`，保留其他
- `makePassthroughResponse` 返回的 Response 状态码、头部与上游一致，且 `encodeBody: 'manual'`（断言构造时不抛错、`Content-Length` 不被运行时改写——这里只断言 headers 一致）

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/headers.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 `worker/src/utils/headers.ts`**（按 Interfaces 签名；`rewriteAuthRealm` 用正则替换 `realm="..."` 为 `baseUrl + "/token"`，保留其余字段）

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/headers.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add worker/src/utils/headers.ts worker/test/headers.test.ts
git commit -m "feat(worker): header passthrough and auth realm rewriting"
```

---

### Task 4: Token 换发 + KV 缓存

**Files:**
- Create: `worker/src/utils/cache.ts`
- Create: `worker/src/docker/token.ts`
- Test: `worker/test/cache.test.ts`
- Test: `worker/test/token.test.ts`

**Interfaces:**
- Consumes: `Env`（Task 1）、`AppConfig`/`loadConfig`（Task 2）、`copyIncomingHeaders`（Task 3）
- Produces: `cache.ts` → `tokenCacheKey(service, scope): string`、`getCachedToken(env, service, scope): Promise<string | null>`、`setCachedToken(env, service, scope, token, ttl): Promise<void>`、`manifestCacheKey(repo, digest): string`、`getCachedManifest(env, repo, digest): Promise<string | null>`、`setCachedManifest(env, repo, digest, body, ttl): Promise<void>`；`token.ts` → `findAuthHost(service: string, cfg: AppConfig): string`、`handleTokenRequest(request, env, fetchFn): Promise<Response>`

- [ ] **Step 1: 先写 `cache.ts` 的测试（`cache.test.ts`）**

用内存假 KV（对象实现 `get(key, opts)`/`put(key, value, opts)`）充当 `env.TOKENS`/`env.MANIFESTS`。断言：
- `setCachedToken` + `getCachedToken` 往返正确，key 含 service 与 scope
- `setCachedManifest("ghcr.io/owner/app", "sha256:abc", "{}", 60)` 后 `getCachedManifest` 返回 `{}`
- 不同 scope / 不同 digest 的 key 不串

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/cache.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 `worker/src/utils/cache.ts`**

`tokenCacheKey` = `\`token:${service}:${scope}\``；`manifestCacheKey` = `\`manifest:${repo}:${digest}\``。`getCachedToken`/`getCachedManifest` 读 `env.TOKENS`/`env.MANIFESTS`，`set*` 用 `expirationTtl: ttl`。注意 `KVNamespace.get` 默认返回 `string | null`，与接口兼容即可。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/cache.test.ts`
Expected: PASS

- [ ] **Step 5: 先写 `token.ts` 的测试（`token.test.ts`）**

`handleTokenRequest` 用注入的 mock `fetchFn`。断言（Review Focus 1 在这里）：
- 请求 `GET /token?service=registry.docker.io&scope=repository:library/nginx:pull`，断言 mock 收到的上游 URL 是 `https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/nginx:pull`（**query 原样**）
- 请求带 `Authorization: Basic xxx` 时，该头透传给上游
- 上游返回 200 `{"token":"t1"}` → 返回体原样，且 `getCachedToken(env, service, scope)` 返回 `t1`
- `service=ghcr.io` → 上游为 `https://ghcr.io/token`
- 未知 service → 回退默认 `https://auth.docker.io/token`
- 上游 401 → 原样返回 401，不缓存

- [ ] **Step 6: 运行测试确认失败**

Run: `npx vitest run test/token.test.ts`
Expected: FAIL

- [ ] **Step 7: 实现 `worker/src/docker/token.ts`**

`findAuthHost(service, cfg)`：已知 service→authHost 表（`registry.docker.io`/`registry-1.docker.io`→`https://auth.docker.io/token`；其余取 `cfg.upstreamRegistries[service]?.authHost`），找不到回退 docker。`handleTokenRequest`：`new URL(request.url)` 取 `search`；构造上游 `\`${authHost}?${search}\``；用 `copyIncomingHeaders` 拷请求头（含 Authorization）到新请求；`fetchFn` 转发；200 时 `await res.clone().text()` 解析 JSON 提取 `token` 字段，`setCachedToken(env, service, scope, token, cfg.tokenCacheTTL)`，再返回原响应；非 200 直接返回。

- [ ] **Step 8: 运行测试确认通过**

Run: `npx vitest run test/token.test.ts`
Expected: PASS

- [ ] **Step 9: 提交**

```bash
git add worker/src/utils/cache.ts worker/src/docker/token.ts worker/test/cache.test.ts worker/test/token.test.ts
git commit -m "feat(worker): docker token exchange with KV caching"
```

---

### Task 5: Docker Registry 代理（/v2）

**Files:**
- Create: `worker/src/docker/registry.ts`
- Test: `worker/test/registry.test.ts`

**Interfaces:**
- Consumes: `Env`/`FetchLike`（Task 1）、`loadConfig`（Task 2）、`rewriteAuthRealm`/`passthroughHeaders`/`cleanSecurityHeaders`/`makePassthroughResponse`（Task 3）、`manifestCacheKey`/`getCachedManifest`/`setCachedManifest`（Task 4）
- Produces: `detectRegistry(repoPath: string, cfg: AppConfig): { domain: string; repo: string }`、`handleRegistryRequest(request, env, fetchFn): Promise<Response>`

- [ ] **Step 1: 先写测试（`registry.test.ts`）**

mock `fetchFn` 按 URL 路由返回假上游。断言：
- `GET /v2/` → 200，头含 `Docker-Distribution-Api-Version: registry/2.0`
- `GET /v2/library/nginx/manifests/latest`（带 `Accept: application/vnd.docker.distribution.manifest.v2+json`）→ mock 收到 `https://registry-1.docker.io/v2/library/nginx/manifests/latest` 且 Accept 透传
- 上游 401 带 `WWW-Authenticate: Bearer realm="https://auth.docker.io/token",service="registry.docker.io"` → 响应头 realm 被改写为 `https://hub.example.com/token`（用请求 Host 作 baseUrl）
- 上游 200 且带 `Docker-Content-Digest: sha256:abc` → 响应体被缓存（`getCachedManifest(env, "library/nginx", "sha256:abc")` 返回体），二次请求命中缓存直接返回、不再调 mock
- **Review Focus 2**：`HEAD /v2/library/nginx/blobs/sha256:abc` → mock 返回 200 + `Content-Length: 5`，客户端响应 200、`Content-Length: 5`、body 为空
- `GET /v2/library/nginx/blobs/sha256:abc` → mock 先 302 到 CDN、CDN 200 → 客户端看到 200（**不是 307**）且 body 与 CDN 一致、关键头透传
- `GET /v2/ghcr.io/owner/app/manifests/latest` → mock 收到 `https://ghcr.io/v2/owner/app/manifests/latest`
- `GET /v2/foo/bar/uploads/` → 404
- `POST /v2/foo/bar/manifests/latest` → 405

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/registry.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 `worker/src/docker/registry.ts`**

`detectRegistry`：`repoPath` 首段若命中 `cfg.upstreamRegistries` 的域名（如 `ghcr.io`）→ 该域名为上游、`repo` 去掉首段；否则默认 `registry-1.docker.io`、`repo` 原样。`handleRegistryRequest`：解析 path；`/v2/` → 本地 200 + `Docker-Distribution-Api-Version: registry/2.0`；`/v2/<name>/blobs/<digest>`、`/v2/<name>/manifests/<ref>`、`/v2/<name>/tags/list` 走上游；其他 404。方法非 GET/HEAD → 405。构造上游 `\`https://${mapping.upstream}/v2/${repo}/${kind}/${ref}${search}\``，`copyIncomingHeaders` 拷请求头，`fetchFn(upstreamReq, { redirect: "follow" })`（blob 必须服务端跟随 CDN 重定向，**绝不下发 307**）。manifests：200 且带 `Docker-Content-Digest` 时 `await res.clone().text()`（manifest 小，允许缓冲）→ `setCachedManifest`；下次 `getCachedManifest` 命中则直接返回（`Content-Type: application/vnd.docker.distribution.manifest.v2+json`）。所有 401 响应 realm 重写为 `https://${requestHost}/token`。blob/manifest/tags 响应用 `makePassthroughResponse`（流式 body、`encodeBody: 'manual'`）+ `cleanSecurityHeaders`。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/registry.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add worker/src/docker/registry.ts worker/test/registry.test.ts
git commit -m "feat(worker): docker registry v2 proxy with blob streaming and manifest cache"
```

---

### Task 6: GitHub / HF 代理

**Files:**
- Create: `worker/src/github/proxy.ts`
- Test: `worker/test/github.test.ts`

**Interfaces:**
- Consumes: `Env`/`FetchLike`（Task 1）、`loadConfig`（Task 2）、`checkIP`/`checkRepoAccess`（Task 2）、`copyIncomingHeaders`/`passthroughHeaders`/`isBlockedHtml`/`cleanSecurityHeaders`/`makePassthroughResponse`（Task 3）
- Produces: `checkGitHubURL(u: string): RegExpMatchArray | null`、`rewriteScriptBody(body: string, host: string): string`、`handleGitHubProxy(request, env, fetchFn): Promise<Response>`

- [ ] **Step 1: 先写测试（`github.test.ts`）**

`checkGitHubURL` 断言（对齐 spec §4.2 与上游 `githubExps`）：
- `https://github.com/owner/repo/releases/download/v1/app.tar.gz` 匹配（组为 owner/repo）
- `https://github.com/owner/repo/raw/main/x.sh`、`https://github.com/owner/repo/archive/refs/heads/main.zip`、`https://github.com/owner/repo/info/refs?service=git-upload-pack`、`https://github.com/owner/repo.git/info/refs?service=git-upload-pack`（`.git` 后缀）匹配
- `https://raw.githubusercontent.com/owner/repo/main/file`、`https://gist.github.com/user/gistid`、`https://api.github.com/repos/owner/repo/releases`、`https://huggingface.co/org/model/resolve/main/x.bin`、`https://cdn-lfs.hf.co/org/model/x` 匹配
- `https://example.com/file.zip` 不匹配

`rewriteScriptBody` 断言：输入含 `https://github.com/foo/bar/raw/main/a.sh` 与 `https://raw.githubusercontent.com/x/y/main/z`，`host = "hub.example.com"` 时输出把这两处分别替换为 `https://hub.example.com/https://github.com/foo/bar/raw/main/a.sh` 与 `https://hub.example.com/https://raw.githubusercontent.com/x/y/main/z`，其余文本不变。

`handleGitHubProxy` 断言（mock `fetchFn`）：
- **Review Focus 4**：`/https:/github.com/owner/repo/releases/download/v1/a.tar.gz`（畸形 scheme）与 `//github.com/owner/repo/raw/main/x`（双斜杠）都能正确补全并转发
- **Review Focus 1**：`/https://github.com/owner/repo/info/refs?service=git-upload-pack` → mock 收到含 `?service=git-upload-pack` 的完整 URL
- release 下载（GET）→ 上游响应体流式透传、关键头（`Content-Length`/`Content-Type`）一致
- `blob` 路径 → 转发的是 `raw`（mock 收到 `/raw/`）
- **Review Focus 5**：`.sh` 上游带 `Content-Encoding: gzip` → 客户端响应解压后含改写后的 URL，且无 `Content-Encoding`、无 `Content-Length`
- 非 gzip 的 `.sh` → 客户端响应含改写后的 URL
- 上游 `Content-Type: text/html` 且 GET → 403
- 上游返回 `Location: https://github.com/other/repo/raw/main/x` 的 302 → 客户端收到 302，`Location` 为 `/https://github.com/other/repo/raw/main/x`
- `/https://example.com/file.zip` → 403（不支持的主机）
- **api.github.com**：请求带 `Authorization: Bearer t` → mock 收到相同 `Authorization`；**非 api.github.com 路径**带 `Authorization` → mock 不收到该头
- clone 透传（`.git/info/refs`）：mock 返回二进制 body 与 `Content-Encoding: gzip` 等头 → 客户端 body 字节一致、头一致（**不做改写/再压缩**）
- `Content-Length` 超 `MAX_FILE_SIZE` → 413

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/github.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 `worker/src/github/proxy.ts`**

`checkGitHubURL`：按 spec 列出的正则逐一匹配（从上游 Go `githubExps` 翻译）。`rewriteScriptBody`：对 `https://github.com/`、`https://raw.githubusercontent.com/`、`https://gist.github.com/` 等已知前缀，替换为 `https://${host}/` + 原 URL。`handleGitHubProxy` 流程（对齐上游 `github.go`）：
1. `rawPath = new URL(request.url).pathname + new URL(request.url).search`，剥掉开头所有 `/`
2. 自动补 `https://`：处理 `http:/`/`https:/` 畸形前缀与双斜杠
3. `checkGitHubURL(rawPath)` 不匹配 → 403；匹配则 `checkRepoAccess(owner/name)`（owner/name 取匹配组，去掉 `.git` 后缀）不过 → 403
4. `blob` → `raw` 改写
5. `api.github.com` 路径：透传 `Authorization` 头；其他路径：删除 `Authorization`
6. `fetchFn(upstreamUrl, { method, headers, body, redirect: "follow" })`
7. GET 且 `isBlockedHtml(contentType)` → 403
8. `Content-Length` > `cfg.maxFileSize` → 413
9. `.sh`/`.ps1` 结尾：若 `Content-Encoding: gzip` 用 `DecompressionStream("gzip")` 解压（整段缓冲，脚本小）；`body = rewriteScriptBody(text, host)`；响应去掉 `Content-Encoding`/`Content-Length`，`Content-Type: text/plain`（`text/x-shellscript` 亦可）；`Location` 若是 GitHub 链接 → 改写为 `/${location}` 302，否则 `fetchFn` 跟随
10. clone 路径（`info/refs`、`git-*`）与其他二进制：`makePassthroughResponse` 原样流式透传，`encodeBody: 'manual'`，绝不改写 body

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/github.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add worker/src/github/proxy.ts worker/test/github.test.ts
git commit -m "feat(worker): github/hf proxy with script rewriting and token passthrough"
```

---

### Task 7: 路由装配 + 集成测试

**Files:**
- Modify: `worker/src/index.ts`（替换 Task 1 桩）
- Test: `worker/test/index.test.ts`

**Interfaces:**
- Consumes: `handleTokenRequest`（Task 4）、`handleRegistryRequest`（Task 5）、`handleGitHubProxy`（Task 6）、`loadConfig`（Task 2）
- Produces: `buildHandler(fetchFn): (request, env) => Promise<Response>`（完整实现）；`default { fetch }`

- [ ] **Step 1: 先写集成测试（`index.test.ts`）**

用内存假 KV + 按 URL 路由的 mock `fetchFn`（`registry-1.docker.io`/`auth.docker.io`/`raw.githubusercontent.com` 各返回合适假响应）构造 `env` 后调用 `buildHandler(mockFetch)`。断言：
- `GET /ready` → 200，JSON 含 `ready: true`、`service: "hubproxy-worker"`
- `GET /v2/` → 200 + `Docker-Distribution-Api-Version`
- `GET /token?service=registry.docker.io&scope=repository:library/nginx:pull` → 200 token JSON
- `GET /https://github.com/owner/repo/releases/download/v1/x` → 200 转发
- `GET /https://example.com/x` → 403
- `GET /foo/bar`（无法识别路径）→ 走 GitHub catch-all → 403（非 GitHub 主机）

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/index.test.ts`
Expected: FAIL（index.ts 还是 404 桩）

- [ ] **Step 3: 实现 `worker/src/index.ts` 完整路由**

`new URL(request.url).pathname`：`/ready` → 200 JSON（中文注释：健康检查，验收清单 step 0 用）；`/v2`、`/v2/*` → `handleRegistryRequest`；`/token`、`/token/*` → `handleTokenRequest`；其余 → `handleGitHubProxy`。`buildHandler(fetchFn)` 内先 `loadConfig(env)` 并把 `cfg` 传给各 handler（`handleRegistryRequest`/`handleTokenRequest` 需要 `cfg`——若 Task 4/5 的签名只有 `(request, env, fetchFn)`，则在本任务给这三个 handler 补一个 `cfg` 参数并在内部 `loadConfig`；补参时同步更新 Task 4/5 实现与测试）。

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test`（全量）
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add worker/src/index.ts worker/test/index.test.ts worker/src/docker worker/test
git commit -m "feat(worker): route assembly with integration tests"
```

---

### Task 8: 部署配置 + README

**Files:**
- Modify: `worker/wrangler.toml`（填默认 vars、KV 占位说明）
- Create: `worker/README.md`
- Create: `worker/.dev.vars.example`

**Interfaces:**
- Consumes: 已完成所有源码任务
- Produces: 可部署配置与使用文档（含 spec §7 验收清单）

- [ ] **Step 1: 完善 `worker/wrangler.toml`**

`vars` 填默认值注释与示例（`MAX_FILE_SIZE="2147483648"`、`TOKEN_CACHE_TTL="1200"`、`MANIFEST_CACHE_TTL="3600"`、`IP_BLACKLIST=""` 等）；`kv_namespaces` 的 `TOKENS`/`MANIFESTS` 保留占位 + 注释"部署前运行 `wrangler kv namespace create TOKENS` / `wrangler kv namespace create MANIFESTS` 并把返回的 id 填入"；custom domain 注释（`custom_domains = [{ name = "hub.<你的域名>.com", zone_name = "<你的域名>.com" }]`，或说明用 dashboard 绑定 Workers Routes）。可选加 `limits` 注释说明默认 30s CPU 足够。

- [ ] **Step 2: 创建 `worker/.dev.vars.example`**（示例 vars，供本地 `wrangler dev`）

- [ ] **Step 3: 创建 `worker/README.md`**，必须包含（中文）：
  1. 本地开发：`npm install`、`npm run dev`、`npm test`、`npm run typecheck`
  2. 部署步骤：创建 KV namespace → 填 id → `npm run deploy` → 绑定自定义域名
  3. Docker 两种用法：`/etc/docker/daemon.json` 配 `"registry-mirrors": ["https://hub.<域名>.com"]`；或 `docker pull hub.<域名>.com/nginx`、`docker pull hub.<域名>.com/ghcr.io/<owner>/<repo>`
  4. Git：`git config --global url.insteadOf https://github.com/ https://hub.<域名>.com/https://github.com/`
  5. api.github.com：`curl -H "Authorization: Bearer <token>" "https://hub.<域名>.com/https://api.github.com/repos/octocat/Hello-World"`
  6. **部署前前置检查**：先从本机网络 `curl -I https://hub.<域名>.com/ready`，确认可达且延迟可接受（免费 CF 无中国大陆网络，不通则先解决网络路径，spec §7）
  7. **验收清单**（原样取自 spec §7）：/v2/ 头、docker pull 两种模式、ghcr 拉取、大仓库 + submodule 的 clone、release + .sh 改写、api.github.com 带 Token

- [ ] **Step 4: 验证并提交**

Run: `npm run typecheck`；`npx wrangler deploy --dry-run`（如本机已登录 CF；未登录则以 typecheck 通过为准）
Expected: typecheck 无错误；dry-run 无配置错误

```bash
git add worker/wrangler.toml worker/README.md worker/.dev.vars.example
git commit -m "docs(worker): deployment config and usage README"
```

---

## 自检记录（对 spec）

- §2 目标全部有任务：Docker 两种用法（Task 5）、api.github.com Token 透传（Task 6）、任意公开仓库 clone 字节精确（Task 6）、.sh/.ps1 改写（Task 6）、HF（Task 6）、缓存（Task 4/5）、免费计划（Task 8）
- §4.1 token 流程/realm 重写/服务端跟随 CDN/Manifest 缓存 → Task 4/5
- §4.4 黑白名单 → Task 2；速率限制按 spec 用 CF zone 规则（非代码），在 README 提及
- §6 本地无网测试 → 全程注入 `FetchLike` + 内存假 KV
- §7 部署前置检查 + 验收清单 → Task 8 README
- 非目标（tar/push/SOCKS/Web UI/搜索）无任务，符合
