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

// The <video> element relies on three browser-policy attributes for the
// autoplay demo to actually play: `autoplay` triggers playback, `muted` is
// required by every modern browser's autoplay policy (without it autoplay
// is blocked), and `playsinline` keeps iOS Safari from going fullscreen
// on tap. Removing any one of them silently breaks the demo while still
// rendering a poster frame, so the page looks fine in CI but is broken
// for users. A non-empty `aria-label` is also required so screen readers
// have something to announce for the unlabeled video.
function checkVideoElement(html: string): void {
  const tag = html.match(/<video\b[^>]*>/)?.[0];
  check(Boolean(tag), 'homepage is missing a <video> element');
  if (!tag) return;
  for (const attr of ['autoplay', 'muted', 'playsinline']) {
    check(
      new RegExp(`\\b${attr}\\b`).test(tag),
      `<video> missing required ${attr} attribute (autoplay won't trigger without it)`,
    );
  }
  const ariaLabel = getAttr(tag, 'aria-label');
  check(Boolean(ariaLabel), '<video> missing or empty aria-label (a11y regression)');
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

// Structural assertions for the install widget. These catch the regression
// classes the click handler is most exposed to: missing/wrong data-code,
// aria-label drift, and — most importantly — the inlined <script> losing
// the `.install-widget [data-copy]` selector that wires the handler to
// the rendered buttons. Without this last check, a selector or bundling
// regression would ship silently because nothing exercises the handler
// at runtime in CI.
function checkInstallWidget(html: string): void {
  const buttons = [...html.matchAll(/<button\b[^>]*\bdata-copy\b[^>]*>/g)].map((m) => m[0]);
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

  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? '');
  const wired = scripts.some((s) => s.includes('.install-widget') && s.includes('data-copy'));
  check(
    wired,
    'no inlined <script> references the .install-widget [data-copy] selector — script bundling or selector drift',
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
checkVideoElement(html);
checkIconOnlyLinks(html);
checkLabelControlWiring(html);
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
