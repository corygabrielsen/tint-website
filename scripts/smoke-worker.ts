// Behavior tests for worker/index.ts.
//
// scripts/smoke-dist.ts validates the static build output. This file
// validates the Worker's runtime behavior by importing it directly
// and exercising it against canonical and preview hostnames. The
// invariants this enforces — per-surface gates on /tint and on
// X-Robots-Tag — cannot be checked statically without false-passing
// refactors that move the gate into a dead branch (Copilot caught
// exactly this on an earlier regex-based version).
//
// We mock:
//   - global fetch: to intercept the trackDownload POST so the test
//     never actually hits plausible.io
//   - env.ASSETS: to model the asset binding's behavior (404 for
//     /tint since no static file exists; 200 with HTML for other
//     paths)
//   - ctx: to capture waitUntil promises so we can assert them

import workerModule from '../worker/index.ts';

const errors: string[] = [];

function check(condition: boolean, message: string): void {
  if (!condition) {
    errors.push(message);
  }
}

interface FetchCall {
  url: string;
  method: string;
  contentType: string | null;
  body: string;
}
const fetchCalls: FetchCall[] = [];

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : (input as Request).url;
  const method =
    init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET');
  // Headers in RequestInit can be a Headers object, a plain
  // record, or an array of tuples — wrap in `new Headers(...)`
  // for uniform access regardless of which shape the caller used.
  const headers = new Headers(init?.headers ?? {});
  const contentType = headers.get('content-type');
  const body = typeof init?.body === 'string' ? init.body : '';
  fetchCalls.push({ url, method, contentType, body });
  return new Response('mocked', { status: 202 });
}) as typeof fetch;

interface AssetCall {
  url: string;
  method: string;
}
const assetCalls: AssetCall[] = [];

