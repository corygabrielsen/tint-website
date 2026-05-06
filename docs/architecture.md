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
  └─ build.command:                    └─ build.command:
       npm run check                        npm run check
       (typecheck + lint + build +          (single source of truth
        smoke suite)                         in package.json)
       │                                       │
       ▼                                       ▼
Cloudflare Worker (production)        Worker version (preview alias)
  worker/index.ts                       <alias>-tint-website
  ├─ /tint    →  302 → GitHub Releases     .<subdomain>.workers.dev
  │            └─ tint_download (GET)    │  Same Worker code, different
  │                  →  plausible.io      │  hostname. Per-surface gates
  └─ *        →  env.ASSETS.fetch (dist/) │  in worker/index.ts apply:
                                          │   • /tint 404s (fallthrough)
                                          │   • tint_download suppressed
                                          │   • pageviews suppressed
                                          │   • X-Robots-Tag: noindex
                                          │  on every asset response.
       │
       ▼
tint.sh  (Cloudflare-managed DNS, Worker custom domain)
```

Both `wrangler deploy` and `wrangler versions upload` invoke the build via [`wrangler.jsonc`](../wrangler.jsonc) `build.command`, which calls `npm run check` — the single source of truth for the validation chain (defined in [`package.json`](../package.json)). GitHub Actions runs the identical `npm run check` on every PR via [`ci.yml`](../.github/workflows/ci.yml) as a fast, independent PR check; it does not deploy.

## Hosting

- **Single host.** **(out-of-band)** All `tint.sh` traffic terminates at the Cloudflare Worker. There is no other origin. Verify by: `dig tint.sh` resolves to Cloudflare, and the Cloudflare dashboard shows only this Worker bound to the apex.
- **Static assets via binding.** [`wrangler.jsonc`](../wrangler.jsonc) binds `dist/` as `ASSETS`. The Worker calls `env.ASSETS.fetch(request)` for every request not matched by a custom route.
- **No `dist/tint` file.** `/tint` is a code path, not a static file. A file at that path would shadow the redirect. Enforced by [`scripts/smoke-dist.ts`](../scripts/smoke-dist.ts) `checkAbsent('tint')`.

## Routing ([`worker/index.ts`](../worker/index.ts))

- **Method gate is site-wide.** Methods other than `GET` and `HEAD` return `405 Method Not Allowed` with `Allow: GET, HEAD`. Enforced before any route matching.
- **`/tint` and `/tint/` redirect on canonical host only.** 302 to `https://github.com/corygabrielsen/tint/releases/latest/download/tint`. The trailing-slash variant exists to forgive copy-paste artifacts. The route is gated on `url.hostname === CANONICAL_HOST` (== `'tint.sh'`); on preview hostnames the request falls through to the asset binding (and 404s, since no static `/tint` file exists). Without this gate, preview traffic would 302 to GitHub and inflate the per-asset `download_count` while the matching Plausible `tint_download` event stays correctly suppressed — the two analytics surfaces would drift apart. Enforced by [`scripts/smoke-worker.ts`](../scripts/smoke-worker.ts) (behavior test that exercises the Worker against canonical and preview hostnames).
- **Query strings on `/tint` are silently dropped.** The redirect target is fixed; `?utm_source=...` and similar tracking parameters are accepted (no 404, which would be hostile to social links) but are not forwarded to GitHub.
- **`/tint` redirect target preserves `download_count`.** **(out-of-band: depends on GitHub.)** The target is `releases/latest/download/<asset>`, which GitHub itself 302s to the active release asset. The second hop is what increments the per-asset counter. Verify by: hit `/tint` with `curl -L`, then check the GitHub release page's download count incremented.
- **Non-canonical hosts emit `X-Robots-Tag: noindex, nofollow`.** Every asset response served on a hostname other than `CANONICAL_HOST` has the header appended in [`worker/index.ts`](../worker/index.ts). Without it, search engines could index preview URLs as duplicate content of `tint.sh` and rank a preview above the canonical site. The HTTP header is preferred over a `<meta name="robots">` tag because it requires no per-page render-time logic, applies uniformly to every response (HTML, sitemap, etc.), and is invisible to humans. Enforced by [`scripts/smoke-worker.ts`](../scripts/smoke-worker.ts) (behavior test that asserts the header is present on preview hosts and absent on the canonical host).
- **Fallthrough.** All other paths (including subpaths like `/tint/foo`) delegate to the static assets binding. No path-based routing tables.

## Analytics

