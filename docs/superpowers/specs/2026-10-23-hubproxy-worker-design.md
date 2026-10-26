# HubProxy → Cloudflare Worker 改造设计

日期：2026-10-23

## 1. 意图与背景

HubProxy 目前是 Go 单二进制自托管代理（Docker / GitHub / Hugging Face 加速），部署在自建 VPS 上。用户希望将其功能迁移到 Cloudflare Workers，原因是：① 自建 VPS 成本高；② 国内网络环境需要加速。**核心诉求只有两个：GitHub 加速、Docker 镜像拉取加速**，其余功能非必须。使用规模：**个人使用**。

结论：重写为 TypeScript Worker（Go 代码不可复用），部署在用户已有的 Cloudflare 账号与自定义域名上。

## 2. 目标 / 非目标 / 反目标

### 目标
- `docker pull` 公共镜像加速：Docker Hub 为主，GHCR / gcr.io / quay.io / registry.k8s.io 可选。**两种用法都支持**：① Docker daemon 配置 `registry-mirrors`（只对 Docker Hub 生效）；② 直接改写镜像名 `hub.domain.com/ghcr.io/owner/repo`（支持多注册表）
- GitHub 加速：release 下载、raw、archive tarball、**api.github.com（透传客户端自己的 GitHub Token）**、`git clone`（smart HTTP）
- `git clone` 验收标准：**任意公开仓库**，包括大仓库、submodule、`.git` 后缀 remotes；packfile 流必须字节精确、不可被改写/重复压缩
- `.sh` / `.ps1` 脚本内 GitHub URL 自动改写为代理域名
- Hugging Face 文件 / LFS 加速（成本低，顺手保留）
- Token / Manifest 缓存，降低上游注册表压力
- 免费计划内可运行；个人流量规模

### 非目标
- docker push（上传）
- 离线 tar 打包（gzip 压缩超 Worker CPU 限额）
- 镜像搜索 / 标签浏览 API
- Web 界面（Vue SPA）
- SOCKS5 上游代理
- 开放给公众 / 多租户（个人用，防滥用从简）

### 反目标
- 任何把大响应整体缓冲进内存的做法（128MB 内存限制）
- 运行时依赖 `config.toml` 之类的文件配置（用 wrangler 环境变量）
- 自建复杂的限流 / 状态基础设施

## 3. 平台约束（已核实，2026-10）

| 项 | 值 | 影响 |
|---|---|---|
| 运行时 | JS/TS（不可用 Go） | 全部重写 |
| CPU 时间 | 免费 10ms/请求；付费默认 30s（上限 5min） | 纯转发/流式 OK；压缩类（离线 tar）不可行 |
| 内存 | 128MB | 必须流式，禁止缓冲大响应 |
| 请求体 | 免费/Pro 100MB、Business 200MB | 不影响拉取场景（请求体都很小） |
| 响应体 | 无上限（流式） | 多 GB blob / packfile 可流式回传 |
| 子请求 | 免费 50/请求；付费默认 10k | 拉取流程子请求少，无压力 |
| 并发连接 | 6 个同时等待响应头 | 拉取各步骤串行，无压力 |
| 真实客户端 IP | `CF-Connecting-IP`（IPv6 需自行掩 /64） | 限流/黑白名单用它 |
| 出站 | `fetch()` 任意公网 host；TCP socket API 可用但非必要 | Docker CDN 重定向需服务端跟随 |

## 4. 总体架构

**单个 Worker + 单个子域名**（如 `hub.<用户域名>.com`），自定义主机名挂到 Cloudflare，全站 HTTPS。所有流量进一个 `fetch` handler，按路径分发（与 HubProxy 单端口模型一致）：

1. `/v2/*`、`/token*` → Docker Registry 代理
2. 其余全部 → GitHub / HF 代理 catch-all（路径即目标 URL，如 `hub.domain.com/https://github.com/...`）

### 4.1 Docker Registry 代理

- `/v2/` ping：返回 200 + `Docker-Distribution-Api-Version: registry/2.0`
- 上游解析（与 HubProxy 语义一致）：
  - 默认 Docker Hub（`registry-1.docker.io`）
  - 路径前缀形式支持多注册表：`hub.domain.com/ghcr.io/owner/repo` → ghcr.io
  - 注册表→authHost/authType 映射放环境变量（内置默认 ghcr/gcr/quay/k8s）
