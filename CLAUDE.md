# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

AIOStreams is a Stremio "super-addon" that aggregates results from many upstream Stremio addons + debrid/usenet services, then deduplicates, filters, sorts, formats and (optionally) proxies the streams before returning them to Stremio. It is a single-process Node service that also serves a React SPA configuration UI.

Requires Node `>=24` and pnpm `>=11` (enforced in root `package.json` engines).

## Commands

All commands run from the repo root. The repo is a pnpm workspace with packages under `packages/*`.

- `pnpm install` — install everything (pnpm workspaces).
- `pnpm build` — build `core` → `server` → `frontend` → `web` in that order (the order matters; later packages depend on `@aiostreams/core`).
- `pnpm dev` — run `core`, `server`, `frontend` and `web` in parallel watch mode.
- `pnpm start:dev` — `tsx watch` of `packages/server/src/server.ts` with `NODE_ENV=development` (use this when you only need the backend to reload).
- `pnpm start` — run the built server (`node packages/server/dist/server`). Requires `pnpm build` first.
- `pnpm start:frontend:dev` — only the rsbuild dev server for the SPA.
- `pnpm test` — run vitest in every workspace (`vitest run --passWithNoTests`).
- Per-package: `pnpm -F core test`, `pnpm -F frontend typecheck`, `pnpm -F frontend lint`, etc.
- Single test file: `pnpm -F <pkg> exec vitest run path/to/file.test.ts` (or add `-t "<name>"` for a single test).
- `pnpm format` — Prettier across all `*.ts`/`*.tsx`.
- `pnpm gen:env-docs` — regenerate env-var documentation from the config schema (run after changing `packages/core/src/config/schema`).
- `pnpm metadata` — regenerate addon metadata (`scripts/generateMetadata.cjs`).
- Docs site: `pnpm docs:dev` / `pnpm docs:build`.

The frontend uses rsbuild (not Vite/webpack directly) — `pnpm -F frontend dev` / `build` / `preview`.

## Architecture

### Workspace layout

- `packages/core` — the engine. Everything addon-related, all I/O, DB, cache, config, presets, builtins, stream pipeline. Other packages depend on it as `@aiostreams/core`.
- `packages/server` — thin Express 5 app that wires `core` to HTTP. Owns routing, middleware, rate limiting, static asset serving, and the server lifecycle.
- `packages/frontend` — React 19 SPA (rsbuild + TanStack Router + TanStack Query + Tailwind + Radix). Built output is served by the server from `packages/frontend/dist` at runtime.
- `packages/ui` — `@aiostreams/ui`, the shared component kit (Tailwind preset, `theme.css`, components, hooks, format helpers). Source-only: no build step, consumed as `@aiostreams/ui/<component>` by `frontend` and `web`, whose Tailwind `content` must include `../ui/src`.
- `packages/web` — the web app served at every Jellyfin mount's `/web` (rsbuild, own `dist`). The server sends its `index.html` from each mount and serves its hashed assets at `/jellyfin-web/static`. Built for AIOStreams-like Jellyfin servers (direct play only, optional `aiostreams` extension fields), not as a general Jellyfin client. `build:standalone` (`--env-mode standalone`, the `__STANDALONE__` constant) builds a copy that no server hosts and that picks its own server, into `dist-standalone`; the desktop app serves that one, and `packages/smart-tv` packages it.
- `packages/desktop` — the desktop app (Windows, Linux and macOS): a Cargo workspace, outside the pnpm build, that serves `web`'s standalone build in a transparent web view (WebView2 via tao/wry on Windows, WebKitGTK 6 via GTK 4 on Linux, WKWebView via tao/wry on macOS) over libmpv and exposes a checked JSON bridge to mpv as `window.aiostreamsApp`. See its README.
- `packages/android` — the Android app: a Gradle project, outside the pnpm build, that serves `web`'s standalone build from its APK in a WebView over libmpv and speaks the desktop app's bridge as `window.aiostreamsApp`. See its README.
- `packages/smart-tv` — packages `web`'s standalone build (relative asset paths) as an LG webOS `.ipk` and a Samsung Tizen `.wgt`; manifests and icons only, outside the root `pnpm build`. The web app detects the TVs at runtime (`src/lib/hosts/webos.ts`, `tizen/`). See its README.
- `packages/docs` — the docs site (separate build).

### Request flow

