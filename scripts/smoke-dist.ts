import { readFile, stat } from 'node:fs/promises';

const dist = new URL('../dist/', import.meta.url);
const errors: string[] = [];

function check(condition: boolean, message: string): void {
  if (!condition) {
    errors.push(message);
  }
}

async function readDistFile(path: string): Promise<string> {
  try {
    return await readFile(new URL(path, dist), 'utf8');
  } catch (error) {
    errors.push(`missing ${path}: ${(error as Error).message}`);
    return '';
  }
}

async function checkNonEmptyFile(path: string): Promise<void> {
  try {
    const file = await stat(new URL(path, dist));
    check(file.isFile(), `${path} is not a file`);
    check(file.size > 0, `${path} is empty`);
  } catch (error) {
    errors.push(`missing ${path}: ${(error as Error).message}`);
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
  // short URL the Cloudflare Worker (worker/index.ts) handles by 302-ing
  // to the GitHub release asset. Reverting to the raw github.com URL
  // would (a) regress the displayed command back to ~80 chars of wrap-
  // worthy text, and (b) bypass the Worker's `tint_download` Plausible
  // event because traffic would never hit tint.sh for that path.
  const installUrls = buttons.map((tag) => decodeHtmlEntities(getAttr(tag, 'data-code') ?? ''));
  const hasShortInstallUrl = installUrls.some((code) => code.includes('https://tint.sh/tint'));
  check(
    hasShortInstallUrl,
    `no install button references https://tint.sh/tint — install URL drift (saw: ${installUrls.join(' | ')})`,
  );

  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? '');
  const wired = scripts.some((s) => s.includes('.install-widget') && s.includes('data-copy'));
  check(
    wired,
    'no inlined <script> references the .install-widget [data-copy] selector — script bundling or selector drift',
  );
}

// Plausible Analytics is the load-bearing observability channel for
// tint.sh — every page must include the snippet, otherwise the dashboard
// silently under-counts pageviews and our 6-month-trend assumption goes
// invisible. The snippet is dynamically injected by an inline gate in
// the layout (see Layout.astro), so we look for the bundle URL inside
// the inline script bodies, not in `<script src="…">` attributes.
//
// Three invariants are enforced together so the entire class of
// "production analytics gets polluted by non-prod traffic" stays
// solved:
//
//   1. The snippet must reference the bundle URL stem (loose match by
//      `plausible.io/js/pa-` — Plausible periodically reissues the
//      bundle under a new hash, and pinning the full hash would make
//      a remote rotation a CI failure).
//   2. The snippet must call `plausible.init()` so SPA-style pageview
//      hooks are wired.
//   3. The snippet must hostname-gate on `tint.sh` so *.workers.dev
//      verify hits, future preview hostnames, and local `astro dev`
//      don't auto-fire a production pageview when the bundle loads.
//      The matching server-side gate lives in worker/index.ts.
//
// Coverage is page-by-page rather than once-per-build because the
// failure mode is "404.html lost the snippet during a layout
// refactor", not "the project lost it everywhere".
function checkPlausibleSnippet(html: string, sourcePath: string): void {
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? '');
  const hasBundleUrl = scripts.some((s) => /plausible\.io\/js\/pa-/.test(s));
  check(hasBundleUrl, `${sourcePath}: no inline <script> references the Plausible bundle URL`);
  const hasInit = scripts.some((s) => /plausible\.init\s*\(/.test(s));
  check(hasInit, `${sourcePath}: no inline <script> calls plausible.init()`);
  const hasHostGate = scripts.some((s) => /location\.hostname\s*===\s*['"]tint\.sh['"]/.test(s));
  check(
    hasHostGate,
    `${sourcePath}: Plausible snippet missing 'tint.sh' hostname gate (would fire pageviews on *.workers.dev / preview hosts)`,
  );
}

const html = await readDistFile('index.html');
const notFoundHtml = await readDistFile('404.html');
const videoSrc = extractVideoSrc(html);

check(Boolean(videoSrc), 'homepage is missing a video src');

if (videoSrc) {
  check(!videoSrc.startsWith('/'), `video src must be relative, got ${videoSrc}`);
  check(!/^[a-z][a-z0-9+.-]*:/i.test(videoSrc), `video src must not be absolute, got ${videoSrc}`);

  const projectPagesUrl = new URL(videoSrc, 'https://corygabrielsen.github.io/tint-website/');
  const customDomainUrl = new URL(videoSrc, 'https://tint.sh/');

  check(
    projectPagesUrl.pathname === '/tint-website/demo.mp4',
    `video src resolves incorrectly on project Pages: ${projectPagesUrl.href}`,
  );
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

if (errors.length > 0) {
  console.error('dist smoke test failed:');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log('dist smoke test passed');