- **Token 流程**：
  - 客户端（docker）请求 `/token?service=...&scope=...`（带 basic auth）→ Worker 转发到对应 auth host → 返回 token
  - 401 响应中的 `WWW-Authenticate` realm 重写为本 Worker 的 `/token` 地址（对齐 HubProxy 的 rewriteAuthHeader 逻辑）
- **Manifest**：
  - GET `/v2/<name>/manifests/<ref>` 转发，透传 docker 的 `Accept` 头（支持 manifest list / OCI）
  - 按 digest 缓存到 KV（TTL 可配）
- **Blob**（拉取的核心）：
  - GET/HEAD `/v2/<name>/blobs/<digest>` 转发，`redirect: 'follow'` **服务端跟随** CDN 重定向后流式回传
  - 关键：绝不能把 307 直接透传给客户端（客户端会直连被墙的 CDN）
  - 透传 `Content-Type` / `Content-Length` / `Docker-Content-Digest` / `ETag` 等关键头
- Tags list：转发（低优先级，个人用可选）
- 拉取场景请求体都很小，请求体限额无风险
- **两种接入用法（都要支持、都要测试与文档化）**：
  - `registry-mirrors`：`/etc/docker/daemon.json` 配 `"registry-mirrors": ["https://hub.domain.com"]`，Docker daemon 把 Docker Hub 拉取改写为本 Worker（无前缀，走默认 Docker Hub 上游）
  - 标签改写：`docker pull hub.domain.com/ghcr.io/owner/repo`（路径前缀 → 对应上游注册表）

### 4.2 GitHub / HF 代理

- 解析路径 `/<url>`，自动补 `https://`，正则规则对齐 HubProxy 的 `githubExps`：
  - `github.com/{releases,archive,blob,raw,info,git-*}`、`raw.githubusercontent.com`、`gist.github.com`、`api.github.com/repos/*`、`githubassets.com`
  - `huggingface.co`、`cdn-lfs.hf.co`
- `blob` → `raw` 改写
- **`.sh` / `.ps1`**：脚本体积小，允许缓冲 + 正则把脚本内 GitHub URL 改写为本 Worker 域名后流式返回（对齐 ProcessSmart）
- 其余：直接流式转发；`Location` 若是 GitHub 链接则改写为经 Worker 访问，否则服务端跟随
- 阻止 `text/html` 类内容（避免被当网页代理）
- `MAX_FILE_SIZE` 上限仅对 GitHub 路径生效（防误用；响应体本身无上限）
- **`api.github.com`：透传客户端自己的 GitHub Token**——把请求里的 `Authorization` 头原样转发给上游（仅限 `api.github.com/repos/*` 路径；release/raw 等不需要也不转发）。无 `Authorization` 头时按匿名尽力而为。注意：Worker 是公网端点，Token 只在客户端主动携带时才被转发
- **`git clone`（任意公开仓库，含大仓库 / submodule / `.git` 后缀）**：
  - `/info/refs?service=git-upload-pack`（GET，小）+ `/git-upload-pack`（POST，请求体小，响应流式返回 packfile）
  - **packfile 必须字节精确**：clone 路径的响应体不做任何改写/缓冲/再压缩，响应头原样透传，`Response` 用流式 body
  - 客户端侧通过 `git config --global url.insteadOf https://github.com/ https://hub.domain.com/https://github.com/` 透明改写，submodule 同理会走同一代理

### 4.3 缓存

- KV namespace：`tokens`（`expirationTtl`，默认 20m，可配）+ `manifests`（按 digest，可配 TTL）
- 仅缓存 immutable（带 digest）的 manifest

### 4.4 限流与访问控制（个人用，从简）

- IP 黑白名单：环境变量数组，匹配 `CF-Connecting-IP`（支持 CIDR），IPv6 归一为 /64
- 仓库/镜像黑白名单：环境变量数组，通配符匹配（`*/malicious-repo`、`baduser/*` 等，语义与 HubProxy 一致）
- 速率限制：优先用 Cloudflare **zone 级 Rate Limiting rules** 或 `ratelimit` binding，key = 客户端 IP；不在代码内自建重度限流

