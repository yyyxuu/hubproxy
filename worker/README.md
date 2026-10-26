# HubProxy Worker

HubProxy 的 Cloudflare Workers 实现：单个 Worker + 单个子域名（如 `hub.<你的域名>.com`），提供 **Docker 镜像拉取加速**、**GitHub 加速**（release / raw / archive / api / git clone）与 **Hugging Face 加速**，全站 HTTPS，免费计划即可运行（个人流量规模）。

非目标：docker push、离线 tar 打包、镜像搜索 / 标签浏览、Web 界面、SOCKS5 上游代理。

## 功能一览

- **Docker Registry V2 代理**：`/v2/*` 与 `/token*`；默认 Docker Hub，另支持 ghcr.io / gcr.io / quay.io / registry.k8s.io（路径前缀）；401 的 `WWW-Authenticate` realm 重写为本 Worker 的 `/token` 地址；blob 由服务端跟随 CDN 重定向后流式回传；Token / Manifest 缓存到 KV
- **GitHub / HF 代理**：路径即目标 URL（自动补 `https://`），支持 releases、archive、blob→raw 改写、raw.githubusercontent.com、gist、githubassets.com、api.github.com（透传你自己的 GitHub Token）、huggingface.co、cdn-lfs.hf.co
- **git clone**：smart HTTP，packfile 字节精确透传（不改写、不缓冲、不再压缩），支持任意公开仓库、大仓库、submodule、`.git` 后缀 remotes
- **`.sh` / `.ps1` 脚本改写**：脚本内的 GitHub URL 自动改写为代理域名后返回
- **访问控制**：IP 黑白名单（CIDR，IPv6 归一 /64，基于 `CF-Connecting-IP`）、仓库/镜像黑白名单（通配符）
- **健康检查**：`GET /ready`

## 路由分发

| 路径 | 处理 |
|---|---|
| `/ready` | 健康检查，返回 200 JSON |
| `/v2`、`/v2/*` | Docker Registry 代理 |
| `/token`、`/token/*` | Docker token 换发（带 KV 缓存） |
| 其余 | GitHub / HF 代理 catch-all（路径即目标 URL） |

## 配置项

全部通过 wrangler 环境变量配置（`wrangler.toml` 的 `[vars]`，本地开发用 `.dev.vars`），不依赖 config.toml。未设置的变量回退到代码内默认逻辑。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `UPSTREAM_REGISTRIES` | 内置 5 个注册表 | 注册表映射 JSON（domain → upstream/authHost/authType/enabled），合法 JSON 与内置默认合并，非法回退 |
| `MAX_FILE_SIZE` | `2147483648`（2GB） | GitHub/HF 路径单文件大小上限（字节），超限返回 413 |
| `IP_WHITELIST` | 空 | 逗号分隔，支持 CIDR，IPv6 归一 /64 |
| `IP_BLACKLIST` | 空 | 同上，命中即 403 |
| `REPO_WHITELIST` | 空 | 逗号分隔，支持通配符（如 `baduser/*`） |
| `REPO_BLACKLIST` | 空 | 同上 |
| `TOKEN_CACHE_TTL` | `1200` | Docker Token 缓存 TTL（秒） |
| `MANIFEST_CACHE_TTL` | `3600` | Manifest 缓存 TTL（秒） |

KV 绑定：`TOKENS`（token 缓存）、`MANIFESTS`（manifest 缓存，仅 immutable digest）。

> **限速说明**：代码内不自建速率限制。如需限流，在 Cloudflare Dashboard → 安全性 → WAF → 速率限制规则 中按客户端 IP 配置 zone 级规则即可。

## 本地开发

```bash
cd worker
npm install
npm run dev          # wrangler dev，默认 http://localhost:8787
npm test             # vitest（fetch 与 KV 均为 mock，不依赖真实网络）
npm run typecheck    # tsc --noEmit
```

本地环境变量：`cp .dev.vars.example .dev.vars` 后按需修改（`.dev.vars` 已被 git 忽略，不会提交）。

## 部署

前置要求：Cloudflare 账号 + 一个托管在 Cloudflare 的域名（免费计划即可）。