1. `packages/server/src/server.ts` boots: initialises DB → templates → Redis (if configured) → AnimeDatabase / SeaDex / Prowlarr preconfigured indexers → registers scheduled `TaskManager` jobs (user pruning, cache eviction) → starts analytics → `app.listen`.
2. `packages/server/src/app.ts` mounts routers:
   - `/api/v{API_VERSION}/*` — JSON API consumed by the SPA (`user`, `health`, `status`, `format`, `catalogs`, `posters`, `oauth/exchange/gdrive`, `debrid`, `search`, `anime`, `proxy`, `templates`, `sync`, `auth`, `dashboard`). 404 handler is scoped to the API router.
   - `/stremio/...` — Stremio protocol endpoints. Public manifest/stream/configure routes are mounted directly; authenticated routes live under `/stremio/:uuid/:encryptedPassword` and go through `userDataMiddleware`, which resolves the `UserData` for the rest of the pipeline.
   - `/chilllink/:uuid/:encryptedPassword/*`, `/seanime/*`, `/builtins/*` (the last gated by `internalMiddleware`).
   - Legacy `/:config/stream/...` returns a single "reconfigure" stream pointing at the new configure URL. Legacy `/configure` redirects to `/stremio/configure`.
   - Static: `/assets/*` is content-hashed and served with `immutable` cache headers and bypasses the static rate limiter; `/logo.png`, favicons, manifest icons go through `staticRateLimiter`; SPA fallback serves `index.html`.
3. Stream requests construct an `AIOStreams` instance (`packages/core/src/main/index.ts`) from the resolved `UserData`. The constructor wires a pipeline of singletons: `Proxifier`, `StreamLimiter`, `StreamFilterer`, `StreamPrecomputer`, `StreamFetcher`, `StreamDeduplicator`, `StreamSorter`. The `setup.ts` helpers (`applyPresets`, `assignPublicIps`, `fetchManifests`, `buildResources`) turn the user's preset selections into concrete `Addon` instances and resolved manifests; `resources.ts` / `catalog.ts` implement the actual `getStreams` / `getCatalog` / `getMeta` / `getSubtitles` / `getAddonCatalog` calls.

### Presets vs builtins

- **Presets** (`packages/core/src/presets/*.ts`, ~80 files, registered in `presetManager.ts`) describe how to configure and call an external Stremio addon (Torrentio, Comet, MediaFusion, Easynews, etc.). Each preset extends a common `Preset` base in `preset.ts` and exposes configuration metadata consumed by the SPA. When adding a new community addon, add a preset file and register it in `presetManager.ts`.
- **Builtins** (`packages/core/src/builtins/*`) are addon implementations hosted in-process (gdrive, knaben, prowlarr, torznab/newznab, eztv, torrent-galaxy, seadex, easynews-search, library, …). They are exposed under `/builtins/<name>` via routes in `packages/server/src/routes/builtins`, and the `internalMiddleware` enforces that they are only called by the engine itself.

### Configuration

- `packages/core/src/config` owns all runtime configuration. `bootstrap.ts` reads env vars via `envalid`; `schema/` defines the user-data shape with zod; `describe.ts` produces metadata for the SPA and for `pnpm gen:env-docs`. After changing any env var or user-data schema, run `pnpm gen:env-docs` and rebuild.
- Per-user configuration is persisted via `packages/core/src/db` (repositories + migrations). The DB layer abstracts SQLite (`better-sqlite3`) and Postgres (`pg`) behind a shared driver — pick by setting the `DATABASE_URI` env var.
- Caching has three backends behind one `Cache` API: in-memory, SQL (rows in the configured DB), and Redis (if `REDIS_URI` is set). The cache clearing tasks in `server.ts` reflect this.

### Frontend

- Routing: TanStack Router with file-based routes in `packages/frontend/src/routes`. The `router.tsx` wires it up.
- Data: TanStack Query against `/api/v{N}/...`. The SPA never talks to `/stremio/*` directly.
- UI: components come from `@aiostreams/ui` (Tailwind 3 + Radix primitives + `class-variance-authority` for variants); `framer-motion`/`motion` for animation.

### Release flow

- `release-please-config.json` drives release-please (conventional commits → version bumps → changelog). `pnpm release` (commit-and-tag-version) is the local equivalent. The CI workflow `.github/workflows/deploy-docker.yml` builds and publishes the Docker image.

## Conventions

- ES modules everywhere (`"type": "module"`). Relative imports inside a package must include the `.js` extension (TypeScript NodeNext resolution) — e.g. `from '../db/index.js'` even though the source is `.ts`.
- Cross-package imports use the workspace name: `from '@aiostreams/core'`.
- Logger: `createLogger('<scope>')` from `@aiostreams/core` (Pino under the hood); do not `console.log`.
- Errors that prevent startup should be thrown as `ConfigStartupError` — `server.ts` prints those without a stack trace.