### 4.5 配置（wrangler vars，无 config.toml）

- `UPSTREAM_REGISTRIES`：注册表映射 JSON（domain → authHost/authType），内置默认
- `MAX_FILE_SIZE`（默认 2GB，仅 GitHub 路径）
- `IP_WHITELIST` / `IP_BLACKLIST`
- `REPO_WHITELIST` / `REPO_BLACKLIST`
- `TOKEN_CACHE_TTL` / `MANIFEST_CACHE_TTL`
- 限流参数（若用 ratelimit binding 则放 wrangler 配置）

## 5. 代码结构

```
worker/
  src/
    index.ts            # fetch handler + 路由分发
    config.ts           # 解析 env（wrangler vars）+ 访问列表
    types.ts            # Env 类型（可由 wrangler types 生成）
    docker/
      registry.ts       # /v2/* 代理（ping/manifest/blob/tags）
      token.ts          # /token 代理 + realm 重写
    github/
      proxy.ts          # GitHub/HF catch-all + 脚本改写
    utils/
      access.ts         # IP/仓库 黑白名单、通配符、IPv6 /64
      cache.ts          # KV token/manifest 缓存
      headers.ts        # 请求/响应头透传与清洗
  test/                 # vitest + @cloudflare/vitest-pool-workers
  wrangler.toml
  package.json
  tsconfig.json
  vitest.config.ts
```

## 6. 测试

- vitest + `@cloudflare/vitest-pool-workers`；用 `fetch` mock 模拟上游，**本地测试不依赖真实网络**
- 覆盖：路由分发、realm 重写、CDN 重定向服务端跟随、`.sh` 改写、黑白名单通配符、IPv6 /64、manifest 缓存 TTL、clone 响应头原样透传（字节精确性只能靠部署后真实 clone 验证）
- docker pull 与 git clone 的**真实验收放在部署阶段**（见 §7 验收清单）

## 7. 部署

- `npm run deploy` = `wrangler deploy`
- 绑定自定义主机名（用户提供子域名）
- 免费计划即可；如后续流量变大再升付费
- **部署前前置检查（step 0）**：先从用户网络验证 `https://hub.<域名>/ready` 可访问且延迟可接受（免费 CF 无中国大陆网络，走 HK/JP 等，某些 ISP 可能不通）——不通则整个方案不成立，先解决网络路径
- **部署后验收清单（用户手动执行）**：
  1. `curl https://hub.<域名>/v2/` 返回 200 + `Docker-Distribution-Api-Version`
  2. `docker pull hub.<域名>/nginx`（标签改写模式）成功
  3. 配置 `registry-mirrors` 后 `docker pull nginx`（不改名）成功
  4. `docker pull hub.<域名>/ghcr.io/<owner>/<repo>`（非 Hub 注册表）成功
  5. 配置 `url.insteadOf` 后 `git clone https://github.com/<owner>/<repo>` 成功（大仓库 + 一个带 submodule 的仓库）
  6. 下载一个 release 文件 + 一个 `.sh` 脚本，确认脚本内 URL 已改写
  7. `curl -H "Authorization: Bearer <token>" "https://hub.<域名>/https://api.github.com/repos/octocat/Hello-World"` 返回 200

## 8. Builder 决定（我的默认选择，用户可推翻）

- 单 Worker + 单子域名
- Docker Hub 默认 + 4 个上游注册表（路径前缀）
- `git clone` 纳入范围
- 免费计划
- 代码放本仓库 `worker/` 目录（原 Go 实现不动）

## 9. 用户确认的决策（2026-10-23）

- **api.github.com**：保留，透传客户端自己的 GitHub Token（`Authorization` 头仅限 `api.github.com/repos/*` 路径转发）
- **git clone**：验收标准为"任意公开仓库"（含大仓库、submodule）
- **验收方式**：用户部署后手动按 §7 验收清单验证
- **Docker 用法**：`registry-mirrors` 与标签改写两种都要支持
