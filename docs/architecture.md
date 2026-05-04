# Architecture

Source of truth for the load-bearing invariants of `tint-website`. Each invariant is stated as a fact paired with the file that enforces it. If reality drifts from this document, fix one or the other — they must agree.

This document describes the steady-state architecture. Cutover or migration status is tracked in PR descriptions, not here.

Invariants marked **(out-of-band)** describe state that lives outside this repo (Cloudflare dashboard, DNS provider, GitHub's release machinery) and cannot be checked by CI. Verify them periodically by hand; the "verify by" hint says how.

## Topology

```
git push master
       │
       ▼
GitHub Action (.github/workflows/deploy.yml)
  ├─ npm ci
  ├─ biome check
  ├─ astro check
  ├─ astro build         →  dist/
  ├─ tsx scripts/smoke-dist.ts
  └─ wrangler deploy
       │
       ▼
Cloudflare Worker (worker/index.ts)
  ├─ /tint, /tint/   →  302 → GitHub Releases  →  download_count++
  │                   └─ tint_download (GET, hostname-gated)  →  plausible.io
  └─ *               →  env.ASSETS.fetch (dist/)
                          (HTML carries a hostname-gated client snippet
                           that fires pageview events to plausible.io)
       │
       ▼
tint.sh  (Cloudflare-managed DNS, Worker custom domain)
```

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

- **Single deploy path.** **(out-of-band)** [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) is the only writer to the Cloudflare Worker. Cloudflare's built-in Git auto-deploy stays disabled to prevent it racing the Action. Verify by: in the Cloudflare dashboard for this Worker, check that the "Builds" / "Git integration" tab shows no connected repository.
- **Deploy is gated on full CI.** Lint, typecheck, build, and smoke test all run in the deploy job before `wrangler deploy`. A failed smoke test fails the deploy.
- **Required repo secrets.** `CLOUDFLARE_API_TOKEN` (Workers Scripts: Edit, all zones from the account) and `CLOUDFLARE_ACCOUNT_ID`.
- **Rollback.** `npx wrangler rollback` from a checkout authenticated against the account, or via the Cloudflare dashboard's deployments list.

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
- **SSL/TLS encryption mode: Full (Strict).** **(out-of-band)** Cloudflare encrypts to the origin _and_ validates the origin's certificate. For our Workers-only deployment the "origin" _is_ Cloudflare, so Full vs Full (Strict) is functionally equivalent today; Strict is set so that a future proxy-fallback origin would be required to present a valid cert from day one. The weaker modes (`Flexible`, `Off`) are forbidden — they break the model the Worker assumes. Verify by: SSL/TLS → Overview in the Cloudflare dashboard reports `Current encryption mode: Full (strict)`.
- **HSTS: deferred (intentional gap).** **(out-of-band)** Not enabled. HSTS is a one-way commitment with a `max-age` window: once a browser has seen the header, it refuses plain HTTP for that duration even if we later misconfigure the zone. Hold off until Always-HTTPS has run cleanly for several days, then enable with a short `max-age` first and ratchet up. There is no rush: Always-HTTPS already eliminates the user-facing symptom.