- **Provider.** Plausible Cloud. Dashboard domain: `tint.sh`. Bundle URL stem: `https://plausible.io/js/pa-`.
- **Two channels.** Client-side pageviews (snippet in [`src/layouts/Layout.astro`](../src/layouts/Layout.astro)) and server-side custom events (`tint_download` from [`worker/index.ts`](../worker/index.ts)).
- **Hostname-gated to `tint.sh` on both channels.** The Plausible bundle auto-fires a pageview at script load, so the client gate must prevent the bundle from loading at all — gating only `plausible.init()` would not work. The server gate must precede the `fetch` to Plausible.
- **Server-side observability events fire only on the request shape that matches the user-action being measured.** A side-effect must be gated to fire only when the request actually represents the recorded action — not merely when the route accepts it. For `tint_download`: `GET /tint` only. HEAD still receives the redirect (per HTTP semantics) but does not fire an event, because link checkers, monitoring probes, and social preview crawlers use HEAD without fetching the binary, and GitHub's `download_count` only increments on the GET that pulls bytes. New side-effects added to the Worker MUST be gated by the same principle.
- **Server events forward client identity.** UA, `cf-connecting-ip`, and `cf-ipcountry` are forwarded so Plausible's standard browser / OS / country / unique-visitor breakdowns work for `tint_download` the same way they work for client pageviews. Each of the three forwarding axes is asserted independently by [`scripts/smoke-worker.ts`](../scripts/smoke-worker.ts), against both the present-headers path (every header forwards intact) and the absent-headers path (every header falls back to its documented default). A regression that remaps one to the wrong inbound name (e.g. `cf-country` instead of `cf-ipcountry`) surfaces as a pinpoint failure naming the specific axis.
- **Server events use `ctx.waitUntil`.** Without it the runtime cancels the in-flight POST as soon as the redirect returns, undercounting events under load.
- **Analytics failures are silent.** The `trackDownload` catch is empty by design: a Plausible outage must not deny users their download.
- **Snippet completeness is enforced by the smoke test.** [`scripts/smoke-dist.ts`](../scripts/smoke-dist.ts) `checkPlausibleSnippet` requires bundle URL stem, `plausible.init()` call, and the `tint.sh` hostname gate to all live in the _same_ inline `<script>` body — see § Smoke test as executable spec.

## Install widget ([`src/pages/index.astro`](../src/pages/index.astro))

- **Curl URL is the short URL.** Display value is `https://tint.sh/tint`. The widget MUST NOT display the raw GitHub URL: it both bloats the displayed command and bypasses the `tint_download` event.

## Demo videos ([`src/scripts/demo-videos.ts`](../src/scripts/demo-videos.ts))

- **One global player.** All homepage demo videos share one playback state. At most one video may play at a time; every inactive video is paused and reset to frame zero when playback is not globally paused. Enforced by [`scripts/smoke-demo-videos.ts`](../scripts/smoke-demo-videos.ts).
- **Viewport focus chooses the active video.** The controller scores each video by visible area and distance from the viewport center. A minimum visible ratio rejects barely-visible videos, and scroll clears any manual override so the most in-focus video resumes ownership.
- **Click/keyboard pause is global.** Activating the currently-playing video pauses all videos. While globally paused, activating any demo frame resumes the currently active/focused video; it must not switch to the clicked frame just because every frame shows a play overlay. Activating an inactive video only selects it while playback is already running. While globally paused, every demo frame carries `data-demo-paused` so every visible video shows the play overlay; the overlay must not jump between sections as the viewer scrolls.
- **Reduced motion starts paused.** `prefers-reduced-motion: reduce` seeds the page-load default to paused, but a user click can still opt into playback. A later reduced-motion change pauses globally. The listener supports both modern `addEventListener('change', ...)` and legacy WebKit `addListener(...)`.
- **Poster handoff is conservative.** Each video has a poster shim image above the `<video>` to avoid iPhone Safari's blank white pre-paint box. The shim is released only for the active unpaused video after readiness and two animation frames; stale scheduled releases are canceled when a video loses ownership. Visibility changes reset videos and restore poster shim state.

## Deploy pipeline

