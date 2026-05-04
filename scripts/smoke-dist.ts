import { readFile, stat } from 'node:fs/promises';

const dist = new URL('../dist/', import.meta.url);
const errors: string[] = [];

function check(condition: boolean, message: string): void {
  if (!condition) {
    errors.push(message);
  }
}

// Distinguish "file is missing" (the common, expected build-regression
// cause) from "we couldn't tell whether it's missing" (EACCES, EIO,
// EMFILE, ENOTDIR, ...). Mistaking the latter for the former wastes
// debugging time chasing a phantom build problem when the real cause is
// the filesystem itself.
function describeFsFailure(action: string, path: string, error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') return `missing ${path}`;
  return `failed to ${action} ${path} (${code ?? 'unknown'}): ${(error as Error).message}`;
}

async function readDistFile(path: string): Promise<string> {
  try {
    return await readFile(new URL(path, dist), 'utf8');
  } catch (error) {
    errors.push(describeFsFailure('read', path, error));
    return '';
  }
}

async function checkNonEmptyFile(path: string): Promise<void> {
  try {
    const file = await stat(new URL(path, dist));
    check(file.isFile(), `${path} is not a file`);
    check(file.size > 0, `${path} is empty`);
  } catch (error) {
    errors.push(describeFsFailure('stat', path, error));
  }
}

// Asserts a path is NOT present in dist/. Use to guard against build-
// time regressions that would shadow Worker routes or other handled
// paths (worker/index.ts handles `/tint` in code, so a file at
// dist/tint would silently take precedence and break the redirect).
//
// Only ENOENT counts as success. Any other error (EACCES, EIO, etc.)
// means the smoke test couldn't determine whether the shadowing file
// exists — surface it loudly rather than passing on the assumption.
async function checkAbsent(path: string): Promise<void> {
  try {
    await stat(new URL(path, dist));
    errors.push(`${path} must not exist in dist/ — would shadow a Worker route`);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      errors.push(
        `checkAbsent(${path}) failed unexpectedly (${code ?? 'unknown'}): ${(error as Error).message}`,
      );
    }
  }
}

function extractVideoSrc(html: string): string | undefined {
  const match = html.match(/<video\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function getAttr(tag: string, name: string): string | undefined {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`));
  return match?.[1];
}

// Every <link rel="icon" href="…"> on the page must point at a file that
// actually exists in dist/. Astro doesn't validate referenced public/
// assets, so deleting or renaming a favicon ships a build that loads but
// 404s on the icon request — invisible in CI, visible in every browser
// tab. We extract the href from the rendered HTML (instead of hard-coding
// 'favicon.svg') so the check follows whatever the page actually
// references.
async function checkFaviconLinks(html: string, sourcePath: string): Promise<void> {
  const links = [...html.matchAll(/<link\b[^>]*\brel\s*=\s*"icon"[^>]*>/g)].map((m) => m[0]);
  check(links.length > 0, `${sourcePath}: no <link rel="icon"> tag found`);
  for (const tag of links) {
    const href = getAttr(tag, 'href');
    check(Boolean(href), `${sourcePath}: <link rel="icon"> missing href`);
    if (href) {
      // Root-relative under tint.sh (no base path); strip the leading slash
      // to address dist/. Reject schemes and protocol-relative URLs because
      // a remote favicon would defeat the existence check entirely.
      check(
        href.startsWith('/') && !href.startsWith('//'),
        `${sourcePath}: favicon href must be root-relative, got "${href}"`,
      );
      if (href.startsWith('/') && !href.startsWith('//')) {
        await checkNonEmptyFile(href.slice(1));
      }
    }
  }
}

// Sweep every <video> on the page. Two invariants apply:
//
// - Any video with `autoplay` must also carry `muted` (every modern
//   browser's autoplay policy blocks autoplay without it) and
//   `playsinline` (iOS Safari otherwise goes fullscreen on tap).
//   Removing either silently breaks autoplay while still rendering a
//   poster frame, so the page looks fine in CI but is broken for users.
//   We gate this on `autoplay` so a non-autoplay video added later
//   (background explainer, FAQ clip, etc.) doesn't trip the check.
// - Every video, autoplay or not, needs a non-empty `aria-label` so
//   screen readers have something to announce.
//
// At least one video must exist (the demo); we don't pin the count
// because adding a second video shouldn't require a smoke change.
function checkVideoElements(html: string): void {
  const tags = [...html.matchAll(/<video\b[^>]*>/g)].map((m) => m[0]);
  check(tags.length > 0, 'homepage is missing a <video> element');
  for (const tag of tags) {
    if (/\bautoplay\b/.test(tag)) {
      for (const attr of ['muted', 'playsinline']) {
        check(
          new RegExp(`\\b${attr}\\b`).test(tag),
          `<video autoplay> missing required ${attr} attribute (autoplay won't trigger without it): ${tag}`,
        );
      }
    }
    const ariaLabel = getAttr(tag, 'aria-label');
    check(Boolean(ariaLabel), `<video> missing or empty aria-label (a11y regression): ${tag}`);
  }
}

