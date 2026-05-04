// Cloudflare Worker entrypoint for tint.sh.
//
// Routes:
//   /tint, /tint/   302 → GitHub release asset (URL below).
//                   The redirect target is `releases/latest/download/`,
//                   which GitHub itself 302s to the active asset; that
//                   second hop is what increments `download_count`.
//   *               env.ASSETS.fetch — the Astro build in dist/.
//
// Plausible receives a `tint_download` event on /tint hits; pageview
// events come from the client snippet in src/layouts/Layout.astro.

const RELEASE_URL = 'https://github.com/corygabrielsen/tint/releases/latest/download/tint';
const PLAUSIBLE_DOMAIN = 'tint.sh';
const PLAUSIBLE_EVENT_URL = 'https://plausible.io/api/event';

// Minimal Workers runtime types — declared inline to avoid pulling in
// `@cloudflare/workers-types`. Structural typing keeps these compatible
// with the real types Wrangler validates against at deploy.
interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
}

// Forward UA, client IP, and CF-derived country so Plausible's standard
// browser / OS / country / unique-visitor breakdowns work for these
// server-side events the same way they do for the client snippet.
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
    // Analytics failures must not deny users their download. The
    // redirect has already returned by the time we reach this catch
    // (waitUntil runs after the response), so nothing user-facing to do.
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Site-wide method gate: GET/HEAD only. The Worker serves static
    // assets and a single GET-shaped redirect; non-read methods have no
    // semantics on tint.sh. Enforced here (not per-handler) so future
    // routes are safe by default and scanners hit 405 before any
    // analytics or origin work runs.
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', {
        status: 405,
        headers: { Allow: 'GET, HEAD' },
      });
    }

    const url = new URL(request.url);

    // Match `/tint` and `/tint/` (forgive a trailing slash). Query
    // strings and `/tint/*` are intentionally not handled — only the
    // canonical short URL is documented.
    if (url.pathname === '/tint' || url.pathname === '/tint/') {
      // Hostname gate: only `tint.sh` traffic counts. The redirect still
      // works on *.workers.dev / preview hosts so the handler can be
      // exercised end-to-end, but Plausible only sees production hits.
      // Symmetric client-side gate lives in src/layouts/Layout.astro.
      if (url.hostname === PLAUSIBLE_DOMAIN) {
        // waitUntil keeps the invocation alive until the POST settles;
        // otherwise the runtime cancels the in-flight fetch as soon as
        // the redirect returns, undercounting events under load.
        ctx.waitUntil(trackDownload(request));
      }
      return Response.redirect(RELEASE_URL, 302);
    }

    return env.ASSETS.fetch(request);
  },
};
