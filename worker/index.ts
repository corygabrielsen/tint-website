// Cloudflare Worker entrypoint for tint.sh.
//
// Default behavior: fall through to static assets (the Astro build in
// dist/, served via the Workers Static Assets binding). This makes the
// Worker functionally equivalent to plain static hosting for every
// request that isn't intercepted below.
//
// Special-cased path: /tint serves as a short-URL alias for the tint
// release binary on GitHub. We handle it here, instead of placing a
// static file at dist/tint, for three reasons:
//
//   1. `curl -fsSL https://tint.sh/tint -o ~/.local/bin/tint` follows
//      the 302 to GitHub's release CDN and writes the bytes locally.
//      Users get a short, brand-aligned install URL without us hosting
//      the binary in the website asset bundle.
//
//   2. The redirect target is `releases/latest/download/tint`, which
//      GitHub itself 302s to the active release. That second hop is
//      what increments per-asset `download_count` on the release —
//      preserving GitHub's native install analytics for free.
//
//   3. We log a `tint_download` event to Plausible on each request, so
//      the dashboard shows downloads-over-time alongside pageviews
//      without us snapshotting GitHub's cumulative counter on a cron.

const RELEASE_URL = 'https://github.com/corygabrielsen/tint/releases/latest/download/tint';
const PLAUSIBLE_DOMAIN = 'tint.sh';
const PLAUSIBLE_EVENT_URL = 'https://plausible.io/api/event';

// Minimal local types for the Workers runtime. We intentionally avoid
// pulling in `@cloudflare/workers-types` so the Worker entrypoint stays
// dependency-light; structural typing makes these compatible with the
// real runtime types Wrangler validates against at deploy.
interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
}

// Forward the original UA, IP, and Cloudflare-derived country to
// Plausible's Events API so the dashboard's standard breakdowns
// (browser, OS, country, unique visitors) work for server-side events
// the same way they do for the client-side pageview script.
async function trackDownload(request: Request): Promise<void> {
  try {
    await fetch(PLAUSIBLE_EVENT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': request.headers.get('user-agent') ?? 'curl',
        'X-Forwarded-For': request.headers.get('cf-connecting-ip') ?? '',
      },
      body: JSON.stringify({
        name: 'tint_download',
        url: `https://${PLAUSIBLE_DOMAIN}/tint`,
        domain: PLAUSIBLE_DOMAIN,
        props: { country: request.headers.get('cf-ipcountry') ?? 'unknown' },
      }),
    });
  } catch {
    // Swallow analytics failures — a Plausible outage or rate-limit
    // must not deny users their download. The redirect already
    // returned by the time we reach this catch (waitUntil runs after
    // the response), so there's nothing user-facing to do here.
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Match `/tint` and `/tint/` so a stray trailing slash from a copy-
    // paste mid-line still resolves to the binary. We don't preserve
    // query strings or extend to `/tint/*` because the only documented
    // endpoint is the canonical short URL.
    if (url.pathname === '/tint' || url.pathname === '/tint/') {
      // ctx.waitUntil keeps the Worker invocation alive until the
      // Plausible POST settles. Without it the runtime may cancel the
      // in-flight fetch as soon as we return the redirect, dropping
      // events under load and leaving the dashboard quietly under-
      // counting.
      ctx.waitUntil(trackDownload(request));
      return Response.redirect(RELEASE_URL, 302);
    }

    return env.ASSETS.fetch(request);
  },
};