// Links whose only visible content is an <svg> need an accessible name —
// otherwise screen readers announce them with no name at all (or just
// "link"), and they fail WCAG 2.4.4. The general form: any anchor whose
// child set is just an <svg> (with optional whitespace) must carry
// aria-label or aria-labelledby. We sweep the full document so any future
// icon-only link is covered automatically.
function checkIconOnlyLinks(html: string): void {
  const matches = [...html.matchAll(/<a\b([^>]*)>\s*<svg\b[\s\S]*?<\/svg>\s*<\/a>/g)];
  for (const [, attrs] of matches) {
    const synthetic = `<a${attrs}>`;
    const hasName = Boolean(
      getAttr(synthetic, 'aria-label') || getAttr(synthetic, 'aria-labelledby'),
    );
    check(hasName, `icon-only <a> missing aria-label or aria-labelledby:${attrs}`);
  }
}

// Every <label for="x"> must point at an element with id="x" somewhere on
// the same page; otherwise clicking the label is a no-op. The install
// widget's tab switching depends entirely on this wiring (the visible
// tabs are <label>s that toggle hidden radio <input>s), so a typo or
// rename in one place silently kills the tabs even though the page
// renders. Generalised across the document so any future label/control
// pair is covered.
function checkLabelControlWiring(html: string): void {
  const ids = new Set(
    [...html.matchAll(/\bid\s*=\s*"([^"]+)"/g)]
      .map((m) => m[1])
      .filter((v): v is string => Boolean(v)),
  );
  const fors = [...html.matchAll(/<label\b[^>]*\bfor\s*=\s*"([^"]+)"/g)]
    .map((m) => m[1])
    .filter((v): v is string => Boolean(v));
  for (const target of fors) {
    check(ids.has(target), `<label for="${target}"> has no matching element with id="${target}"`);
  }
}

// Extract the rendered install-widget fieldset from the page so per-feature
// assertions don't accidentally couple to the rest of the document. Without
// this, a `data-copy` button added anywhere else on the homepage (e.g. a
// future "copy share link" button) would break a check that's only meant
// to protect the install widget. The fieldset is non-nesting in our markup,
// so a non-greedy match through `</fieldset>` is safe.
function extractInstallWidget(html: string): string | undefined {
  const match = html.match(
    /<fieldset\b[^>]*\bclass\s*=\s*"[^"]*\binstall-widget\b[^"]*"[\s\S]*?<\/fieldset>/,
  );
  return match?.[0];
}

// Structural assertions for the install widget. These catch the regression
// classes the click handler is most exposed to: missing/wrong data-code,
// aria-label drift, and — most importantly — the inlined <script> losing
// the `.install-widget [data-copy]` selector that wires the handler to
// the rendered buttons. Without this last check, a selector or bundling
// regression would ship silently because nothing exercises the handler
// at runtime in CI.
function checkInstallWidget(html: string): void {
  const widget = extractInstallWidget(html);
  check(Boolean(widget), 'install-widget fieldset not found in rendered HTML');
  if (!widget) return;
  // Scope the button query to the widget container — the data-copy
  // attribute is a generic copy-to-clipboard hook, so a future copy
  // button elsewhere on the page must not break this feature's check.
  const buttons = [...widget.matchAll(/<button\b[^>]*\bdata-copy\b[^>]*>/g)].map((m) => m[0]);
  check(
    buttons.length === 2,
    `expected 2 install-widget buttons (brew + curl), found ${buttons.length}`,
  );

  for (const [i, tag] of buttons.entries()) {
    const dataCode = getAttr(tag, 'data-code');
    const ariaLabel = getAttr(tag, 'aria-label');
    check(Boolean(dataCode), `install button ${i}: missing or empty data-code`);
    check(Boolean(ariaLabel), `install button ${i}: missing or empty aria-label`);
    if (dataCode && ariaLabel) {
      const decodedCode = decodeHtmlEntities(dataCode);
      const decodedLabel = decodeHtmlEntities(ariaLabel);
      check(
        decodedLabel === `Copy ${decodedCode}`,
        `install button ${i}: aria-label "${decodedLabel}" does not match "Copy ${decodedCode}"`,
      );
    }
  }

  // The curl install command must reference https://tint.sh/tint — the
  // short URL the Worker (worker/index.ts) handles. Reverting to the
  // raw github.com URL bloats the displayed command and bypasses the
  // Worker's `tint_download` event.
  const installUrls = buttons.map((tag) => decodeHtmlEntities(getAttr(tag, 'data-code') ?? ''));
  const hasShortInstallUrl = installUrls.some((code) => code.includes('https://tint.sh/tint'));
  check(
    hasShortInstallUrl,
    `no install button references https://tint.sh/tint — install URL drift (saw: ${installUrls.join(' | ')})`,
  );

  // Match the literal compound selector `.install-widget [data-copy]`,
  // not the two substrings independently. The previous looser check
  // (`.install-widget` + `data-copy` anywhere in the same script body)
  // false-passed when the substrings appeared in unrelated contexts —
  // e.g. a class rename to `.install` plus an unrelated `data-copy`
  // attribute elsewhere in the bundle would still satisfy it. The
  // bundler may collapse spaces around CSS combinators or rewrite the
  // selector via a single pass, so we accept any whitespace run between
  // the class and the attribute selector.
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? '');
  const wired = scripts.some((s) => /\.install-widget\s+\[data-copy\]/.test(s));
  check(
    wired,
    'no inlined <script> references the `.install-widget [data-copy]` selector — script bundling or selector drift',
  );
}

