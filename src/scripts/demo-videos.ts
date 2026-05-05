const DEMO_VIDEO_MIN_VISIBLE_RATIO = 0.12;
const DEMO_VIDEO_READY_STATE = 2;

export function wireDemoVideos(): void {
  const demoFrames = [...document.querySelectorAll<HTMLElement>('[data-demo-frame]')];
  const demoVideos = demoFrames
    .map((frame) => frame.querySelector<HTMLVideoElement>('[data-demo-video]'))
    .filter((video): video is HTMLVideoElement => Boolean(video));
  const demoVideoFrames = new Map<HTMLVideoElement, HTMLElement>();
  const demoPosterReleaseFrames = new WeakMap<HTMLVideoElement, number>();
  const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  let activeDemoVideo: HTMLVideoElement | null = null;
  let manualDemoVideo: HTMLVideoElement | null = null;
  // Reduced motion seeds the page-load default. The user can still opt into
  // playback with the same page-level play/pause control as everyone else.
  let isDemoPlaybackPaused = reducedMotionQuery.matches;
  let demoPlaybackFrame = 0;

  for (const frame of demoFrames) {
    const video = frame.querySelector<HTMLVideoElement>('[data-demo-video]');
    if (video) demoVideoFrames.set(video, frame);
  }

  function cancelDemoPosterRelease(video: HTMLVideoElement): void {
    const frame = demoPosterReleaseFrames.get(video);
    if (frame !== undefined) {
      window.cancelAnimationFrame(frame);
      demoPosterReleaseFrames.delete(video);
    }
  }

  function clearDemoVideoReady(video: HTMLVideoElement): void {
    cancelDemoPosterRelease(video);
    demoVideoFrames.get(video)?.removeAttribute('data-demo-video-ready');
  }

  function promoteDemoVideoPreload(video: HTMLVideoElement): void {
    if (video.preload !== 'auto') {
      video.preload = 'auto';
      video.load();
    }
  }

  function demoteDemoVideoPreload(video: HTMLVideoElement): void {
    if (video.preload !== 'metadata') video.preload = 'metadata';
  }

  function releaseDemoPosterAfterVideoPaint(video: HTMLVideoElement): void {
    const frame = demoVideoFrames.get(video);
    if (!frame || frame.hasAttribute('data-demo-video-ready')) return;
    if (demoPosterReleaseFrames.has(video)) return;

    const firstFrame = window.requestAnimationFrame(() => {
      const secondFrame = window.requestAnimationFrame(() => {
        demoPosterReleaseFrames.delete(video);
        if (
          video === activeDemoVideo &&
          !isDemoPlaybackPaused &&
          video.readyState >= DEMO_VIDEO_READY_STATE
        ) {
          frame.setAttribute('data-demo-video-ready', '');
        }
      });
      demoPosterReleaseFrames.set(video, secondFrame);
    });
    demoPosterReleaseFrames.set(video, firstFrame);
  }

  function resetDemoVideo(video: HTMLVideoElement): void {
    clearDemoVideoReady(video);
    video.pause();
    if (video.currentTime > 0.05) {
      try {
        video.currentTime = 0;
      } catch {
        // Some browsers can reject seeks before metadata is ready.
      }
    }
  }

  function focusScore(video: HTMLVideoElement): number {
    const rect = video.getBoundingClientRect();
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
    const visibleWidth = Math.max(0, Math.min(rect.right, viewportWidth) - Math.max(rect.left, 0));
    const visibleHeight = Math.max(
      0,
      Math.min(rect.bottom, viewportHeight) - Math.max(rect.top, 0),
    );
    const area = Math.max(1, rect.width * rect.height);
    const visibleRatio = (visibleWidth * visibleHeight) / area;

    if (visibleRatio < DEMO_VIDEO_MIN_VISIBLE_RATIO) return Number.NEGATIVE_INFINITY;

    const videoCenter = rect.top + rect.height / 2;
    const viewportCenter = viewportHeight / 2;
    const centerDistance = Math.abs(videoCenter - viewportCenter) / Math.max(1, viewportHeight);

    return visibleRatio - centerDistance * 0.25;
  }

  function focusedDemoVideo(): HTMLVideoElement | null {
    let best: HTMLVideoElement | null = null;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (const video of demoVideos) {
      const score = focusScore(video);
      if (score > bestScore) {
        best = video;
        bestScore = score;
      }
    }

    return best;
  }

  function demoFrameLabel(video: HTMLVideoElement, isPlaying: boolean): string {
    const videoLabel = video.getAttribute('aria-label') ?? 'demo video';
    return `${isPlaying ? 'Pause' : 'Play'}: ${videoLabel}`;
  }

  function updateDemoFrameStates(next: HTMLVideoElement | null): void {
    for (const video of demoVideos) {
      const frame = demoVideoFrames.get(video);
      if (!frame) continue;

      const isActive = video === next;
      const isPlaying = isActive && !isDemoPlaybackPaused;
      frame.toggleAttribute('data-demo-active', isActive);
      frame.toggleAttribute('data-demo-paused', isDemoPlaybackPaused);
      frame.setAttribute('aria-label', demoFrameLabel(video, isPlaying));
      frame.setAttribute('aria-pressed', String(isPlaying));
    }
  }

  function updateDemoPlayback(): void {
    demoPlaybackFrame = 0;

    if (document.visibilityState === 'hidden') {
      for (const video of demoVideos) resetDemoVideo(video);
      activeDemoVideo = null;
      updateDemoFrameStates(null);
      return;
    }

    const next = manualDemoVideo ?? focusedDemoVideo();
    for (const video of demoVideos) {
      if (video !== next) {
        demoteDemoVideoPreload(video);
        if (isDemoPlaybackPaused) {
          video.pause();
        } else {
          resetDemoVideo(video);
        }
      }
    }

    if (!next) {
      activeDemoVideo = null;
      updateDemoFrameStates(null);
      return;
    }

    promoteDemoVideoPreload(next);

    if (!isDemoPlaybackPaused && activeDemoVideo !== next && next.currentTime > 0.05) {
      try {
        next.currentTime = 0;
      } catch {
        // Metadata may not be ready yet; play() will start from the beginning.
      }
    }

    activeDemoVideo = next;
    updateDemoFrameStates(next);

    if (isDemoPlaybackPaused) {
      next.pause();
      return;
    }

    if (next.paused) {
      void next
        .play()
        .then(() => releaseDemoPosterAfterVideoPaint(next))
        .catch(() => {
          // Autoplay can still be blocked in unusual browser settings; leave controls hidden.
        });
    }
  }

  function clearManualDemoVideo(): void {
    manualDemoVideo = null;
    scheduleDemoPlaybackUpdate();
  }

  function toggleDemoVideo(video: HTMLVideoElement): void {
    if (isDemoPlaybackPaused) {
      isDemoPlaybackPaused = false;
      updateDemoPlayback();
      return;
    }

    if (video === activeDemoVideo) {
      manualDemoVideo = video;
      isDemoPlaybackPaused = true;
    } else {
      manualDemoVideo = video;
    }
    updateDemoPlayback();
  }

  function scheduleDemoPlaybackUpdate(): void {
    if (demoPlaybackFrame === 0) {
      demoPlaybackFrame = window.requestAnimationFrame(updateDemoPlayback);
    }
  }

  function addMediaQueryChangeListener(
    query: MediaQueryList,
    handler: (event: MediaQueryListEvent) => void,
  ): void {
    const legacyQuery = query as unknown as {
      readonly addListener?: (handler: (event: MediaQueryListEvent) => void) => void;
    };

    if (typeof query.addEventListener === 'function') {
      try {
        query.addEventListener('change', handler);
        return;
      } catch {
        // Older WebKit exposes addEventListener but only supports addListener.
      }
    }
    if (typeof legacyQuery.addListener === 'function') legacyQuery.addListener(handler);
  }

  if (demoVideos.length > 0) {
    if ('IntersectionObserver' in window) {
      const thresholds = Array.from({ length: 11 }, (_, i) => i / 10);
      const observer = new window.IntersectionObserver(scheduleDemoPlaybackUpdate, {
        threshold: thresholds,
      });
      for (const video of demoVideos) observer.observe(video);
    }

    for (const frame of demoFrames) {
      const video = frame.querySelector<HTMLVideoElement>('[data-demo-video]');
      if (!video) continue;

      video.addEventListener('playing', () => releaseDemoPosterAfterVideoPaint(video));
      video.addEventListener('timeupdate', () => releaseDemoPosterAfterVideoPaint(video));
      frame.addEventListener('click', () => toggleDemoVideo(video));
      frame.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          toggleDemoVideo(video);
        }
      });
      frame.setAttribute('aria-label', demoFrameLabel(video, false));
      frame.setAttribute('aria-pressed', 'false');
      frame.setAttribute('role', 'button');
      frame.tabIndex = 0;
    }

    window.addEventListener('scroll', clearManualDemoVideo, { passive: true });
    window.addEventListener('resize', scheduleDemoPlaybackUpdate);
    window.addEventListener('pageshow', scheduleDemoPlaybackUpdate);
    document.addEventListener('visibilitychange', scheduleDemoPlaybackUpdate);
    const handleReducedMotionChange = (event: MediaQueryListEvent): void => {
      if (event.matches) isDemoPlaybackPaused = true;
      scheduleDemoPlaybackUpdate();
    };
    addMediaQueryChangeListener(reducedMotionQuery, handleReducedMotionChange);
    scheduleDemoPlaybackUpdate();
  }
}
