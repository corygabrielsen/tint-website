@README.md @CONTRIBUTING.md @docs/architecture.md

## Load-bearing invariants

Do not modify the following without first reading [`docs/architecture.md`](docs/architecture.md). Each invariant is enforced by the file or test linked.

- **`/tint` is a 302, not a static file.** [`worker/index.ts`](worker/index.ts) redirects to the GitHub release. Serving the binary directly breaks `download_count`.
- **Per-surface side effects are hostname-gated to `tint.sh`.** The Worker runs identical code on `tint.sh` and on per-PR `*.workers.dev` preview hosts; behaviors with externally-observable side effects must therefore be conditioned on `url.hostname === 'tint.sh'`. Today four gates implement this: the client Plausible snippet ([`src/layouts/Layout.astro`](src/layouts/Layout.astro)), the server `tint_download` event ([`worker/index.ts`](worker/index.ts)), the `/tint` → GitHub redirect itself ([`worker/index.ts`](worker/index.ts) — preview hosts 404 on `/tint`), and `X-Robots-Tag: noindex, nofollow` on non-canonical responses ([`worker/index.ts`](worker/index.ts)). Without them, previews and `astro dev` would inflate the Plausible dashboard, GitHub's `download_count`, and search-engine duplicate-content rankings respectively. Adding a new behavior with externally-observable side effects requires a new gate. Enforced by [`scripts/smoke-dist.ts`](scripts/smoke-dist.ts) `checkPlausibleSnippet` (client snippet, parsed from rendered HTML) and [`scripts/smoke-worker.ts`](scripts/smoke-worker.ts) (behavior test that exercises the Worker against canonical and preview hostnames — strictly stronger than static source inspection).
- **Site-wide GET/HEAD only.** [`worker/index.ts`](worker/index.ts) returns 405 for any other method. Adding a write-shaped route requires lifting this gate intentionally.
- **Install command points at `https://tint.sh/tint`.** [`src/pages/index.astro`](src/pages/index.astro). Reverting to the raw GitHub URL bloats the displayed command and bypasses the Worker's `tint_download` event. Enforced by [`scripts/smoke-dist.ts`](scripts/smoke-dist.ts) `checkInstallWidget`.
- **Cloudflare Workers Builds is the only automated deployer.** Both production (master push) and per-PR previews come from Builds. There is no `.github/workflows/deploy.yml` and no automation in this repo consumes `CLOUDFLARE_API_TOKEN`. Adding a second _automated_ deployer (e.g., a re-introduced GitHub Action that calls `wrangler deploy`) would race Builds and is forbidden.
- **The CI gate lives in `wrangler.jsonc` → `package.json`, not in any YAML.** [`wrangler.jsonc`](wrangler.jsonc) `build.command` is `npm run check`; the chain itself (typecheck + lint + build + smoke) is defined once in [`package.json`](package.json) and shared with `.github/workflows/ci.yml`. Wrangler invokes `build.command` before any rebuilding command (e.g. `wrangler deploy`, `wrangler versions upload`), whether triggered by Builds or by an operator from a local checkout. No rebuilding path via wrangler skips this gate. `build.command === "npm run check"` and `preview_urls === true` are themselves enforced by [`scripts/smoke-dist.ts`](scripts/smoke-dist.ts) `checkWranglerConfig` so neither can silently regress.
- **Operator escape hatches deliberately bypass the gate.** `wrangler rollback` and the Cloudflare dashboard's rollback/promote-version actions reuse a previously-deployed version's bytes — there is nothing to rebuild, so the gate does not run. Use these for incident response only; they trade gate-coverage for speed and known-good-state recovery.

## What the smoke test guarantees

Two smoke files form the executable spec. `npm run smoke` runs both:

- [`scripts/smoke-dist.ts`](scripts/smoke-dist.ts): static assertions on `dist/` and on `wrangler.jsonc`. Catches install-widget structure drift, missing Plausible snippet, accidental `dist/CNAME` resurrection, and `wrangler.jsonc` losing `build.command` or `preview_urls`.
- [`scripts/smoke-worker.ts`](scripts/smoke-worker.ts): behavior tests on `worker/index.ts`. Imports the Worker module, mocks `env.ASSETS` and `globalThis.fetch`, and exercises the handler against canonical and preview hostnames to verify per-surface gates fire correctly. Strictly stronger than static source inspection: a refactor that moves the gate condition into a dead branch fails the behavior test even if the source still contains the right substrings.

Treat both as the contract: if a change breaks an assertion, the change is wrong by default. Removing a `check(...)` call removes a guarantee.

## Where to look first

| Touching                                         | Read                                                                                                                         |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Routing, redirects, server-side analytics events | [`worker/index.ts`](worker/index.ts)                                                                                         |
| Site layout, head tags, client-side analytics    | [`src/layouts/Layout.astro`](src/layouts/Layout.astro)                                                                       |
| Install widget content or behavior               | [`src/components/InstallWidget.astro`](src/components/InstallWidget.astro), [`src/pages/index.astro`](src/pages/index.astro) |
| Test coverage, invariant enforcement             | [`scripts/smoke-dist.ts`](scripts/smoke-dist.ts), [`scripts/smoke-worker.ts`](scripts/smoke-worker.ts)                       |
| Deploy pipeline (build gate, preview URLs)       | [`wrangler.jsonc`](wrangler.jsonc) `build.command`, [`docs/architecture.md`](docs/architecture.md) § Deploy pipeline         |
| Independent PR validation (no deploy)            | [`.github/workflows/ci.yml`](.github/workflows/ci.yml)                                                                       |
| Architecture rationale                           | [`docs/architecture.md`](docs/architecture.md)                                                                               |

## Opening a PR

```bash
git push -u origin <branch-name>
gh pr create --title "<subject>" --assignee "@me" --label "<label>"
```