// Every page must include the Plausible snippet. The snippet is
// dynamically injected by an inline gate in Layout.astro, so we look
// for the bundle URL inside inline script bodies rather than a
// `<script src="…">` attribute.
//
// Three requirements must hold *within a single inline <script>*:
//   1. Bundle URL stem (loose match by `plausible.io/js/pa-` —
//      Plausible reissues the bundle under new hashes, and pinning
//      the full hash would make a remote rotation a CI failure).
//   2. `plausible.init()` is called so SPA pageview hooks are wired.
//   3. Hostname-gated on `tint.sh` — without this, *.workers.dev hits,
//      preview hostnames, and `astro dev` auto-fire production
//      pageviews at script load. Symmetric server-side gate in
//      worker/index.ts.
//
// All three must be satisfied by the *same* script, not by three
// different scripts each contributing one fragment. Splitting the
// requirements across three independent `scripts.some(...)` calls
// false-passes when the predicates happen to match unrelated scripts
// (a benign-looking page with three scripts each containing one of
// the strings would slip through). The `every` over a single
// candidate enforces the conjunction.
//
// Run per-page (not once per build) because the failure mode is
// "404.html lost the snippet during a layout refactor".
function checkPlausibleSnippet(html: string, sourcePath: string): void {
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? '');
  const requirements: Array<[name: string, pattern: RegExp]> = [
    ['Plausible bundle URL (plausible.io/js/pa-*)', /plausible\.io\/js\/pa-/],
    ['plausible.init() call', /plausible\.init\s*\(/],
    ["'tint.sh' hostname gate", /location\.hostname\s*===\s*['"]tint\.sh['"]/],
  ];

  if (scripts.some((s) => requirements.every(([, re]) => re.test(s)))) {
    return;
  }

  // No single script satisfied all three. Give the most actionable
  // diagnostic by distinguishing "missing entirely" from "scattered
  // across unrelated scripts" (the false-pass mode this check is
  // explicitly designed to catch).
  const missing = requirements.filter(([, re]) => !scripts.some((s) => re.test(s))).map(([n]) => n);
  if (missing.length === 0) {
    errors.push(
      `${sourcePath}: Plausible requirements satisfied across multiple scripts but no single inline <script> contains all three (bundle URL + plausible.init() + 'tint.sh' hostname gate must be in the same script)`,
    );
  } else {
    errors.push(
      `${sourcePath}: no inline <script> contains a complete Plausible snippet; missing in any script: ${missing.join(', ')}`,
    );
  }
}

// Static check on wrangler.jsonc: the two load-bearing entries
// that nothing else in the pipeline detects the loss of. See call
// site comment for the rationale.
//
// Approach: convert JSONC to JSON (strip block comments, strip
// line comments, strip trailing commas) and then parse, so the
// assertions can address structural property paths
// (`config.build?.command`, `config.preview_urls`) rather than
// raw-text regex. Property-path assertions guarantee the entry
// is at the top level — a future nested entry with the same
// literal value cannot false-pass them. The three regex strips
// together cover the JSONC relaxations wrangler accepts; we
// don't add a JSONC parser dep because the format we use is
// small and hand-written, and the strips are short and explicit.
async function checkWranglerConfig(): Promise<void> {
  let raw = '';
  try {
    raw = await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  } catch (error) {
    errors.push(describeFsFailure('read', 'wrangler.jsonc', error));
    return;
  }

  // Strip block comments, then line comments (line-comment regex
  // preserves `://` so URLs in strings don't get mangled — none
  // today but the file could grow a `route` entry), then trailing
  // commas before closing `}` or `]`.
  const json = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, (_, lead) => lead)
    .replace(/,(\s*[}\]])/g, '$1');

  let config: { build?: { command?: string }; preview_urls?: boolean };
  try {
    config = JSON.parse(json);
  } catch (error) {
    errors.push(
      `wrangler.jsonc: failed to parse after JSONC normalization: ${(error as Error).message} — if this is a valid JSONC construct we don't yet handle, extend the strip in scripts/smoke-dist.ts checkWranglerConfig`,
    );
    return;
  }

  // build.command must reference the canonical script. The chain
  // lives in package.json `check`; this property-path assertion
  // verifies the *top-level* build.command (not just any literal
  // appearance somewhere in the file).
  check(
    config.build?.command === 'npm run check',
    `wrangler.jsonc: top-level build.command must be exactly "npm run check" (got ${JSON.stringify(config.build?.command)}) — keeps the deploy gate in sync with .github/workflows/ci.yml via package.json`,
  );

  // preview_urls must be true at the top level so per-PR preview
  // hostnames actually serve the deployed Worker version. If
  // removed or set to false, the next deploy silently disables
  // previews; nothing else in the pipeline notices.
  check(
    config.preview_urls === true,
    `wrangler.jsonc: top-level "preview_urls" must be true (got ${JSON.stringify(config.preview_urls)}) — without it, preview hostnames return Cloudflare's "preview disabled" page after deploy`,
  );
}

