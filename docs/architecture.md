# Architecture

Source of truth for the load-bearing invariants of `tint-website`. Each invariant is stated as a fact paired with the file that enforces it. If reality drifts from this document, fix one or the other — they must agree.

This document describes the steady-state architecture. Cutover or migration status is tracked in PR descriptions, not here.

Invariants marked **(out-of-band)** describe state that lives outside this repo (Cloudflare dashboard, DNS provider, GitHub's release machinery) and cannot be checked by CI. Verify them periodically by hand; the "verify by" hint says how.

## Topology

```
git push master                git push <feature-branch>  +  PR open
       │                                       │
       ▼                                       ▼
Cloudflare Workers Builds            Cloudflare Workers Builds
  npx wrangler deploy                  npx wrangler versions upload
  └─ build.command (wrangler.jsonc)    └─ build.command (wrangler.jsonc)
       ├─ astro check                       ├─ astro check
       ├─ biome check                       ├─ biome check
       ├─ astro build  →  dist/             ├─ astro build  →  dist/
       └─ smoke-dist.ts                     └─ smoke-dist.ts
       │                                       │
       ▼                                       ▼
Cloudflare Worker (production)        Worker version (preview alias)
  worker/index.ts                       <alias>-tint-website
  ├─ /tint    →  302 → GitHub Releases     .<subdomain>.workers.dev
  │            └─ tint_download (GET,     │  (alias = sanitized branch
  │               hostname-gated)         │   name; canonical URL is
  │                  →  plausible.io      │   the one in the PR comment
  └─ *        →  env.ASSETS.fetch (dist/) │   Cloudflare posts).
                                          │
                                          │  Analytics gate excludes
                                          │  previews (hostname ≠ tint.sh).
       │
       ▼
tint.sh  (Cloudflare-managed DNS, Worker custom domain)
```

GitHub Actions runs [`ci.yml`](../.github/workflows/ci.yml) on every PR (lint + typecheck + build + smoke) as a fast, independent PR check. It does not deploy.

## Hosting

- **Single host.** **(out-of-band)** All `tint.sh` traffic terminates at the Cloudflare Worker. There is no other origin. Verify by: `dig tint.sh` resolves to Cloudflare, and the Cloudflare dashboard shows only this Worker bound to the apex.
- **Static assets via binding.** [`wrangler.jsonc`](../wrangler.jsonc) binds `dist/` as `ASSETS`. The Worker calls `env.ASSETS.fetch(request)` for every request not matched by a custom route.
- **No `dist/tint` file.** `/tint` is a code path, not a static file. A file at that path would shadow the redirect. Enforced by [`scripts/smoke-dist.ts`](../scripts/smoke-dist.ts) `checkAbsent('tint')`.

## Routing ([`worker/index.ts`](../worker/index.ts))

- **Method gate is site-wide.** Methods other than `GET` and `HEAD` return `405 Method Not Allowed` with `Allow: GET, HEAD`. Enforced before any route matching.
- **`/tint` and `/tint/` redirect.** 302 to `https://github.com/corygabrielsen/tint/releases/latest/download/tint`. The trailing-slash variant exists to forgive copy-paste artifacts.
- **Query strings on `/tint` are silently dropped.** The redirect target is fixed; `?utm_source=...` and similar tracking parameters are accepted (no 404, which would be hostile to social links) but are not forwarded to GitHub.
- **`/tint` redirect target preserves `download_count`.** **(out-of-band: depends on GitHub.)** The target is `releases/latest/download/<asset>`, which GitHub itself 302s to the active release asset. The second hop is what increments the per-asset counter. Verify by: hit `/tint` with `curl -L`, then check the GitHub release page's download count incremented.
- **Fallthrough.** All other paths (including subpaths like `/tint/foo`) delegate to the static assets binding. No path-based routing tables.

## Analytics

- **Provider.** Plausible Cloud. Dashboard domain: `tint.sh`. Bundle URL stem: `https://plausible.io/js/pa-`.
- **Two channels.** Client-side pageviews (snippet in [`src/layouts/Layout.astro`](../src/layouts/Layout.astro)) and server-side custom events (`tint_download` from [`worker/index.ts`](../worker/index.ts)).
- **Hostname-gated to `tint.sh` on both channels.** The Plausible bundle auto-fires a pageview at script load, so the client gate must prevent the bundle from loading at all — gating only `plausible.init()` would not work. The server gate must precede the `fetch` to Plausible.
- **Server-side observability events fire only on the request shape that matches the user-action being measured.** A side-effect must be gated to fire only when the request actually represents the recorded action — not merely when the route accepts it. For `tint_download`: `GET /tint` only. HEAD still receives the redirect (per HTTP semantics) but does not fire an event, because link checkers, monitoring probes, and social preview crawlers use HEAD without fetching the binary, and GitHub's `download_count` only increments on the GET that pulls bytes. New side-effects added to the Worker MUST be gated by the same principle.
- **Server events forward client identity.** UA, `cf-connecting-ip`, and `cf-ipcountry` are forwarded so Plausible's standard browser / OS / country / unique-visitor breakdowns work for `tint_download` the same way they work for client pageviews.
- **Server events use `ctx.waitUntil`.** Without it the runtime cancels the in-flight POST as soon as the redirect returns, undercounting events under load.
- **Analytics failures are silent.** The `trackDownload` catch is empty by design: a Plausible outage must not deny users their download.
- **Snippet completeness is enforced by the smoke test.** [`scripts/smoke-dist.ts`](../scripts/smoke-dist.ts) `checkPlausibleSnippet` requires bundle URL stem, `plausible.init()` call, and the `tint.sh` hostname gate to all live in the _same_ inline `<script>` body — see § Smoke test as executable spec.

## Install widget ([`src/pages/index.astro`](../src/pages/index.astro))

- **Curl URL is the short URL.** Display value is `https://tint.sh/tint`. The widget MUST NOT display the raw GitHub URL: it both bloats the displayed command and bypasses the `tint_download` event.

## Deploy pipeline

- **Single automated deploy path.** **(out-of-band)** Cloudflare Workers Builds is the only automated deployer — both for production (master) and per-PR previews. There is no GitHub Action deploy job and no automation in this repo consumes `CLOUDFLARE_API_TOKEN`. Adding a second _automated_ deployer (e.g., a re-introduced GitHub Action that calls `wrangler deploy`) would race Builds and is forbidden. Verify by: in the Cloudflare dashboard for this Worker, the "Settings → Build" panel shows this repository connected; no `.github/workflows/deploy.yml` exists in the repo.
- **CI gate is wrangler-side, not CI-side.** [`wrangler.jsonc`](../wrangler.jsonc) `build.command` runs `astro check && biome check && astro build && smoke-dist.ts`. Wrangler executes it before any rebuilding command (e.g. `wrangler deploy`, `wrangler versions upload`), whether triggered by Builds or by an operator from a local checkout. A failure aborts the wrangler invocation that triggered it. No rebuilding path via wrangler skips this gate. (Rollback paths skip it; see the next bullet.)
- **Operator escape hatches.** `wrangler rollback` from an authenticated checkout, and the Cloudflare dashboard's rollback / "promote previous version" actions, write to production by reusing a previously-deployed version's bytes. They do not rebuild and therefore do not run the wrangler `build.command` gate. This is correct: the gate guards _new_ code; rollback restores known-good code that already passed it. Use during incidents only.
- **Independent PR check.** [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs the same checks on every PR via GitHub Actions. Strictly redundant with the wrangler gate; kept for fast PR feedback (no Cloudflare Builds provisioning latency) and for catching environment-specific issues that only manifest on GitHub's runners.
- **Production deploy command.** **(out-of-band)** Default `npx wrangler deploy`. Set in the Cloudflare Builds dashboard under "Build configuration → Deploy command." Verify by: dashboard shows this exact command.
- **Preview deploy command.** **(out-of-band)** Default `npx wrangler versions upload`. Cloudflare Builds runs this for every non-production branch with an open PR; the resulting alias URL is posted as a PR comment by Cloudflare's GitHub App.

## Preview deployments

- **One alias per PR branch.** **(out-of-band, Cloudflare-managed)** Each PR commit triggers a Workers Builds build. On success it uploads a new Worker version aliased to a sanitized form of the branch name. The hostname has the shape `<alias>-tint-website.<subdomain>.workers.dev`, where Cloudflare derives `<alias>` from the branch name under the constraints below. The alias is stable across pushes to the same branch, so a phone-side bookmark survives every commit on that PR. **The canonical URL for any given PR is the one Cloudflare's GitHub App posts as a sticky PR comment** — Cloudflare's branch-to-alias derivation is partially undocumented (the public docs say "uses actual branch name as is" while also requiring aliases to satisfy the charset rules below, so an unspecified sanitization step bridges the gap), and reconstructing the URL from a formula here is brittle; trust the comment.
- **Alias constraints (Cloudflare-published).** Lowercase letters, digits, and dashes only; must begin with a lowercase letter; alias + worker name + dash ≤ 63 characters (DNS label limit). Branches whose names exceed the limit get truncated with a 4-character hash suffix per Cloudflare's [Aug 2025 long-name update](https://developers.cloudflare.com/changelog/post/2025-08-08-support-long-branch-names-preview-aliases/). [`CONTRIBUTING.md`](../CONTRIBUTING.md) requires branch names of the form `<type>/<short-description>`, so every valid branch in this repo contains a `/` that Cloudflare must sanitize before the alias is valid; the exact transform is not part of this contract.
- **Preview URLs require [`preview_urls: true`](../wrangler.jsonc).** Wrangler 4.34+ defaults this off; without it, alias URLs return Cloudflare's "preview disabled" page even after a successful upload.
- **Previews bypass production.** A `wrangler versions upload` does not promote the version to the active deployment slot. Production at `tint.sh` continues serving the previous deploy until master receives a push and `wrangler deploy` runs.
- **Analytics auto-exclude previews.** The hostname gate in [`worker/index.ts`](../worker/index.ts) and [`src/layouts/Layout.astro`](../src/layouts/Layout.astro) checks `hostname === 'tint.sh'`. Preview hostnames don't match, so `tint_download` events and pageviews don't fire — previews can't pollute the dashboard. This is the same gate that excludes `*.workers.dev` and `astro dev`; previews are a third class of caller it covers for free.
- **Limit.** Cloudflare retains the 1000 most-recently-deployed aliases per Worker. We have one alias per open + recently-merged PR; the cap is unreachable in practice. Closed-PR aliases stay accessible until evicted, which is a feature (revisiting an old PR's preview is free).
- **Custom-domain previews are not supported.** **(Cloudflare beta limitation.)** Previews live only on `*.workers.dev`. There is no `pr-N.preview.tint.sh` today.

## Smoke test as executable spec

[`scripts/smoke-dist.ts`](../scripts/smoke-dist.ts) runs against `dist/` after every build, locally and in CI. It is the on-disk contract for the invariants this document declares. Asserted:

**Install widget** (`checkInstallWidget`)

- Renders exactly two `data-copy` buttons (brew + curl) inside the `.install-widget` fieldset.
- Each button's `aria-label` equals `Copy ${data-code}` (after HTML-entity decoding).
- At least one button's `data-code` references `https://tint.sh/tint` (install-URL drift guard).
- An inlined `<script>` references the `.install-widget [data-copy]` selector (handler-wiring guard).

**Analytics** (`checkPlausibleSnippet`, every HTML page)

- An inline `<script>` body contains all three of: bundle URL stem `plausible.io/js/pa-`, `plausible.init()` call, `location.hostname === 'tint.sh'` gate.
- All three must be in the _same_ script — splitting requirements across scripts is a documented false-pass mode and rejected explicitly.

**Accessibility** (`checkVideoElements`, `checkIconOnlyLinks`, `checkLabelControlWiring`)

- Every `<video>` carries a non-empty `aria-label`. `<video autoplay>` also carries `muted` and `playsinline` (autoplay policies block silently otherwise).
- Every `<a>` whose only child is `<svg>` carries `aria-label` or `aria-labelledby` (WCAG 2.4.4).
- Every `<label for="x">` matches an element with `id="x"` on the same page (the install widget tabs depend on this wiring; a typo silently kills tab switching).

**Asset existence** (`checkFaviconLinks`, `checkNonEmptyFile`)

- Every `<link rel="icon">` href resolves to an existing non-empty file in `dist/`.
- `demo.mp4`, `demo.gif`, `robots.txt`, `sitemap-index.xml` exist and are non-empty.

**Path correctness**

- Homepage `<video>` src is relative (no leading slash, no scheme) and resolves to `/demo.mp4` under `https://tint.sh/`.

**Route shadowing guards** (`checkAbsent`, ENOENT-only success)

- `dist/tint` does not exist (would shadow the Worker's `/tint` redirect via the assets binding).
- `dist/CNAME` does not exist (GitHub-Pages-specific artifact; this site deploys to Workers).

Adding a new invariant means adding a `check(...)` call. Removing a `check` removes a guarantee — review accordingly.

## DNS

- **DNS is on Cloudflare.** **(out-of-band)** Apex `tint.sh` is bound to the Worker as a custom domain (no maintained A/AAAA records). Verify by: `dig tint.sh NS` returns Cloudflare nameservers, and the Worker's "Settings → Domains & Routes" panel lists `tint.sh`.
- **Email forwarding lives in MX + SPF records on this zone.** **(out-of-band)** The Cloudflare zone holds MX records that route `*@tint.sh` mail to a third-party forwarding service, plus an SPF TXT record that authorizes that service to send on behalf of the domain (without it, downstream mail servers will mark forwarded mail as spam). There is no in-repo signal and no CI guard for either record set; deleting them silently breaks email at the apex. Verify by: `dig tint.sh MX` returns external mail hosts AND `dig tint.sh TXT | grep -i 'v=spf1'` returns an SPF record naming the same forwarding service.
- **Out-of-band.** DNS changes are not in this codebase and not in CI.

## TLS at the edge

All settings below live in the Cloudflare zone for `tint.sh`. None are reproducible from this repo and CI cannot guard them — verify by hand using the hints below.

- **Always Use HTTPS: ON.** **(out-of-band)** Cloudflare answers `http://tint.sh` with `301 → https://tint.sh/` before the request ever reaches the Worker. Without this, plain-HTTP visitors load the page successfully but browsers flag the address bar "Not secure," because HTTPS is supported but not _enforced_. Verify by: `curl -sI http://tint.sh` returns `HTTP/1.1 301` and `Location: https://tint.sh/`.
- **Minimum TLS Version: 1.2.** **(out-of-band)** Connections that cannot negotiate TLS 1.2 or higher are rejected at handshake time. TLS 1.0 and 1.1 are deprecated by [RFC 8996](https://datatracker.ietf.org/doc/html/rfc8996) (2021) and dropped by every modern browser in 2020. The floor is set at 1.2 — not 1.3 — so that older legitimate clients hitting `/tint` (older `curl` builds, CI runners, enterprise TLS-inspecting middleboxes) still complete the download. Cloudflare's account-wide default is TLS 1.0 for "broadest compatibility, breaks no customer on day one"; we opt in to the stricter floor because we have no legacy clients to support. Verify by: `curl --tls-max 1.1 https://tint.sh` fails with a handshake error.
- **TLS 1.3: enabled.** **(out-of-band)** TLS 1.3 ([RFC 8446](https://datatracker.ietf.org/doc/html/rfc8446), 2018) is the current standard ceiling — there is no TLS 1.4. Enabling 1.3 lets modern clients negotiate the faster, more secure handshake; older clients fall back to 1.2 within the floor set above. Verify by: `curl -sIv https://tint.sh 2>&1 | grep 'SSL connection using'` reports `TLSv1.3`.
- **SSL/TLS encryption mode: Full (Strict).** **(out-of-band)** Cloudflare encrypts to the origin _and_ validates the origin's certificate. For our Workers-only deployment the "origin" _is_ Cloudflare, so Full vs Full (Strict) is functionally equivalent today; Strict is set so that a future proxy-fallback origin would be required to present a valid cert from day one. The weaker modes (`Flexible`, `Off`) are forbidden — they break the model the Worker assumes. Verify by: SSL/TLS → Overview in the Cloudflare dashboard reports `Current encryption mode: Full (strict)`. Shell-runnable alternative (requires a token with `Zone:SSL and Certificates:Read`): `curl -sH "Authorization: Bearer $CF_API_TOKEN" "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/settings/ssl" | jq -r '.result.value'` returns `strict`.
- **HSTS: deferred (intentional tradeoff).** **(out-of-band)** Not enabled. HSTS pins the browser to HTTPS for a `max-age` window — once a browser has seen the header it refuses plain HTTP for that duration even if we later misconfigure the zone. Deferring trades **downgrade-attack protection** (a network-level MITM can intercept the bare-hostname `http://tint.sh` request before the Always-HTTPS 301 fires; HSTS would block that on every visit after the first, and preload would block it on the very first too) for **rollback safety** while the new edge config bakes in. The exposure window is narrow for a static download page, but not zero. Enable with a short `max-age` once Always-HTTPS has run cleanly for several days, ratchet up, then submit to the [HSTS preload list](https://hstspreload.org/). Verify by: `curl -sI https://tint.sh | grep -i strict-transport-security` returns nothing while deferred.
