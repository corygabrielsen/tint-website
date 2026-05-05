import { wireDemoVideos } from '../src/scripts/demo-videos';

interface FakeRect {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

interface FakeEvent {
  readonly type: string;
  readonly key?: string;
  readonly matches?: boolean;
  preventDefault(): void;
  readonly defaultPrevented: boolean;
}

type FakeListener = (event: FakeEvent) => void;

const errors: string[] = [];

function rect(top: number, height = 300, left = 0, width = 800): FakeRect {
  return {
    left,
    right: left + width,
    top,
    bottom: top + height,
    width,
    height,
  };
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

class FakeEventTarget {
  readonly listeners = new Map<string, FakeListener[]>();

  addEventListener(type: string, listener: FakeListener | null): void {
    if (!listener) return;
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(
    type: string,
    event: Partial<Omit<FakeEvent, 'type' | 'defaultPrevented'>> = {},
  ): FakeEvent {
    let defaultPrevented = false;
    const fakeEvent: FakeEvent = {
      ...event,
      type,
      preventDefault: () => {
        defaultPrevented = true;
      },
      get defaultPrevented() {
        return defaultPrevented;
      },
    };

    for (const listener of this.listeners.get(type) ?? []) {
      listener(fakeEvent);
    }

    return fakeEvent;
  }
}

class FakeVideo extends FakeEventTarget {
  readonly attributes = new Map<string, string>();
  currentTime = 0;
  loadCount = 0;
  pauseCount = 0;
  paused = true;
  playCount = 0;
  preload = 'metadata';
  readyState = 2;

  constructor(
    readonly name: string,
    public bounds: FakeRect,
  ) {
    super();
    this.attributes.set('aria-label', name);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  getBoundingClientRect(): FakeRect {
    return this.bounds;
  }

  load(): void {
    this.loadCount += 1;
  }

  pause(): void {
    this.pauseCount += 1;
    this.paused = true;
  }

  play(): Promise<void> {
    this.playCount += 1;
    this.paused = false;
    return Promise.resolve();
  }
}

class FakeFrame extends FakeEventTarget {
  readonly attributes = new Map<string, string>();
  tabIndex = -1;

  constructor(readonly video: FakeVideo) {
    super();
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  querySelector(selector: string): FakeVideo | null {
    return selector === '[data-demo-video]' ? this.video : null;
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  toggleAttribute(name: string, force?: boolean): boolean {
    const shouldSet = force ?? !this.attributes.has(name);
    if (shouldSet) this.attributes.set(name, '');
    else this.attributes.delete(name);
    return shouldSet;
  }
}

class FakeDocument extends FakeEventTarget {
  readonly documentElement = {
    clientHeight: 800,
    clientWidth: 800,
  };
  visibilityState: DocumentVisibilityState = 'visible';

  constructor(readonly frames: FakeFrame[]) {
    super();
  }

  querySelectorAll(selector: string): FakeFrame[] {
    return selector === '[data-demo-frame]' ? this.frames : [];
  }
}

class FakeMediaQueryList {
  readonly legacyListeners: FakeListener[] = [];
  readonly modernListeners: FakeListener[] = [];

  constructor(
    public matches: boolean,
    private readonly throwModernListener = false,
  ) {}

  addEventListener(type: string, listener: FakeListener): void {
    if (this.throwModernListener) throw new TypeError('legacy WebKit only accepts addListener');
    if (type === 'change') this.modernListeners.push(listener);
  }

  addListener(listener: FakeListener): void {
    this.legacyListeners.push(listener);
  }

  dispatchChange(matches: boolean): void {
    this.matches = matches;
    const event = {
      type: 'change',
      matches,
      preventDefault: () => {},
      defaultPrevented: false,
    };
    for (const listener of [...this.modernListeners, ...this.legacyListeners]) {
      listener(event);
    }
  }
}

class FakeIntersectionObserver {
  readonly observed: FakeVideo[] = [];

  constructor(
    readonly callback: () => void,
    readonly options: { readonly threshold?: number[] } = {},
  ) {}

  observe(video: FakeVideo): void {
    this.observed.push(video);
  }
}

class FakeWindow extends FakeEventTarget {
  readonly IntersectionObserver = FakeIntersectionObserver;
  innerHeight = 800;
  innerWidth = 800;
  private rafId = 0;
  private readonly rafs = new Map<number, () => void>();

  constructor(readonly mediaQuery: FakeMediaQueryList) {
    super();
  }

  cancelAnimationFrame(id: number): void {
    this.rafs.delete(id);
  }

  matchMedia(query: string): FakeMediaQueryList {
    assert(query === '(prefers-reduced-motion: reduce)', `unexpected media query: ${query}`);
    return this.mediaQuery;
  }

  requestAnimationFrame(callback: () => void): number {
    const id = ++this.rafId;
    this.rafs.set(id, callback);
    return id;
  }

  flushAnimationFrame(): void {
    const callbacks = [...this.rafs.values()];
    this.rafs.clear();
    for (const callback of callbacks) callback();
  }

  async tick(frameCount = 1): Promise<void> {
    for (let i = 0; i < frameCount; i += 1) {
      this.flushAnimationFrame();
      await Promise.resolve();
    }
  }
}

interface Harness {
  readonly document: FakeDocument;
  readonly frames: FakeFrame[];
  readonly mediaQuery: FakeMediaQueryList;
  readonly videos: FakeVideo[];
  readonly window: FakeWindow;
}

function installGlobals(harness: Harness): void {
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: harness.document,
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: harness.window,
  });
}

function createHarness(
  bounds: FakeRect[] = [rect(250), rect(650), rect(1050)],
  options: { readonly reducedMotion?: boolean; readonly throwModernMediaListener?: boolean } = {},
): Harness {
  const videos = bounds.map((videoRect, i) => new FakeVideo(`demo ${i}`, videoRect));
  const frames = videos.map((video) => new FakeFrame(video));
  const mediaQuery = new FakeMediaQueryList(
    options.reducedMotion ?? false,
    options.throwModernMediaListener ?? false,
  );
  const document = new FakeDocument(frames);
  const window = new FakeWindow(mediaQuery);
  const harness = { document, frames, mediaQuery, videos, window };
  installGlobals(harness);
  return harness;
}

function playingVideos(videos: readonly FakeVideo[]): FakeVideo[] {
  return videos.filter((video) => !video.paused);
}

function item<T>(items: readonly T[], index: number, label: string): T {
  const value = items[index];
  assert(value !== undefined, `missing ${label} at index ${index}`);
  return value;
}

function assertGlobalPausedOverlay(frames: readonly FakeFrame[]): void {
  for (const [i, frame] of frames.entries()) {
    assert(
      frame.hasAttribute('data-demo-paused'),
      `frame ${i} missing global paused overlay state`,
    );
    assert(frame.getAttribute('aria-pressed') === 'false', `frame ${i} should not be pressed`);
    assert(
      frame.getAttribute('aria-label')?.startsWith('Play: ') === true,
      `frame ${i} should be labelled as playable`,
    );
  }
}

async function runInitialPlayback(harness: Harness): Promise<void> {
  wireDemoVideos();
  await harness.window.tick();
}

async function testViewportFocusAndSinglePlayback(): Promise<void> {
  const harness = createHarness([rect(80), rect(250), rect(1050)]);
  const video0 = item(harness.videos, 0, 'video');
  const video1 = item(harness.videos, 1, 'video');
  const video2 = item(harness.videos, 2, 'video');
  const frame0 = item(harness.frames, 0, 'frame');
  const frame1 = item(harness.frames, 1, 'frame');
  video0.currentTime = 2;
  video2.currentTime = 2;

  await runInitialPlayback(harness);

  for (const [i, frame] of harness.frames.entries()) {
    assert(frame.getAttribute('role') === 'button', `frame ${i} was not upgraded to a button`);
    assert(frame.tabIndex === 0, `frame ${i} was not made keyboard focusable`);
    assert(
      frame.getAttribute('aria-label')?.startsWith(i === 1 ? 'Pause: ' : 'Play: ') === true,
      `frame ${i} has the wrong initial accessible label`,
    );
  }

  assert(playingVideos(harness.videos).length === 1, 'exactly one focused video should play');
  assert(!video1.paused, 'most centered visible video should play');
  assert(video1.preload === 'auto', 'active video should promote to eager preload');
  assert(video1.loadCount === 1, 'active video should call load() when promoted');
  assert(video0.preload === 'metadata', 'inactive video should keep metadata preload');
  assert(video0.currentTime === 0, 'inactive visible video should reset to frame zero');
  assert(video2.currentTime === 0, 'offscreen video should reset to frame zero');
  assert(frame1.hasAttribute('data-demo-active'), 'focused frame should be active');
  assert(!frame0.hasAttribute('data-demo-active'), 'non-focused frame should not be active');
  assert(frame1.getAttribute('aria-pressed') === 'true', 'active frame should be pressed');
}

async function testGlobalPauseAndResume(): Promise<void> {
  const harness = createHarness([rect(250), rect(620)]);
  const video0 = item(harness.videos, 0, 'video');
  const video1 = item(harness.videos, 1, 'video');
  const frame0 = item(harness.frames, 0, 'frame');
  const frame1 = item(harness.frames, 1, 'frame');
  await runInitialPlayback(harness);

  frame0.dispatch('click');
  assert(
    playingVideos(harness.videos).length === 0,
    'clicking the active demo should pause all videos',
  );
  assertGlobalPausedOverlay(harness.frames);

  const keyEvent = frame1.dispatch('keydown', { key: ' ' });
  await Promise.resolve();

  assert(keyEvent.defaultPrevented, 'keyboard activation should prevent page scroll on Space');
  assert(playingVideos(harness.videos).length === 1, 'global resume should play exactly one video');
  assert(!video0.paused, 'global resume should keep the active video selected');
  assert(video1.paused, 'global resume must not switch to the clicked paused overlay');
  assert(
    harness.frames.every((frame) => !frame.hasAttribute('data-demo-paused')),
    'global resume should clear the global paused overlay from every frame',
  );
  assert(frame0.getAttribute('aria-pressed') === 'true', 'resumed active frame should be pressed');
  assert(
    frame1.getAttribute('aria-pressed') === 'false',
    'clicked inactive overlay should not become pressed on global resume',
  );
}

async function testScrollClearsManualOverride(): Promise<void> {
  const harness = createHarness([rect(250), rect(620)]);
  const video0 = item(harness.videos, 0, 'video');
  const video1 = item(harness.videos, 1, 'video');
  const frame1 = item(harness.frames, 1, 'frame');
  await runInitialPlayback(harness);

  frame1.dispatch('click');
  await Promise.resolve();
  assert(!video1.paused, 'manual click should override viewport focus');

  video1.currentTime = 3;
  harness.window.dispatch('scroll');
  await harness.window.tick();

  assert(!video0.paused, 'scroll should return playback to the focused video');
  assert(video1.paused, 'manual video should pause after scroll clears override');
  assert(video1.currentTime === 0, 'manual video should reset after losing focus');
}

async function testReducedMotionDefaultAndChange(): Promise<void> {
  const harness = createHarness([rect(250), rect(620)], { reducedMotion: true });
  const video0 = item(harness.videos, 0, 'video');
  const video1 = item(harness.videos, 1, 'video');
  const frame1 = item(harness.frames, 1, 'frame');
  await runInitialPlayback(harness);

  assert(playingVideos(harness.videos).length === 0, 'reduced motion should start paused');
  assertGlobalPausedOverlay(harness.frames);

  frame1.dispatch('click');
  await Promise.resolve();
  assert(!video0.paused, 'click should let reduced-motion users opt into playback');
  assert(video1.paused, 'reduced-motion opt-in must not switch to the clicked paused overlay');
  assert(
    harness.frames.every((frame) => !frame.hasAttribute('data-demo-paused')),
    'user opt-in should clear paused overlays',
  );

  harness.mediaQuery.dispatchChange(true);
  await harness.window.tick();

  assert(playingVideos(harness.videos).length === 0, 'reduced-motion change should pause playback');
  assertGlobalPausedOverlay(harness.frames);
}

async function testLegacyReducedMotionListenerFallback(): Promise<void> {
  const harness = createHarness([rect(250), rect(620)], { throwModernMediaListener: true });
  await runInitialPlayback(harness);

  assert(
    harness.mediaQuery.legacyListeners.length === 1,
    'legacy media-query listener should be installed when modern listener throws',
  );

  harness.mediaQuery.dispatchChange(true);
  await harness.window.tick();

  assert(
    playingVideos(harness.videos).length === 0,
    'legacy media-query change should pause playback',
  );
  assertGlobalPausedOverlay(harness.frames);
}

async function testPosterHandoffWaitsForPaint(): Promise<void> {
  const harness = createHarness([rect(250), rect(620)]);
  const frame0 = item(harness.frames, 0, 'frame');
  wireDemoVideos();

  await harness.window.tick();
  assert(
    !frame0.hasAttribute('data-demo-video-ready'),
    'poster should stay visible before the video paint handoff',
  );

  await harness.window.tick();
  assert(
    !frame0.hasAttribute('data-demo-video-ready'),
    'poster should stay visible through the first paint frame',
  );

  await harness.window.tick();
  assert(
    frame0.hasAttribute('data-demo-video-ready'),
    'poster should release after the active video has painted for two frames',
  );
}

async function testStalePosterReleaseCannotWin(): Promise<void> {
  const harness = createHarness([rect(250), rect(620)]);
  const frame0 = item(harness.frames, 0, 'frame');
  const frame1 = item(harness.frames, 1, 'frame');
  wireDemoVideos();

  await harness.window.tick();
  frame1.dispatch('click');
  await Promise.resolve();
  await harness.window.tick(3);

  assert(
    !frame0.hasAttribute('data-demo-video-ready'),
    'stale poster release must not mark an inactive frame ready',
  );
  assert(
    frame1.hasAttribute('data-demo-video-ready'),
    'newly active video should still release its poster after paint',
  );
}

async function testVisibilityHiddenResetsVideos(): Promise<void> {
  const harness = createHarness([rect(250), rect(620)]);
  const frame0 = item(harness.frames, 0, 'frame');
  await runInitialPlayback(harness);

  for (const video of harness.videos) video.currentTime = 4;
  frame0.setAttribute('data-demo-video-ready', '');
  harness.document.visibilityState = 'hidden';
  harness.document.dispatch('visibilitychange');
  await harness.window.tick();

  assert(
    playingVideos(harness.videos).length === 0,
    'hidden document should pause every demo video',
  );
  for (const [i, video] of harness.videos.entries()) {
    assert(video.currentTime === 0, `hidden document should reset video ${i} to frame zero`);
  }
  assert(
    harness.frames.every((frame) => !frame.hasAttribute('data-demo-active')),
    'hidden document should clear active frame state',
  );
  assert(
    !frame0.hasAttribute('data-demo-video-ready'),
    'hidden document should restore poster shim state',
  );
}

async function runTest(name: string, test: () => Promise<void>): Promise<void> {
  try {
    await test();
  } catch (error) {
    errors.push(`${name}: ${(error as Error).message}`);
  }
}

await runTest('viewport focus and single playback', testViewportFocusAndSinglePlayback);
await runTest('global pause and resume', testGlobalPauseAndResume);
await runTest('scroll clears manual override', testScrollClearsManualOverride);
await runTest('reduced motion default and change', testReducedMotionDefaultAndChange);
await runTest('legacy reduced-motion listener fallback', testLegacyReducedMotionListenerFallback);
await runTest('poster handoff waits for paint', testPosterHandoffWaitsForPaint);
await runTest('stale poster release cannot win', testStalePosterReleaseCannotWin);
await runTest('visibility hidden resets videos', testVisibilityHiddenResetsVideos);

if (errors.length > 0) {
  console.error('demo video smoke test failed:');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log('demo video smoke test passed');
