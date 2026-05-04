@README.md @CONTRIBUTING.md @docs/architecture.md

## Load-bearing invariants

Do not modify the following without first reading [`docs/architecture.md`](docs/architecture.md). Each invariant is enforced by the file or test linked.

- **`/tint` is a 302, not a static file.** [`worker/index.ts`](worker/index.ts) redirects to the GitHub release. Serving the binary directly breaks `download_count`.
- **Analytics are hostname-gated to `tint.sh`.** Both the client snippet ([`src/layouts/Layout.astro`](src/layouts/Layout.astro)) and the server event ([`worker/index.ts`](worker/index.ts)). Ungated, `*.workers.dev` and `astro dev` pollute the dashboard. Enforced by [`scripts/smoke-dist.ts`](scripts/smoke-dist.ts) `checkPlausibleSnippet`.
- **Site-wide GET/HEAD only.** [`worker/index.ts`](worker/index.ts) returns 405 for any other method. Adding a write-shaped route requires lifting this gate intentionally.
- **Install command points at `https://tint.sh/tint`.** [`src/pages/index.astro`](src/pages/index.astro). Reverting to the raw GitHub URL bloats the displayed command and bypasses the Worker's `tint_download` event. Enforced by [`scripts/smoke-dist.ts`](scripts/smoke-dist.ts) `checkInstallWidget`.
- **Cloudflare Workers Builds is the sole deployer.** Both production (master push) and per-PR previews come from Builds. There is no `.github/workflows/deploy.yml` and no `CLOUDFLARE_API_TOKEN` repo secret. The CI gate runs as the wrangler `build.command` in [`wrangler.jsonc`](wrangler.jsonc), so it executes regardless of which entrypoint invokes wrangler. Adding a second deployer (e.g., a re-introduced GitHub Action that calls `wrangler deploy`) would race Builds and is forbidden.

## What the smoke test guarantees

[`scripts/smoke-dist.ts`](scripts/smoke-dist.ts) runs against `dist/` after every build, locally and in CI. It is the executable spec. If it passes, the install widget is structurally correct, the install URL is the short URL, and every page contains the dynamically-injected, hostname-gated Plausible snippet. Treat it as the contract: if a change breaks an assertion, the change is wrong by default. Removing a `check(...)` call removes a guarantee.

## Where to look first

| Touching                                         | Read                                                                                                                         |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Routing, redirects, server-side analytics events | [`worker/index.ts`](worker/index.ts)                                                                                         |
| Site layout, head tags, client-side analytics    | [`src/layouts/Layout.astro`](src/layouts/Layout.astro)                                                                       |
| Install widget content or behavior               | [`src/components/InstallWidget.astro`](src/components/InstallWidget.astro), [`src/pages/index.astro`](src/pages/index.astro) |
| Test coverage, invariant enforcement             | [`scripts/smoke-dist.ts`](scripts/smoke-dist.ts)                                                                             |
| Deploy pipeline (build gate, preview URLs)       | [`wrangler.jsonc`](wrangler.jsonc) `build.command`, [`docs/architecture.md`](docs/architecture.md) § Deploy pipeline         |
| Independent PR validation (no deploy)            | [`.github/workflows/ci.yml`](.github/workflows/ci.yml)                                                                       |
| Architecture rationale                           | [`docs/architecture.md`](docs/architecture.md)                                                                               |

## Opening a PR

```bash
git push -u origin <branch-name>
gh pr create --title "<subject>" --assignee "@me" --label "<label>"
```