```bash
cd worker
npm install

# 1. 创建两个 KV namespace，把命令输出中的真实 id 替换 wrangler.toml 里的全 0 占位符
npx wrangler kv namespace create TOKENS
npx wrangler kv namespace create MANIFESTS

# 2. 编辑 wrangler.toml：
#    - 填入上面返回的两个 KV id
#    - 按需修改 [vars]（黑白名单等）

# 3. 绑定自定义域名（二选一）：
#    a. 取消 wrangler.toml 中 routes 的注释，替换为你的子域名
#    b. 或部署后在 Dashboard → Workers & Pages → hubproxy-worker
#       → Settings → Domains & Routes 手动绑定

# 4. 部署（首次需先 npx wrangler login）
npm run deploy
```

部署成功后 wrangler 会输出 `*.workers.dev` 预览地址，可用于初步验证；正式使用请走绑定的自定义域名。

## 部署前置检查（step 0，必做）

**在配置 Docker / Git 之前**，先从本机网络验证 Worker 可达且延迟可接受：

```bash
curl -I https://hub.<你的域名>.com/ready
```

- 返回 `HTTP/2 200` 且延迟正常 → 继续下面的用法配置
- 不通或延迟过高 → **先解决网络路径，否则整个方案不成立**：Cloudflare 免费计划没有中国大陆节点（流量走 HK/JP 等边缘），部分 ISP / 网络环境可能无法直连

## Docker 用法（两种方式，任选或并用）

### 方式一：registry-mirrors（只对 Docker Hub 生效，pull 时不用改名）

编辑 `/etc/docker/daemon.json`（Windows / macOS 在 Docker Desktop 设置中的 Docker Engine 配置里修改）：

```json
{
  "registry-mirrors": ["https://hub.<你的域名>.com"]
}
```

重启 Docker 服务（Linux：`sudo systemctl restart docker`）后直接拉取：

```bash
docker pull nginx
```

### 方式二：标签改写（支持全部内置注册表）

把镜像名前面加上代理域名即可，路径前缀决定上游注册表：

```bash
docker pull hub.<你的域名>.com/nginx                      # Docker Hub
docker pull hub.<你的域名>.com/ghcr.io/<owner>/<repo>     # ghcr.io
docker pull hub.<你的域名>.com/gcr.io/<project>/<image>   # gcr.io
docker pull hub.<你的域名>.com/quay.io/<owner>/<repo>     # quay.io
docker pull hub.<你的域名>.com/registry.k8s.io/<image>    # registry.k8s.io
```

## Git clone

把 GitHub 地址透明改写到代理（submodule 同样会走代理）：

```bash
git config --global url."https://hub.<你的域名>.com/https://github.com/".insteadOf "https://github.com/"
```

之后正常 clone 即可：

```bash
git clone https://github.com/<owner>/<repo>.git
```

撤销改写：

```bash
git config --global --unset url."https://hub.<你的域名>.com/https://github.com/".insteadOf
```

## api.github.com（透传你自己的 GitHub Token）

```bash
curl -H "Authorization: Bearer <你的GitHubToken>" "https://hub.<你的域名>.com/https://api.github.com/repos/octocat/Hello-World"
```

- 仅 `api.github.com/repos/*` 路径会把请求中的 `Authorization` 头原样转发给上游；release / raw 等路径不需要也不转发
- 不携带 `Authorization` 时按匿名请求尽力而为
- Worker 是公网端点，Token 只在你主动携带时才被转发；建议配合上面的 zone 级限流与黑白名单使用

## 部署后验收清单

部署并绑定域名、通过前置检查后，逐项手动验证：

1. `curl https://hub.<你的域名>.com/v2/` 返回 200 + `Docker-Distribution-Api-Version` 头
2. `docker pull hub.<你的域名>.com/nginx`（标签改写模式）成功
3. 配置 `registry-mirrors` 后 `docker pull nginx`（不改名）成功
4. `docker pull hub.<你的域名>.com/ghcr.io/<owner>/<repo>`（非 Hub 注册表）成功
5. 配置 `url.insteadOf` 后 `git clone https://github.com/<owner>/<repo>` 成功（大仓库 + 一个带 submodule 的仓库）
6. 下载一个 release 文件 + 一个 `.sh` 脚本，确认脚本内 URL 已改写
7. `curl -H "Authorization: Bearer <token>" "https://hub.<你的域名>.com/https://api.github.com/repos/octocat/Hello-World"` 返回 200

## 项目结构

```
worker/
  src/
    index.ts            # fetch handler + 路由分发
    config.ts           # 解析 env（wrangler vars）+ 访问列表
    types.ts            # Env 类型
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
  wrangler.toml         # 部署配置
  .dev.vars.example     # 本地开发环境变量示例
```