const html = await readDistFile('index.html');
const notFoundHtml = await readDistFile('404.html');
const videoSrc = extractVideoSrc(html);

check(Boolean(videoSrc), 'homepage is missing a video src');

if (videoSrc) {
  check(!videoSrc.startsWith('/'), `video src must be relative, got ${videoSrc}`);
  check(!/^[a-z][a-z0-9+.-]*:/i.test(videoSrc), `video src must not be absolute, got ${videoSrc}`);

  // Pin the canonical filename. Combined with the relative-src checks
  // above, this guarantees the homepage video is served from /demo.mp4
  // on tint.sh — the path the asset binding actually serves.
  const customDomainUrl = new URL(videoSrc, 'https://tint.sh/');
  check(
    customDomainUrl.pathname === '/demo.mp4',
    `video src resolves incorrectly on tint.sh: ${customDomainUrl.href}`,
  );
}

checkInstallWidget(html);
checkVideoElements(html);
checkIconOnlyLinks(html);
checkLabelControlWiring(html);
checkPlausibleSnippet(html, 'index.html');
checkPlausibleSnippet(notFoundHtml, '404.html');
await checkFaviconLinks(html, 'index.html');
await checkFaviconLinks(notFoundHtml, '404.html');

await checkNonEmptyFile('demo.mp4');
await checkNonEmptyFile('demo.gif');
await checkNonEmptyFile('robots.txt');
await checkNonEmptyFile('sitemap-index.xml');

// Worker-route shadowing guard. A static file with the same name as a
// path `worker/index.ts` handles in code would be served by the assets
// binding and never reach the handler. Add an entry here for every
// future `/foo` route the Worker grows.
await checkAbsent('tint');

// Worker hostname-gate guards (the per-surface invariants that
// protect production-only side effects from firing on preview
// hostnames) are validated by behavior testing in
// scripts/smoke-worker.ts — `npm run smoke` runs that file
// immediately after this one. Static-source checks for these gates
// were tried and rejected: any regex tight enough to actually catch
// the "guard exists but doesn't gate" refactor was either fragile
// or required a real parser. Behavior tests have neither problem.

// Wrangler config invariants. wrangler.jsonc holds two pieces of
// load-bearing config that nothing else in the pipeline can detect
// the loss of:
//   - build.command runs the CI gate before any wrangler deploy /
//     versions upload. If it's emptied or changed away from the
//     canonical script, deploys race to production without the
//     gate. The chain itself lives behind `npm run check` so that
//     wrangler.jsonc and .github/workflows/ci.yml share one source
//     of truth — verifying the *reference* here is sufficient
//     because the chain definition is in package.json (covered by
//     standard JSON schema enforcement).
//   - preview_urls: true is what makes per-PR preview hostnames
//     actually serve the deployed Worker version. If it's removed,
//     every preview URL starts returning Cloudflare's "preview
//     disabled" page. Nothing else in the build or smoke pipeline
//     would notice; the deploy still succeeds.
await checkWranglerConfig();

// Dead-artifact guard. `CNAME` is GitHub-Pages-specific machinery
// (tells Pages which custom domain to serve at). This site deploys to
// Cloudflare Workers; a CNAME file in dist/ would ship as a static
// asset at `tint.sh/CNAME`, exposing a stale "we're served from Pages"
// signal that contradicts the actual hosting topology and confuses
// anyone debugging.
await checkAbsent('CNAME');

if (errors.length > 0) {
  console.error('dist smoke test failed:');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log('dist smoke test passed');
