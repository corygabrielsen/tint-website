# tint-website

Marketing site for [tint](https://github.com/corygabrielsen/tint), a terminal theme switcher.

Deployed to [tint.sh](https://tint.sh) as a Cloudflare Worker.

## Develop

```bash
npm install                       # one-time
npm run dev                       # local dev server (astro dev)
npm run build                     # static build into dist/
npx astro check                   # typecheck
npx biome check .                 # lint + format
npx tsx scripts/smoke-dist.ts     # structural assertions on dist/
```

## Deploy

Auto-deploys on push to `master` via Cloudflare Workers Builds. The CI gate (lint + typecheck + build + smoke) lives in [`wrangler.jsonc`](wrangler.jsonc) `build.command`, so wrangler runs it before any command that builds the Worker — Builds, or a manual `wrangler deploy` from an authenticated checkout. A failing smoke test aborts the deploy. There is no GitHub Action deploy job. The deliberate escape hatches that bypass the gate are `wrangler rollback` and the Cloudflare dashboard's rollback / promote-version actions; they reuse already-built bytes (no rebuild ⇒ no gate) and are reserved for incident response.

Each PR gets its own stable preview URL of the shape `<alias>-tint-website.<subdomain>.workers.dev`, where Cloudflare derives `<alias>` from the branch name (lowercase letters, numbers, and dashes only; `/` and other invalid hostname characters are sanitized; long branches truncated with a hash suffix). The exact URL for any given PR is the one Cloudflare's GitHub App posts as a sticky PR comment — that comment, not a formula in this README, is the source of truth.

## Architecture (30 seconds)

- **Host.** Cloudflare Worker (`worker/index.ts` + `wrangler.jsonc`). Static assets in `dist/` are served via the Workers Static Assets binding.
- **`/tint` short URL.** 302 to the GitHub release asset. Preserves GitHub's per-asset `download_count` via the second-hop redirect.
- **Analytics.** Plausible. Client snippet in `src/layouts/Layout.astro`; server-side `tint_download` events from the Worker. Both gated to `hostname === 'tint.sh'`.

For the full invariant catalog see [`docs/architecture.md`](docs/architecture.md). For agent-specific guidance see [`AGENTS.md`](AGENTS.md). For commit and branch conventions see [`CONTRIBUTING.md`](CONTRIBUTING.md).
