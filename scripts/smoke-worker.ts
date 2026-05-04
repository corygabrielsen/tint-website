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

const RELEASE_URL = 'https://github.com/corygabrielsen/tint/releases/latest/download/tint';

// Full canonical-/tint contract. Every canonical-host /tint
// variant (different path, different method, with-or-without
// query string) must satisfy ALL of these — extracted into a
// single helper so future variants can't accidentally assert only
// part of the contract (which is exactly the regression class
// that flagged this in review).
//
// On GET: redirect target must be the bare RELEASE_URL, ASSETS
// must not be touched, trackDownload must fire exactly once, and
// the outbound fetch must be a well-formed Plausible POST.
//
// On HEAD: same redirect (HTTP semantics) but trackDownload must
// NOT fire (HEAD doesn't represent a download — link checkers,
// social preview crawlers, monitoring probes all use HEAD).
//
// `expectQueryDropped` lets variants opt into the additional
// "query string was dropped from Location" assertion. The worker
// strips the query when constructing the redirect target;
// passing through `?utm_source=…` would split utm-tracking from
// the Plausible event domain.
async function assertCanonicalTintContract(
  method: 'GET' | 'HEAD',
  url: string,
  expectQueryDropped = false,
): Promise<void> {
  const label = `${method} ${url}`;
  const response = await call(method, url);
  check(response.status === 302, `${label}: status ${response.status}, want 302`);
  check(
    response.headers.get('location') === RELEASE_URL,
    `${label}: location header should be ${RELEASE_URL}, got ${response.headers.get('location')}${
      expectQueryDropped ? ' (query string must be dropped from Location)' : ''
    }`,
  );
  check(assetCalls.length === 0, `${label}: should not invoke ASSETS, did ${assetCalls.length}x`);
  if (method === 'GET') {
    check(
      waitUntilCalls.length === 1,
      `${label}: should fire exactly one waitUntil (trackDownload), fired ${waitUntilCalls.length}`,
    );
    await Promise.all(waitUntilCalls);
    check(
      fetchCalls.length === 1,
      `${label}: trackDownload should fire exactly one outbound fetch, got ${fetchCalls.length}`,
    );
    const plausibleCall = fetchCalls[0];
    if (plausibleCall) {
      check(
        plausibleCall.method === 'POST',
        `${label} → trackDownload: method must be POST (Plausible /api/event requires POST), got ${plausibleCall.method}`,
      );
      check(
        plausibleCall.url === 'https://plausible.io/api/event',
        `${label} → trackDownload: URL must be https://plausible.io/api/event, got ${plausibleCall.url}`,
      );
      check(
        plausibleCall.contentType === 'application/json',
        `${label} → trackDownload: Content-Type must be application/json, got ${JSON.stringify(plausibleCall.contentType)}`,
      );
      let payload: {
        name?: string;
        url?: string;
        domain?: string;
        props?: Record<string, unknown>;
      } = {};
      try {
        payload = JSON.parse(plausibleCall.body);
      } catch (error) {
        check(
          false,
          `${label} → trackDownload: body must be valid JSON: ${(error as Error).message}`,
        );
      }
      check(
        payload.name === 'tint_download',
        `${label} → trackDownload: payload.name must be 'tint_download', got ${JSON.stringify(payload.name)}`,
      );
      check(
        payload.url === 'https://tint.sh/tint',
        `${label} → trackDownload: payload.url must be 'https://tint.sh/tint', got ${JSON.stringify(payload.url)}`,
      );
      check(
        payload.domain === 'tint.sh',
        `${label} → trackDownload: payload.domain must be 'tint.sh', got ${JSON.stringify(payload.domain)}`,
      );
      check(
        typeof payload.props === 'object' && payload.props !== null && 'country' in payload.props,
        `${label} → trackDownload: payload.props.country must be present, got ${JSON.stringify(payload.props)}`,
      );
    }
  } else {
    check(
      waitUntilCalls.length === 0,
      `${label}: HEAD must NOT fire trackDownload, fired ${waitUntilCalls.length}`,
    );
    check(
      fetchCalls.length === 0,
      `${label}: HEAD must NOT POST to Plausible, posted ${fetchCalls.length}x`,
    );
  }
}

// Full preview-/tint contract. Preview hostnames must never
// redirect from /tint — the request falls through to ASSETS
// (which 404s, since no static /tint file exists; smoke-dist's
// `checkAbsent('tint')` enforces that). No Plausible event must
// fire, because the canonical-host gate applies symmetrically
// (preview hosts don't match `hostname === 'tint.sh'`).
async function assertPreviewTintContract(method: 'GET' | 'HEAD', url: string): Promise<void> {
  const label = `${method} ${url}`;
  const response = await call(method, url);
  check(
    response.status === 404,
    `${label}: status ${response.status}, want 404 (preview hosts must not redirect)`,
  );
  check(
    response.headers.get('location') === null,
    `${label}: must not have a Location header, got ${response.headers.get('location')}`,
  );
  check(
    waitUntilCalls.length === 0,
    `${label}: must not fire trackDownload, fired ${waitUntilCalls.length}`,
  );
  check(
    fetchCalls.length === 0,
    `${label}: must not POST to Plausible, posted ${fetchCalls.length}x`,
  );
}

// Every canonical-/tint variant runs the full contract assertion.
// Adding a new variant (new method, new path shape, new query
// pattern) is a one-liner — and gets full coverage automatically.
await assertCanonicalTintContract('GET', 'https://tint.sh/tint');
await assertCanonicalTintContract('GET', 'https://tint.sh/tint/');
await assertCanonicalTintContract('HEAD', 'https://tint.sh/tint');
await assertCanonicalTintContract('HEAD', 'https://tint.sh/tint/');
// Query strings are accepted (no 404) and dropped (Location is
// the bare RELEASE_URL). Documented as a contract in
// worker/index.ts because social-share / utm-tracking parameters
// would otherwise 404 on real-world inbound links.
await assertCanonicalTintContract(
  'GET',
  'https://tint.sh/tint?utm_source=share&ref=foo',
  /* expectQueryDropped */ true,
);

// Every preview-/tint variant runs the full preview contract. The
// canonical side handles BOTH /tint and /tint/, so the preview
// gate must apply equally to both — otherwise a regression that
// keeps the gate on /tint but forgets /tint/ would re-expose
// preview traffic to GitHub's download counter via the
// trailing-slash variant.
const previewBase = 'https://feat-foo-tint-website.example.workers.dev';
await assertPreviewTintContract('GET', `${previewBase}/tint`);
await assertPreviewTintContract('GET', `${previewBase}/tint/`);
await assertPreviewTintContract('HEAD', `${previewBase}/tint`);
await assertPreviewTintContract('HEAD', `${previewBase}/tint/`);

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