- **Single automated deploy path.** **(out-of-band)** Cloudflare Workers Builds is the only automated deployer — both for production (master) and per-PR previews. There is no GitHub Action deploy job and no automation in this repo consumes `CLOUDFLARE_API_TOKEN`. Adding a second _automated_ deployer (e.g., a re-introduced GitHub Action that calls `wrangler deploy`) would race Builds and is forbidden. Verify by: in the Cloudflare dashboard for this Worker, the "Settings → Build" panel shows this repository connected; no `.github/workflows/deploy.yml` exists in the repo.
- **CI gate is wrangler-side, not CI-side.** [`wrangler.jsonc`](../wrangler.jsonc) `build.command` runs `npm run check` — the single source of truth for the validation chain (typecheck + lint + build + smoke; defined in [`package.json`](../package.json)). Wrangler executes it before any rebuilding command (e.g. `wrangler deploy`, `wrangler versions upload`), whether triggered by Builds or by an operator from a local checkout. A failure aborts the wrangler invocation that triggered it. No rebuilding path via wrangler skips this gate. (Rollback paths skip it; see the next bullet.)
- **`build.command` and `preview_urls` are smoke-enforced.** [`scripts/smoke-dist.ts`](../scripts/smoke-dist.ts) `checkWranglerConfig` parses [`wrangler.jsonc`](../wrangler.jsonc) and asserts `build.command === "npm run check"` and `preview_urls === true`. Either silently changing breaks deploys (a different `build.command` would deploy without the gate; removing `preview_urls` would silently disable preview URLs after the next deploy) — both regressions fail the smoke gate, which fails the deploy.
- **Operator escape hatches.** `wrangler rollback` from an authenticated checkout, and the Cloudflare dashboard's rollback / "promote previous version" actions, write to production by reusing a previously-deployed version's bytes. They do not rebuild and therefore do not run the wrangler `build.command` gate. The trade-off is deliberate: rollback prioritizes speed-to-known-good-state over re-validation, on the operational assumption that a version that ran in production previously is recoverable code rather than novel code. (Note: versions deployed before this gate was introduced are still in the rollback list and never passed `build.command`. The first few rollback targets after this PR ships have that asterisk on them; subsequent rollback targets all came through the gate.) Use during incidents only.
- **Independent PR check.** [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) calls the same `npm run check` on every PR via GitHub Actions. Strictly redundant with the wrangler gate; kept for fast PR feedback (no Cloudflare Builds provisioning latency) and for catching environment-specific issues that only manifest on GitHub's runners.
- **Production deploy command.** **(out-of-band)** Default `npx wrangler deploy`. Set in the Cloudflare Builds dashboard under "Build configuration → Deploy command." Verify by: dashboard shows this exact command.
- **Preview deploy command.** **(out-of-band)** Default `npx wrangler versions upload`. Cloudflare Builds runs this for every non-production branch with an open PR; the resulting alias URL is posted as a PR comment by Cloudflare's GitHub App.

## Preview deployments

