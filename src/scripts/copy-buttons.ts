const DEFAULT_COPY_RESET_MS = 1500;
const copyTimers = new WeakMap<HTMLButtonElement, number>();

interface CopyButtonOptions {
  readonly resetMs?: number;
  readonly errorPrefix?: string;
}

export function wireCopyButtons(selector: string, options: CopyButtonOptions = {}): void {
  const resetMs = options.resetMs ?? DEFAULT_COPY_RESET_MS;
  const errorPrefix = options.errorPrefix ?? 'Clipboard write failed';

  document.querySelectorAll<HTMLButtonElement>(selector).forEach((btn) => {
    const announce = btn.querySelector<HTMLSpanElement>('[data-copy-announce]');

    btn.addEventListener('click', async () => {
      const text = btn.dataset.code ?? '';
      let success = false;
      try {
        await navigator.clipboard.writeText(text);
        success = true;
      } catch (err) {
        console.error(`${errorPrefix}:`, err);
      }

      if (success) {
        btn.setAttribute('data-copied', '');
        if (announce) announce.textContent = 'Copied';
      } else if (announce) {
        announce.textContent = 'Copy failed';
      }

      const prev = copyTimers.get(btn);
      if (prev !== undefined) window.clearTimeout(prev);
      copyTimers.set(
        btn,
        window.setTimeout(() => {
          btn.removeAttribute('data-copied');
          if (announce) announce.textContent = '';
        }, resetMs),
      );
    });
  });
}
