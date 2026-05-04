# tint-website

Marketing site for [tint](https://github.com/corygabrielsen/tint), a terminal theme switcher.

Deployed to [tint.sh](https://tint.sh) as a Cloudflare Worker.

## Develop

```bash
npm install     # one-time
npm run dev     # local dev server (astro dev)
npm run check   # full validation chain (typecheck + lint + build + smoke)
```

The individual steps (`npm run typecheck`, `npm run lint`, `npm run build`, `npm run smoke`) are also available for iteration.

## Deploy

Auto-deploys on push to `master` via Cloudflare Workers Builds. The CI gate is `npm run check` (defined in [`package.json`](package.json)); [`wrangler.jsonc`](wrangler.jsonc) `build.command` calls into it, so wrangler runs the same chain before any command that builds the Worker — Builds, or a manual `wrangler deploy` from an authenticated checkout. A failing check aborts the deploy. There is no GitHub Action deploy job. The deliberate escape hatches that bypass the gate are `wrangler rollback` and the Cloudflare dashboard's rollback / promote-version actions; they reuse already-built bytes (no rebuild ⇒ no gate) and are reserved for incident response.

Each PR gets its own stable preview URL of the shape `<alias>-tint-website.<subdomain>.workers.dev`, where Cloudflare derives `<alias>` from the branch name (lowercase letters, numbers, and dashes only; `/` and other invalid hostname characters are sanitized; long branches truncated with a hash suffix). The exact URL for any given PR is the one Cloudflare's GitHub App posts as a sticky PR comment — that comment, not a formula in this README, is the source of truth.

## Architecture (30 seconds)

- **Host.** Cloudflare Worker (`worker/index.ts` + `wrangler.jsonc`). Static assets in `dist/` are served via the Workers Static Assets binding.
- **`/tint` short URL.** On `tint.sh`, 302 to the GitHub release asset (preserves GitHub's per-asset `download_count` via the second-hop redirect). On preview hostnames, 404 — see per-surface gates below.
- **Per-surface gates.** Behaviors with externally-observable side effects on `tint.sh` are conditioned on `hostname === 'tint.sh'`: the Plausible client snippet, the server `tint_download` event, the `/tint` redirect, and the absence of `X-Robots-Tag: noindex`. Previews don't trigger any of them, so they can't pollute analytics, inflate `download_count`, or appear in search-engine results.

For the full invariant catalog see [`docs/architecture.md`](docs/architecture.md). For agent-specific guidance see [`AGENTS.md`](AGENTS.md). For commit and branch conventions see [`CONTRIBUTING.md`](CONTRIBUTING.md).