- **One alias per PR branch.** **(out-of-band, Cloudflare-managed)** Each PR commit triggers a Workers Builds build. On success it uploads a new Worker version aliased to a sanitized form of the branch name. The hostname has the shape `<alias>-tint-website.<subdomain>.workers.dev`, where Cloudflare derives `<alias>` from the branch name under the constraints below. The alias is stable across pushes to the same branch, so a phone-side bookmark survives every commit on that PR. **The canonical URL for any given PR is the one Cloudflare's GitHub App posts as a sticky PR comment** — Cloudflare's branch-to-alias derivation is partially undocumented (the public docs say "uses actual branch name as is" while also requiring aliases to satisfy the charset rules below, so an unspecified sanitization step bridges the gap), and reconstructing the URL from a formula here is brittle; trust the comment.
- **Alias constraints (Cloudflare-published).** Lowercase letters, digits, and dashes only; must begin with a lowercase letter; alias + worker name + dash ≤ 63 characters (DNS label limit). Branches whose names exceed the limit get truncated with a 4-character hash suffix per Cloudflare's [Aug 2025 long-name update](https://developers.cloudflare.com/changelog/post/2025-08-08-support-long-branch-names-preview-aliases/). [`CONTRIBUTING.md`](../CONTRIBUTING.md) requires branch names of the form `<type>/<short-description>`, so every valid branch in this repo contains a `/` that Cloudflare must sanitize before the alias is valid; the exact transform is not part of this contract.
- **Preview URLs require [`preview_urls: true`](../wrangler.jsonc).** Wrangler 4.34+ defaults this off; without it, alias URLs return Cloudflare's "preview disabled" page even after a successful upload.
- **Previews bypass production.** A `wrangler versions upload` does not promote the version to the active deployment slot. Production at `tint.sh` continues serving the previous deploy until master receives a push and `wrangler deploy` runs.
- **Production-only behaviors auto-exclude previews.** The same `url.hostname === 'tint.sh'` gate appears on every behavior whose externally-observable side effect should fire on the canonical surface only — Plausible client pageviews, server `tint_download` events, the `/tint` → GitHub redirect, and the absence of `X-Robots-Tag`. Preview hostnames don't match any of those gates, so previews can't pollute the Plausible dashboard, can't inflate GitHub's `download_count`, and can't be indexed by search engines as duplicate content. This is the same gate that excludes `astro dev` from analytics. See § Routing for the per-gate detail and the smoke-test enforcement.
- **Limit.** Cloudflare retains the 1000 most-recently-deployed aliases per Worker. We have one alias per open + recently-merged PR; the cap is unreachable in practice. Closed-PR aliases stay accessible until evicted, which is a feature (revisiting an old PR's preview is free).
- **Custom-domain previews are not supported.** **(Cloudflare beta limitation.)** Previews live only on `*.workers.dev`. There is no `pr-N.preview.tint.sh` today.

## Smoke test as executable spec

The smoke suite is invoked by `npm run smoke` (which runs as the last step of `npm run check`). These files are the on-disk contract for the invariants this document declares — every invariant marked "enforced by …" above has an assertion in one of them. Adding a new invariant means adding an assertion; removing one removes a guarantee.

The split is by the kind of evidence each file consults:

- [`scripts/smoke-copy-buttons.ts`](../scripts/smoke-copy-buttons.ts) — **behavioral tests on the shared copy controller**.
- [`scripts/smoke-demo-videos.ts`](../scripts/smoke-demo-videos.ts) — **behavioral tests on the demo-video controller** (mocks browser layout, RAF, media queries, visibility, and video playback).
- [`scripts/smoke-dist.ts`](../scripts/smoke-dist.ts) — **static analysis on the build output and config files** (`dist/` + `wrangler.jsonc`).
- [`scripts/smoke-worker.ts`](../scripts/smoke-worker.ts) — **behavioral tests on the Worker code** (imports `worker/index.ts`, mocks `globalThis.fetch`, `env.ASSETS`, and `ctx.waitUntil`, and exercises the Worker against canonical and preview hostnames).

Together they cover the full surface — the Worker's runtime behavior cannot be verified statically without false-passing refactors that move a gate into a dead branch (Copilot caught exactly this on an earlier regex-only version), the video player's scroll/focus state machine cannot be verified with bundled-string checks, and the static build output cannot be verified by behavior tests.

### `smoke-demo-videos.ts` — behavioral tests against `src/scripts/demo-videos.ts`

The harness imports the same `wireDemoVideos()` function the homepage runs, then supplies fake `document`, `window`, `requestAnimationFrame`, `matchMedia`, `IntersectionObserver`, and `<video>` objects. It tests the UI contract as state transitions:

- Initial viewport focus upgrades frames only after JS wiring, selects the most in-focus video, promotes only that video to `preload="auto"`, and plays exactly one video.
- Activating the currently-playing video pauses globally; every frame gets the play overlay state and accessible "Play" label.
- Keyboard activation mirrors click activation and prevents Space from scrolling the page.
- Activating another frame while paused resumes globally without switching away from the active/focused video.
- Activating an inactive frame while playback is running intentionally selects that video as the manual active video.
- Scrolling clears the manual override and returns ownership to the viewport-focused video.
- Reduced-motion preference starts paused, remains user-overridable, and later preference changes pause globally.
- Legacy media-query listeners are installed if old WebKit rejects the modern listener API.
- Poster shims release only after the active video has painted for two RAFs; stale releases cannot mark an inactive frame ready.
- `document.visibilityState === 'hidden'` pauses, resets, clears active state, and restores poster shims.

### `smoke-dist.ts` — static checks against `dist/` and `wrangler.jsonc`

**Install tabs** (`checkInstallTabs`)

- Renders exactly seven `data-copy` buttons inside the install `.command-tabs` fieldset: brew, curl, and the five source-checkout sub-tabs (https, ssh, gh, gt, jj).
- The `gt` sub-tab does not use `gt clone`; Graphite has no documented clone wrapper, so it runs `git clone`, `cd tint`, then `gt init --trunk master`.
- Each button's `aria-label` equals `Copy ${data-code}` (after HTML-entity decoding).
- At least one button's `data-code` references `https://tint.sh/tint` (install-URL drift guard).
- Page-wide copy wiring (`checkCopyButtons`) verifies a single bundled script ships the literal `[data-copy]` selector — applies to every CopyCommand, including the install tabs.

**Analytics** (`checkPlausibleSnippet`, every HTML page)

- An inline `<script>` body contains all three of: bundle URL stem `plausible.io/js/pa-`, `plausible.init()` call, `location.hostname === 'tint.sh'` gate.
- All three must be in the _same_ script — splitting requirements across scripts is a documented false-pass mode and rejected explicitly.

**Accessibility** (`checkVideoElements`, `checkIconOnlyLinks`, `checkLabelControlWiring`)

- Every `<video>` carries a non-empty `aria-label`. `<video autoplay>` also carries `muted` and `playsinline` (autoplay policies block silently otherwise).
- Every `<a>` whose only child is `<svg>` carries `aria-label` or `aria-labelledby` (WCAG 2.4.4).
- Every `<label for="x">` matches an element with `id="x"` on the same page (the install widget tabs depend on this wiring; a typo silently kills tab switching).

**Asset existence** (`checkFaviconLinks`, `checkNonEmptyFile`)

- Every `<link rel="icon">` href resolves to an existing non-empty file in `dist/`.
- Every homepage video `src` and `poster` resolves to an existing non-empty root-local file in `dist/`.
- Legacy GIF demo assets, `robots.txt`, and `sitemap-index.xml` exist and are non-empty.

**Path correctness**

- Homepage `<video>` src/poster/fallback paths are relative root-local filenames: no leading slash, scheme, subdirectory, or dot segment.

**Route shadowing guards** (`checkAbsent`, ENOENT-only success)

- `dist/tint` does not exist (would shadow the Worker's `/tint` redirect via the assets binding).
- `dist/CNAME` does not exist (GitHub-Pages-specific artifact; this site deploys to Workers).

**Wrangler config invariants** (`checkWranglerConfig`, parses `wrangler.jsonc` via `jsonc-parser`)

- Top-level `build.command === "npm run check"` (deploy gate stays in sync with [`ci.yml`](../.github/workflows/ci.yml) via [`package.json`](../package.json)).
- Top-level `preview_urls === true` (without it, preview hostnames return Cloudflare's "preview disabled" page after the next deploy).
- Both assertions address structural property paths (not raw-text regex), so a literal in a comment or a same-named nested entry cannot false-pass.

### `smoke-worker.ts` — behavioral tests against `worker/index.ts`

Each contract verifies the **complete causal chain**, not just end-state — `assetCalls`, `waitUntilCalls`, and outbound `fetchCalls` are captured per-invocation, and a regression that produces the same end state via a different (incorrect) mechanism (e.g. a hand-written 404 instead of a fall-through to `env.ASSETS.fetch`) fails with a pinpoint message.

**Canonical `/tint` contract** (`assertCanonicalTintContract`)

- Every variant (path: `/tint`, `/tint/`; method: GET, HEAD; with and without query string) returns `302 → RELEASE_URL`.
- ASSETS is not invoked.
- GET fires `ctx.waitUntil` exactly once, which fires exactly one outbound POST to `https://plausible.io/api/event` with `Content-Type: application/json` and a payload containing `name`, `url`, `domain`, `props.country`.
- HEAD does NOT fire `trackDownload` (HTTP semantics: link checkers, monitoring probes, social preview crawlers all use HEAD without fetching the binary).
- Query strings are dropped from the Location header (the redirect target is fixed; `?utm_source=…` doesn't reach GitHub but also doesn't 404).
- Inbound headers (`user-agent`, `cf-connecting-ip`, `cf-ipcountry`) forward intact onto the outbound POST as `User-Agent`, `X-Forwarded-For`, and `payload.props.country`. With no inbound headers, every axis falls back to its documented default (`'curl'`, `''`, `'unknown'`). Each axis is asserted independently — a remap regression on any one surfaces as a specific assertion failure naming the axis.

**Preview `/tint` contract** (`assertPreviewTintContract`)

- Every variant returns `404`, `Location` unset, `trackDownload` not fired, no outbound POST.
- ASSETS is invoked exactly once with the original request URL and method (verifies the documented "fall through to env.ASSETS.fetch" behavior actually happens — a hand-written 404 short-circuit would change the response body and bypass the asset binding).

**X-Robots-Tag contract** (asset responses across multiple content types)

- Preview hostnames: every asset response (HTML, XML, plain text) carries `X-Robots-Tag: noindex, nofollow`. ASSETS is invoked exactly once.
- Canonical host: the header is never set on any asset response. ASSETS is invoked exactly once.

**Method gate**

- Every non-GET/HEAD method on every host returns `405` with `Allow: GET, HEAD`.
- ASSETS is NOT invoked (don't pay origin cost on disallowed methods); `trackDownload` is NOT fired.

**Subpath fallthrough**

- `/tint/foo` falls through to ASSETS exactly once with the original URL (the worker handles `/tint` and `/tint/` only, not arbitrary subpaths).

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
