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

  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(
    (m) => m[1] ?? '',
  );
  const wired = scripts.some((s) => s.includes('.install-widget') && s.includes('data-copy'));
  check(
    wired,
    'no inlined <script> references the .install-widget [data-copy] selector — script bundling or selector drift',
  );
}

const html = await readDistFile('index.html');
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