## This fork (AIOStreams-Friends)

A fork that regularly merges upstream AIOStreams. Kept in this one section so merges of the file above stay clean.

### Working here

- Keep fork changes in new files where possible, and keep edits to upstream files small. Don't hand-edit upstream docs (`packages/docs/content/...`) or translation catalogs, and don't let Prettier reformat untouched parts of shared files.
- Fork strings in `packages/web` are plain literals inside an `eslint-disable lingui/no-unlocalized-strings` block, not `t`. Don't run `i18n:extract`.
- Work on `main` in the main checkout, uncommitted, unless asked to commit. No feature branches or worktrees.
- Fork-owned: `packages/mkv-remuxer`, `packages/core/src/hls`, `packages/server/src/routes/api/hls.ts`, `packages/server/src/routes/jellyfin/hls*.ts`, `packages/web/src/lib/playback/hls.ts` and `cast.ts`. Upstream files the fork also touches include web's `controller.ts` and `pages/player.tsx`.

### Tooling

- `mise.toml` pins Node 24 (the native modules — yencode, better-sqlite3 — are built for it; a newer system Node fails to load them). Use `mise run <task>` or `mise x -- <cmd>`.
- `mise run check` builds, typechecks, lints and tests the packages the fork touches (remuxer, core, server, web). Run it before calling a change done.
- Two dev workflows: `mise run dev` runs everything (the local server on :3000, and the web app's dev server, on :21459, against it); `mise run web` runs only the web app, against the local server by default; a `[tasks.web]` block with only `env` in `mise.local.toml` points it at the deployed one. Anything else goes through `mise x -- <cmd>`.
- Tests: `packages/core` uses Node's test runner through tsx, not vitest — one file is `pnpm -F core exec tsx --test --import ./test/setup.ts src/path/file.test.ts`. `packages/mkv-remuxer` uses vitest; its media tests generate MKVs with ffmpeg and are skipped when `ffmpeg`/`ffprobe` aren't on PATH.
- `scratch/` is a gitignored workspace for test media, scripts and the local instance's data (`DATABASE_URI` points there). The deployed backend and the local server's settings and secrets live in the gitignored `mise.local.toml`; there is no root `.env`. Run the server through `mise run dev` (or `mise x --`), which loads it.

### HLS remux (browser and TV playback without an app)

- Native usenet MKV streams are remuxed on demand to HLS (fMP4 + WebVTT) by `packages/mkv-remuxer`, vendored from FPNDev/mkv-remuxer (see its `VENDORED.md`) and consumed through its `dist`, so run `pnpm -F mkv-remuxer build` (or `mise run check`) before core sees a change to it.
- Path: `core/src/hls/remux.ts` (`serveHls`) → `/api/v1/hls/:token/*`. Jellyfin offers the remux as a version's `TranscodingUrl` (`routes/jellyfin/hls.ts`), and `hls-master.ts` redirects to the master with `?audio=<n>` (`withDefaultAudio`: the n-th audio rendition becomes the default). The web player (`web/src/lib/playback/hls.ts`) plays it with native HLS or hls.js and casts it through the Cast SDK (`cast.ts`).
- One variant, one audio group: AAC, MP3, Opus and FLAC are copied; everything else (AC-3, E-AC-3, DTS, TrueHD…) is transcoded to AAC. Per-client audio passthrough was tried and removed as not worth the negotiation it needs. Dolby Vision profiles 5 and 8 are described in the playlist (`dvh1` / `SUPPLEMENTAL-CODECS`), and every audio language is kept.
- Bump `CACHE_VERSION` in `mkv-remuxer/src/hls/hls-service.ts` when renditions or playlists change (it clears cached masters on start), and `MEDIA_INDEX_VERSION` in `media/media-index.ts` when the index's fields change.

### Local testing

- The Jellyfin web app is at `/jellyfin/<uuid>/<encrypted password>/web/`; sign in with the config UUID as user name and the config password as PIN. Routes are hash routes: `/web/#/play/<itemId>?source=<mediaSourceId>`.
- Media source ids change when the server restarts, so fetch fresh ones from `PlaybackInfo` before a browser test. Only usenet versions go through the remux (a debrid version redirects to `/static/hls/...`).
- Headless Brave doesn't autoplay the player here; start playback from the test (`video.play()`).
