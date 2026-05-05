import { readFile, stat } from 'node:fs/promises';
import { parse as parseJsonc, printParseErrorCode } from 'jsonc-parser';

const dist = new URL('../dist/', import.meta.url);
const errors: string[] = [];
const runtimeRoleButtonPattern = /\.setAttribute\(\s*(['"])role\1\s*,\s*(['"])button\2\s*\)/;
const runtimeFrameLabelPattern = /\$\{\s*\w+\s*\?\s*(['"])Pause\1\s*:\s*(['"])Play\2\s*\}:\s*\$\{/;
const reducedMotionInitialPausePattern =
  /matchMedia\(\s*(['"])\(prefers-reduced-motion: reduce\)\1\s*\)[\s\S]{0,240}?\blet\b[\s\S]{0,160}?\b\w+\s*=\s*\w+\.matches\b/;
const reducedMotionChangePausePattern =
  /(?:if\s*\([^)]*\.matches\)\s*\w+\s*=\s*true|\w+\.matches\s*&&\s*\(?\w+\s*=\s*!0\)?)/;

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

function extractVideoSrcs(html: string): string[] {
  return [...html.matchAll(/<video\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)]
    .map((match) => match[1] ?? match[2] ?? match[3])
    .filter((src): src is string => Boolean(src));
}

function extractScriptSrcs(html: string): string[] {
  return [...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)]
    .map((match) => match[1] ?? match[2] ?? match[3])
    .filter((src): src is string => Boolean(src));
}

function extractStylesheetHrefs(html: string): string[] {
  return [
    ...html.matchAll(
      /<link\b[^>]*\brel\s*=\s*["']stylesheet["'][^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
    ),
  ]
    .map((match) => match[1] ?? match[2] ?? match[3])
    .filter((href): href is string => Boolean(href));
}

function extractModuleSpecs(script: string): string[] {
  const specs: string[] = [];
  const patterns = [
    /\b(?:import|export)\s*[^;"'()]*?\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];

  for (const pattern of patterns) {
    for (const match of script.matchAll(pattern)) {
      if (match[1]) specs.push(match[1]);
    }
  }

  return specs;
}

function checkSmokeParserSelfTests(): void {
  const specs = extractModuleSpecs(`
    import{a as b}from"./from.js";
    import "./side-effect.js";
    const later = import('./dynamic.js');
    export*from"./exported.js";
  `);

  for (const expected of ['./from.js', './side-effect.js', './dynamic.js', './exported.js']) {
    check(specs.includes(expected), `script import parser missed ${expected}`);
  }

  for (const sample of [
    'frame.setAttribute("role","button")',
    'frame.setAttribute( \'role\' , "button" )',
  ]) {
    check(runtimeRoleButtonPattern.test(sample), `role=button parser rejected ${sample}`);
  }

  check(
    reducedMotionInitialPausePattern.test(
      'const q=window.matchMedia("(prefers-reduced-motion: reduce)");let a=null,b=null,p=q.matches,f=0;',
    ),
    'reduced-motion initial-pause parser rejected minified sample',
  );
  check(
    reducedMotionChangePausePattern.test('const h=e=>{e.matches&&(p=!0),r()};'),
    'reduced-motion change-pause parser rejected minified sample',
  );
}

async function readPageScripts(html: string): Promise<string[]> {
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? '');
  const seen = new Set<string>();

  async function readScriptPath(path: string): Promise<void> {
    if (seen.has(path)) return;
    seen.add(path);

    const body = await readDistFile(path);
    scripts.push(body);

    for (const spec of extractModuleSpecs(body)) {
      if (spec.startsWith('.')) {
        const resolved = new URL(spec, `https://tint.sh/${path}`).pathname.slice(1);
        await readScriptPath(resolved);
      }
    }
  }

  for (const src of extractScriptSrcs(html)) {
    if (src.startsWith('/') && !src.startsWith('//')) {
      await readScriptPath(src.slice(1));
    }
  }

  return scripts;
}

async function readPageStyles(html: string): Promise<string[]> {
  const styles = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1] ?? '');

  for (const href of extractStylesheetHrefs(html)) {
    if (href.startsWith('/') && !href.startsWith('//')) {
      styles.push(await readDistFile(href.slice(1)));
    }
  }

  return styles;
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

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function checkRootLocalAssetPath(kind: string, path: string): void {
  check(!path.startsWith('/'), `${kind} must be relative, got ${path}`);
  check(!/^[a-z][a-z0-9+.-]*:/i.test(path), `${kind} must not be absolute, got ${path}`);
  check(
    !path.split('/').some((segment) => segment === '.' || segment === '..'),
    `${kind} must not use dot segments, got ${path}`,
  );
  check(!path.includes('/'), `${kind} must be a root-local asset filename, got ${path}`);
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

// Demo videos are played by the viewport-aware controller below rather
// than by raw `autoplay` attributes. They must still be muted and
// playsinline so programmatic play works in mobile browsers.
async function checkVideoElements(html: string): Promise<void> {
  const tags = [...html.matchAll(/<video\b[^>]*>/g)].map((m) => m[0]);
  const frames = [...html.matchAll(/<div\b[^>]*\bdata-demo-frame\b[^>]*>/g)].map((m) => m[0]);
  check(tags.length > 0, 'homepage is missing a <video> element');
  for (const tag of tags) {
    if (/\bdata-demo-video\b/.test(tag)) {
      for (const attr of ['loop', 'muted', 'playsinline']) {
        check(
          new RegExp(`\\b${attr}\\b`).test(tag),
          `<video data-demo-video> missing required ${attr} attribute: ${tag}`,
        );
      }
      check(
        !/\bautoplay\b/.test(tag),
        `<video data-demo-video> should be script-controlled, not autoplay: ${tag}`,
      );
      const preload = getAttr(tag, 'preload');
      check(
        preload === 'auto',
        `<video data-demo-video> should preload eagerly for iPhone Safari poster/frame readiness: ${tag}`,
      );
      const poster = getAttr(tag, 'poster');
      check(
        Boolean(poster),
        `<video data-demo-video> missing poster (iPhone Safari blank-box regression): ${tag}`,
      );
      if (poster) {
        checkRootLocalAssetPath('video poster', poster);
        await checkNonEmptyFile(poster);
      }
    }
    const ariaLabel = getAttr(tag, 'aria-label');
    check(Boolean(ariaLabel), `<video> missing or empty aria-label (a11y regression): ${tag}`);
  }

  const demoVideos = tags.filter((tag) => /\bdata-demo-video\b/.test(tag));
  check(
    demoVideos.length === 5,
    `expected 5 script-controlled demo videos, found ${demoVideos.length}`,
  );
  const demoVideoLabels = demoVideos
    .map((tag) => getAttr(tag, 'aria-label'))
    .filter((label): label is string => Boolean(label));
  check(
    new Set(demoVideoLabels).size === demoVideos.length,
    `demo video aria-labels must be unique so runtime frame controls have unique names: ${demoVideoLabels.join(' | ')}`,
  );
  check(frames.length === 5, `expected 5 demo video frames, found ${frames.length}`);
  for (const [i, frame] of frames.entries()) {
    check(
      !/\brole\s*=\s*"button"/.test(frame),
      `demo video frame ${i}: should not be a static role="button" without JS handlers`,
    );
    check(
      !/\btabindex\s*=\s*"0"/.test(frame),
      `demo video frame ${i}: should not be statically focusable without JS handlers`,
    );
  }
}

function checkDemoFallbackLinks(html: string): void {
  const frames = [...html.matchAll(/<div\b[^>]*\bdata-demo-frame\b[^>]*>[\s\S]*?<\/div>/g)].map(
    (m) => m[0],
  );

  for (const [i, frame] of frames.entries()) {
    const videoTag = frame.match(/<video\b[^>]*>/)?.[0];
    const videoSrc = videoTag ? getAttr(videoTag, 'src') : undefined;
    const videoPoster = videoTag ? getAttr(videoTag, 'poster') : undefined;
    const posterTag = frame.match(/<img\b[^>]*\bdata-demo-poster\b[^>]*>/)?.[0];
    const posterSrc = posterTag ? getAttr(posterTag, 'src') : undefined;
    const fallback = frame.match(
      /<noscript\b[\s\S]*?<a\b[^>]*\bhref\s*=\s*"([^"]+)"[^>]*>[\s\S]*?<\/a>[\s\S]*?<\/noscript>/,
    );
    const fallbackHref = fallback?.[1];

    check(Boolean(videoSrc), `demo video frame ${i}: missing video src`);
    check(Boolean(fallbackHref), `demo video frame ${i}: missing no-JS fallback link`);
    if (videoSrc && fallbackHref) {
      check(
        fallbackHref === videoSrc,
        `demo video frame ${i}: fallback href ${fallbackHref} does not match video src ${videoSrc}`,
      );
      checkRootLocalAssetPath(`demo fallback href ${i}`, fallbackHref);
    }

    check(Boolean(videoPoster), `demo video frame ${i}: missing video poster`);
    check(Boolean(posterTag), `demo video frame ${i}: missing poster shim image`);
    if (videoPoster && posterSrc) {
      check(
        posterSrc === videoPoster,
        `demo video frame ${i}: poster shim src ${posterSrc} does not match video poster ${videoPoster}`,
      );
      checkRootLocalAssetPath(`demo poster shim ${i}`, posterSrc);
    }
    if (posterTag) {
      check(getAttr(posterTag, 'alt') === '', `demo poster shim ${i}: alt must be empty`);
      check(
        getAttr(posterTag, 'aria-hidden') === 'true',
        `demo poster shim ${i}: must be aria-hidden`,
      );
      check(
        getAttr(posterTag, 'loading') === 'eager',
        `demo poster shim ${i}: must load eagerly before scroll/playback`,
      );
      check(
        getAttr(posterTag, 'decoding') === 'sync',
        `demo poster shim ${i}: must request synchronous decode to avoid first-paint flashes`,
      );
    }
  }
}

function checkDemoPosterStyles(styles: string[]): void {
  const hasPosterShimStyles = styles.some(
    (s) =>
      s.includes('.demo-poster') &&
      s.includes('position:absolute') &&
      s.includes('object-fit:cover') &&
      s.includes('data-demo-video-ready') &&
      s.includes('opacity:0'),
  );
  check(hasPosterShimStyles, 'no bundled CSS layers the demo poster shim above the video');
}

function checkDemoVideoController(scripts: string[]): void {
  const wired = scripts.some(
    (s) =>
      s.includes('data-demo-frame') &&
      s.includes('data-demo-video') &&
      s.includes('data-demo-video-ready') &&
      s.includes('IntersectionObserver') &&
      s.includes('prefers-reduced-motion: reduce') &&
      s.includes('matchMedia') &&
      reducedMotionInitialPausePattern.test(s) &&
      reducedMotionChangePausePattern.test(s) &&
      s.includes('data-demo-paused') &&
      s.includes('aria-pressed') &&
      s.includes('getAttribute("aria-label")') &&
      runtimeFrameLabelPattern.test(s) &&
      runtimeRoleButtonPattern.test(s) &&
      /addEventListener\(["']click["']/.test(s) &&
      /addEventListener\(["']keydown["']/.test(s) &&
      /addEventListener\(["']playing["']/.test(s) &&
      /addEventListener\(["']timeupdate["']/.test(s) &&
      /addEventListener\(["']scroll["']/.test(s) &&
      s.includes('cancelAnimationFrame') &&
      s.includes('requestAnimationFrame') &&
      s.includes('currentTime') &&
      s.includes('.pause()') &&
      s.includes('.play()'),
  );
  check(wired, 'no bundled script wires clickable viewport-aware demo video playback');
}

function checkCopyButtons(html: string, scripts: string[]): void {
  const buttons = [
    ...html.matchAll(
      /<button\b(?:"[^"]*"|'[^']*'|[^'">])*\bdata-copy\b(?:"[^"]*"|'[^']*'|[^'">])*>[\s\S]*?<\/button>/g,
    ),
  ].map((m) => m[0]);
  check(buttons.length === 6, `expected 6 copy buttons, found ${buttons.length}`);

  for (const [i, button] of buttons.entries()) {
    const tag = button.match(/<button\b(?:"[^"]*"|'[^']*'|[^'">])*>/)?.[0] ?? '';
    const dataCode = getAttr(tag, 'data-code');
    const ariaLabel = getAttr(tag, 'aria-label');
    check(Boolean(dataCode), `copy button ${i}: missing data-code`);
    check(Boolean(ariaLabel), `copy button ${i}: missing aria-label`);
    if (dataCode && ariaLabel) {
      const decodedCode = decodeHtmlEntities(dataCode);
      const decodedLabel = decodeHtmlEntities(ariaLabel);
      check(
        decodedLabel === `Copy ${decodedCode}`,
        `copy button ${i}: aria-label "${decodedLabel}" does not match "Copy ${decodedCode}"`,
      );
    }
    check(
      /\bdata-copy-announce\b/.test(button) && /\baria-live\s*=\s*"polite"/.test(button),
      `copy button ${i}: missing polite data-copy-announce live region`,
    );
  }

  const hasSharedController = scripts.some(
    (s) => s.includes('clipboard.writeText') && s.includes('data-copy-announce'),
  );
  const hasInstallWiring = scripts.some((s) => s.includes('.install-widget [data-copy]'));
  const hasFeatureWiring = scripts.some((s) => s.includes('[data-feature-copy]'));
  check(hasSharedController, 'no bundled script contains the shared copy-button controller');
  check(hasInstallWiring, 'no bundled script wires install-widget copy buttons');
  check(hasFeatureWiring, 'no bundled script wires feature-command copy buttons');
}

function checkFeatureDemos(html: string): void {
  const expectedCommands = [
    'tint dracula',
    'tint',
    'eval "$(tint hook bash)"\necho dracula > .tint',
    [
      'mkdir -p ~/.config/tint/themes',
      "cat > ~/.config/tint/themes/matrix.theme <<'EOF'",
      'matrix:#000000:#00ff00:#000000:#008800:#00ff00:#aaff00:#005533:#00aa55:#00ff66:#88ff99:#003311:#00bb22:#33ff44:#bbff44:#006644:#00cc66:#44ff77:#ddffdd',
      'EOF',
      'tint matrix',
    ].join('\n'),
  ];
  const expectedInlineCode = [[], ['tint'], ['.tint'], ['.theme']];
  const sections = [
    ...html.matchAll(/<section\b[^>]*\bdata-feature-demo\b[^>]*>[\s\S]*?<\/section>/g),
  ].map((m) => m[0]);
  check(
    sections.length === expectedCommands.length,
    `expected ${expectedCommands.length} feature demos, found ${sections.length}`,
  );

  for (const [i, section] of sections.entries()) {
    check(/<h2\b/.test(section), `feature demo ${i}: missing title`);
    check(/<p\b/.test(section), `feature demo ${i}: missing sentence`);
    const sentence = section.match(/<p\b[^>]*>[\s\S]*?<\/p>/)?.[0] ?? '';
    check(!sentence.includes('`'), `feature demo ${i}: sentence rendered literal backticks`);
    for (const codeText of expectedInlineCode[i] ?? []) {
      check(
        new RegExp(`<code>${escapeRegex(codeText)}</code>`).test(sentence),
        `feature demo ${i}: sentence missing inline code for ${codeText}`,
      );
    }
    check(/<video\b/.test(section), `feature demo ${i}: missing video`);
    check(/\bdata-feature-command\b/.test(section), `feature demo ${i}: missing command block`);
    const copyButton = section.match(
      /<button\b(?:"[^"]*"|'[^']*'|[^'">])*\bdata-feature-copy\b(?:"[^"]*"|'[^']*'|[^'">])*>/,
    )?.[0];
    check(Boolean(copyButton), `feature demo ${i}: missing copy button`);
    if (copyButton) {
      const dataCode = getAttr(copyButton, 'data-code');
      check(Boolean(dataCode), `feature demo ${i}: copy button missing data-code`);
      if (dataCode) {
        const decodedCode = decodeHtmlEntities(dataCode);
        check(
          decodedCode === expectedCommands[i],
          `feature demo ${i}: command mismatch "${decodedCode}"`,
        );
        check(/\bdata-copy\b/.test(copyButton), `feature demo ${i}: copy button missing data-copy`);
      }
    }
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
function checkInstallWidget(html: string, scripts: string[]): void {
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
  // not the two substrings independently. This protects the install
  // widget's selector while `checkCopyButtons` verifies the shared
  // controller used by every copy button on the page.
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
// Approach: parse the JSONC with the canonical parser
// (`jsonc-parser`, the same library Wrangler and VSCode use
// internally), then assert structural property paths
// (`config.build?.command`, `config.preview_urls`).
//
// Why a real parser, not regex stripping: the previous strip-
// then-JSON.parse approach was not string-aware — a future entry
// like `"command": "echo //hello"` or `"route": "https://x.dev/*/y"`
// would have its plain-string `//`, `/* */`, or `,]` content
// mangled before parsing. `jsonc-parser` tracks string vs comment
// state and accepts every JSONC relaxation Wrangler does, so any
// valid wrangler.jsonc edit parses correctly here.
//
// Property-path assertions (vs raw-text regex) also guarantee the
// entry is at the *top level* — a future nested entry with the
// same literal value cannot false-pass them.
async function checkWranglerConfig(): Promise<void> {
  let raw = '';
  try {
    raw = await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  } catch (error) {
    errors.push(describeFsFailure('read', 'wrangler.jsonc', error));
    return;
  }

  const parseErrors: { error: number; offset: number; length: number }[] = [];
  const config = parseJsonc(raw, parseErrors, {
    allowTrailingComma: true,
    disallowComments: false,
  }) as { build?: { command?: string }; preview_urls?: boolean } | undefined;
  if (parseErrors.length > 0 || config === undefined) {
    const summary = parseErrors
      .map((e) => `${printParseErrorCode(e.error)} at offset ${e.offset}`)
      .join('; ');
    errors.push(
      `wrangler.jsonc: failed to parse: ${summary || 'returned undefined'} — fix the JSONC syntax`,
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
const pageScripts = await readPageScripts(html);
const pageStyles = await readPageStyles(html);
const videoSrcs = extractVideoSrcs(html);

checkSmokeParserSelfTests();

check(videoSrcs.length > 0, 'homepage is missing a video src');
check(videoSrcs.includes('demo.mp4'), 'homepage is missing the primary demo.mp4 video');

for (const videoSrc of videoSrcs) {
  checkRootLocalAssetPath('video src', videoSrc);
  await checkNonEmptyFile(videoSrc);
}

checkInstallWidget(html, pageScripts);
checkCopyButtons(html, pageScripts);
await checkVideoElements(html);
checkDemoFallbackLinks(html);
checkDemoPosterStyles(pageStyles);
checkDemoVideoController(pageScripts);
checkFeatureDemos(html);
checkIconOnlyLinks(html);
checkLabelControlWiring(html);
checkPlausibleSnippet(html, 'index.html');
checkPlausibleSnippet(notFoundHtml, '404.html');
await checkFaviconLinks(html, 'index.html');
await checkFaviconLinks(notFoundHtml, '404.html');

for (const file of [
  'demo.gif',
  'demo-cli.gif',
  'demo-picker.gif',
  'demo-cd-hook.gif',
  'demo-custom-theme.gif',
]) {
  await checkNonEmptyFile(file);
}
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
