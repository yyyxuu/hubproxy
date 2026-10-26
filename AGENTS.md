# AGENTS.md

HubProxy is a single-binary Go reverse proxy that accelerates Docker (Registry API v2), GitHub, and Hugging Face, with an embedded Vue 3 SPA. All comments, log output, and user-facing messages in this codebase are written in **Chinese** — keep it that way when editing.

## Layout

- `src/` — the entire Go backend (module `hubproxy`, Go 1.26): packages `config/`, `handlers/`, `utils/`.
- `web/` — Vue 3 + Vite + Tailwind 4 SPA; builds into `src/dist/` (gitignored, not committed).
- `docs/` — Astro Starlight docs site (Chinese default + `en/` mirror).
- `packaging/` — nFPM configs + systemd/openrc/logrotate scripts for `deb`/`rpm`/`apk`.
- `.github/workflows/` — `release.yml` + `docker-ghcr.yml` (manual), `docs.yml` (auto).

## Build order matters

`src/main.go` embeds the frontend via `//go:embed all:dist`. `go build`, `go run`, and `go test` all fail until `src/dist/` exists. Build it first:

```
cd web && npm ci && npm run build   # vue-tsc -b typecheck, then vite build -> ../src/dist
```

`npm run build` also fails on TS type errors because of `vue-tsc -b`. After a clean clone there is no `src/dist`, so any backend work (including running the test suite) requires this step first.

## Commands

- Backend: `cd src && go run .` — reads `./config.toml` (or `CONFIG_PATH`), listens on `:5000`
- Tests: `cd src && go test ./...` — hermetic, httptest only, no network; also needs `src/dist`
- Frontend dev: `cd web && npm run dev` — Vite proxies `/api` to `http://127.0.0.1:5000`, so start the Go backend first
- Docs dev: `cd docs && npm run dev`

## Routing (src/main.go)

All routes are registered in `buildRouter`, and `NoRoute` is the GitHub/Hugging Face proxy catch-all:

- `/ready` health check; `/api/image/*` offline-tar endpoints; SPA routes (`/`, `/images`, `/search`, `/assets/*`)
- `/token`, `/v2/*path` → Docker Registry API v2 proxy (`handlers.ProxyDockerRegistryGin`)
- everything else → `handlers.GitHubProxyHandler` (GitHub releases/raw/git, HF models)

Register new top-level routes **before** the `NoRoute` catch-all. Docker upstreams come from the `[registries]` block in `config.toml` (ghcr.io, gcr.io, quay.io, registry.k8s.io); `registry-1.docker.io` is the unmapped default upstream.

## Config

`src/config.toml` is the shipped default; `CONFIG_PATH` overrides its location. Env vars override individual settings: `SERVER_HOST`, `SERVER_PORT`, `ENABLE_H2C`, `ENABLE_FRONTEND`, `MAX_FILE_SIZE`, `RATE_LIMIT`, `RATE_PERIOD_HOURS`, `IP_WHITELIST`, `IP_BLACKLIST`, `ACCESS_PROXY`, `MAX_IMAGES`. `config.GetConfig()` returns a cached shallow copy (5s TTL), so runtime reloads are not immediate.

Every proxied path is gated by `utils.GlobalAccessController` (IP + repo/image allow/deny lists, wildcards supported) — reuse it for new endpoints.

## Release

Toolchains are pinned: Go 1.26 (`src/go.mod`), Node >=24 / npm 11 (`web/package.json`). `release.yml` and `docker-ghcr.yml` are manual `workflow_dispatch` workflows that take a version like `v1.0.0`; the version is injected at build time via `-ldflags "-X main.Version=..."` (`Version` defaults to `"dev"` in `src/main.go`). `docs.yml` auto-deploys to GitHub Pages on `main` when `docs/src/**` changes.
