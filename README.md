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

Auto-deploys on push to `master` via [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml). The Action runs the full CI suite (lint + typecheck + build + smoke) before invoking `wrangler deploy`. Cloudflare's built-in Git auto-deploy is disabled to prevent races.

## Architecture (30 seconds)

- **Host.** Cloudflare Worker (`worker/index.ts` + `wrangler.jsonc`). Static assets in `dist/` are served via the Workers Static Assets binding.
- **`/tint` short URL.** 302 to the GitHub release asset. Preserves GitHub's per-asset `download_count` via the second-hop redirect.
- **Analytics.** Plausible. Client snippet in `src/layouts/Layout.astro`; server-side `tint_download` events from the Worker. Both gated to `hostname === 'tint.sh'`.

For the full invariant catalog see [`docs/architecture.md`](docs/architecture.md). For agent-specific guidance see [`AGENTS.md`](AGENTS.md). For commit and branch conventions see [`CONTRIBUTING.md`](CONTRIBUTING.md).