const env = {
  ASSETS: {
    fetch: async (request: Request) => {
      assetCalls.push({ url: request.url, method: request.method });
      const url = new URL(request.url);
      // Simulate dist/: any /tint path 404s (no static file; the
      // smoke-dist `checkAbsent('tint')` enforces this in dist).
      // Other paths return a minimal HTML page.
      if (url.pathname === '/tint' || url.pathname.startsWith('/tint/')) {
        return new Response('not found', { status: 404 });
      }
      return new Response('<!doctype html><html><head></head><body>asset</body></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      });
    },
  },
};

const waitUntilCalls: Promise<unknown>[] = [];
const ctx = {
  waitUntil(promise: Promise<unknown>): void {
    waitUntilCalls.push(promise);
  },
};

async function call(method: string, url: string): Promise<Response> {
  // Reset capture buffers so each call's effects are observable in isolation.
  fetchCalls.length = 0;
  assetCalls.length = 0;
  waitUntilCalls.length = 0;
  return workerModule.fetch(new Request(url, { method }), env, ctx);
}

// Canonical-host /tint: GET returns 302 to the GitHub release URL,
// fires the Plausible event via waitUntil, and skips ASSETS entirely.
{
  const response = await call('GET', 'https://tint.sh/tint');
  check(response.status === 302, `GET tint.sh/tint: status ${response.status}, want 302`);
  check(
    response.headers.get('location') ===
      'https://github.com/corygabrielsen/tint/releases/latest/download/tint',
    `GET tint.sh/tint: location header ${response.headers.get('location')}`,
  );
  check(
    assetCalls.length === 0,
    `GET tint.sh/tint: should not invoke ASSETS, did ${assetCalls.length}x`,
  );
  check(
    waitUntilCalls.length === 1,
    `GET tint.sh/tint: should fire one waitUntil (trackDownload), fired ${waitUntilCalls.length}`,
  );
  // Drain the waitUntil so the mocked fetch records the Plausible POST.
  await Promise.all(waitUntilCalls);

  // Plausible's /api/event contract has multiple required parts;
  // each is asserted separately so a partial regression names the
  // exact field that broke.
  check(
    fetchCalls.length === 1,
    `GET tint.sh/tint: trackDownload should fire exactly one outbound fetch, got ${fetchCalls.length}`,
  );
  const plausibleCall = fetchCalls[0];
  if (plausibleCall) {
    check(
      plausibleCall.method === 'POST',
      `trackDownload: method must be POST (Plausible /api/event requires POST), got ${plausibleCall.method}`,
    );
    check(
      plausibleCall.url === 'https://plausible.io/api/event',
      `trackDownload: URL must be https://plausible.io/api/event, got ${plausibleCall.url}`,
    );
    check(
      plausibleCall.contentType === 'application/json',
      `trackDownload: Content-Type must be application/json, got ${JSON.stringify(plausibleCall.contentType)}`,
    );
    let payload: { name?: string; url?: string; domain?: string; props?: Record<string, unknown> } =
      {};
    try {
      payload = JSON.parse(plausibleCall.body);
    } catch (error) {
      check(false, `trackDownload: body must be valid JSON: ${(error as Error).message}`);
    }
    check(
      payload.name === 'tint_download',
      `trackDownload: payload.name must be 'tint_download' (event name visible in Plausible dashboard), got ${JSON.stringify(payload.name)}`,
    );
    check(
      payload.url === 'https://tint.sh/tint',
      `trackDownload: payload.url must be 'https://tint.sh/tint' (the canonical-host URL where the event happened), got ${JSON.stringify(payload.url)}`,
    );
    check(
      payload.domain === 'tint.sh',
      `trackDownload: payload.domain must be 'tint.sh' (the Plausible dashboard identifier), got ${JSON.stringify(payload.domain)}`,
    );
    check(
      typeof payload.props === 'object' && payload.props !== null && 'country' in payload.props,
      `trackDownload: payload.props.country must be present (Plausible's country breakdown depends on it), got ${JSON.stringify(payload.props)}`,
    );
  }
}

// Canonical-host /tint with trailing slash: same redirect, forgive copy-paste.
{
  const response = await call('GET', 'https://tint.sh/tint/');
  check(response.status === 302, `GET tint.sh/tint/: status ${response.status}, want 302`);
}

// Canonical-host HEAD /tint: redirect must still fire (HTTP semantics)
// but no Plausible event — HEAD doesn't represent a download.
{
  const response = await call('HEAD', 'https://tint.sh/tint');
  check(response.status === 302, `HEAD tint.sh/tint: status ${response.status}, want 302`);
  check(
    waitUntilCalls.length === 0,
    `HEAD tint.sh/tint: should NOT fire trackDownload, fired ${waitUntilCalls.length}`,
  );
}

// Preview-host /tint: must NOT redirect to GitHub. Falls through to
// ASSETS, which 404s. This is the gate Copilot flagged in round 4 —
// without it, preview traffic inflates GitHub's download_count.
{
  const response = await call('GET', 'https://feat-foo-tint-website.example.workers.dev/tint');
  check(
    response.status === 404,
    `GET preview/tint: status ${response.status}, want 404 (preview hosts must not redirect)`,
  );
  check(
    response.headers.get('location') === null,
    `GET preview/tint: must not have location header, got ${response.headers.get('location')}`,
  );
  check(
    waitUntilCalls.length === 0,
    `GET preview/tint: must not fire trackDownload, fired ${waitUntilCalls.length}`,
  );
  check(
    fetchCalls.length === 0,
    `GET preview/tint: must not POST to Plausible, posted ${fetchCalls.length}x`,
  );
}

// Preview-host asset: returns ASSETS response with X-Robots-Tag
// noindex header appended. Copilot flagged this in round 4 — without
// the header, search engines could index preview URLs as duplicate
// content of tint.sh.
{
  const response = await call('GET', 'https://feat-foo-tint-website.example.workers.dev/');
  check(response.status === 200, `GET preview/: status ${response.status}, want 200`);
  const robotsHeader = response.headers.get('x-robots-tag');
  check(
    robotsHeader === 'noindex, nofollow',
    `GET preview/: X-Robots-Tag should be 'noindex, nofollow', got ${JSON.stringify(robotsHeader)}`,
  );
}

// Canonical-host asset: returns ASSETS response WITHOUT X-Robots-Tag.
// The header must not bleed onto production — it would deindex tint.sh.
{
  const response = await call('GET', 'https://tint.sh/');
  check(response.status === 200, `GET tint.sh/: status ${response.status}, want 200`);
  check(
    response.headers.get('x-robots-tag') === null,
    `GET tint.sh/: X-Robots-Tag must NOT be set on canonical host, got ${response.headers.get('x-robots-tag')}`,
  );
}

// Site-wide method gate: non-GET/HEAD returns 405 with Allow header.
// Same on every host (no per-host carve-out).
for (const host of ['tint.sh', 'feat-foo-tint-website.example.workers.dev']) {
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const response = await call(method, `https://${host}/`);
    check(response.status === 405, `${method} ${host}/: status ${response.status}, want 405`);
    check(
      response.headers.get('allow') === 'GET, HEAD',
      `${method} ${host}/: Allow header should be 'GET, HEAD', got ${response.headers.get('allow')}`,
    );
  }
}

// Subpaths under /tint fall through to ASSETS on canonical too — the
// route handles only exactly /tint and /tint/, not /tint/foo.
{
  const response = await call('GET', 'https://tint.sh/tint/foo');
  check(
    response.status === 404,
    `GET tint.sh/tint/foo: subpath should fall through to ASSETS (404), got ${response.status}`,
  );
  check(
    waitUntilCalls.length === 0,
    `GET tint.sh/tint/foo: must not fire trackDownload, fired ${waitUntilCalls.length}`,
  );
}

// Restore real fetch so we don't poison anything that runs after us
// in the same process.
globalThis.fetch = originalFetch;

if (errors.length > 0) {
  console.error('worker smoke test failed:');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log('worker smoke test passed');
