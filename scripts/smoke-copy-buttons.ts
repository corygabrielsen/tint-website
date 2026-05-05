import { wireCopyButtons } from '../src/scripts/copy-buttons';

type ClickHandler = () => Promise<void> | void;

class FakeAnnounce {
  textContent = '';
}

class FakeButton {
  readonly dataset = { code: 'echo copied' };
  readonly announce = new FakeAnnounce();
  readonly attributes = new Set<string>();

  private clickHandler: ClickHandler | undefined;

  addEventListener(event: string, handler: ClickHandler): void {
    if (event === 'click') this.clickHandler = handler;
  }

  querySelector(selector: string): FakeAnnounce | null {
    return selector === '[data-copy-announce]' ? this.announce : null;
  }

  setAttribute(name: string): void {
    this.attributes.add(name);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  async click(): Promise<void> {
    if (!this.clickHandler) throw new Error('click handler not wired');
    await this.clickHandler();
  }
}

class TimerHarness {
  private nextId = 1;
  private callbacks = new Map<number, () => void>();

  setTimeout(callback: () => void): number {
    const id = this.nextId;
    this.nextId += 1;
    this.callbacks.set(id, callback);
    return id;
  }

  clearTimeout(id: number): void {
    this.callbacks.delete(id);
  }

  flush(): void {
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    callbacks.forEach((callback) => {
      callback();
    });
  }
}

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function pendingCopy(): {
  readonly promise: Promise<void>;
  readonly reject: (err: unknown) => void;
  readonly resolve: () => void;
} {
  let rejectFn: ((err: unknown) => void) | undefined;
  let resolveFn: (() => void) | undefined;
  const promise = new Promise<void>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  if (!rejectFn || !resolveFn) throw new Error('failed to create pending copy');
  return { promise, reject: rejectFn, resolve: resolveFn };
}

const button = new FakeButton();
const timers = new TimerHarness();
const originalConsoleError = console.error;

Object.defineProperty(globalThis, 'document', {
  configurable: true,
  value: {
    querySelectorAll: () => [button],
  },
});

Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: {
    clearTimeout: (id: number) => timers.clearTimeout(id),
    setTimeout: (callback: () => void) => timers.setTimeout(callback),
  },
});

type PendingCopy = ReturnType<typeof pendingCopy>;

let copy: PendingCopy | undefined;

function currentCopy(context: string): PendingCopy {
  if (!copy) throw new Error(`${context}: clipboard write was not attempted`);
  return copy;
}

Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: {
    clipboard: {
      writeText: () => {
        copy = pendingCopy();
        return copy.promise;
      },
    },
  },
});

wireCopyButtons('[data-copy]');
console.error = () => {};

copy = undefined;
const successClick = button.click();
currentCopy('success').resolve();
await successClick;
check(button.hasAttribute('data-copied'), 'success: missing copied state');
check(button.announce.textContent === 'Copied', 'success: copied announcement missing');

copy = undefined;
const failureAfterSuccessClick = button.click();
check(!button.hasAttribute('data-copied'), 'failure after success: copied state was stale');
check(
  button.announce.textContent === '',
  'failure after success: announcement was not cleared before retry',
);
currentCopy('failure after success').reject(new Error('denied'));
await failureAfterSuccessClick;
check(!button.hasAttribute('data-copied'), 'failure after success: copied state returned');
check(
  button.announce.textContent === 'Copy failed',
  'failure after success: failure announcement missing',
);

copy = undefined;
const consecutiveFailureClick = button.click();
check(
  button.announce.textContent === '',
  'consecutive failure: previous failure announcement was not cleared before retry',
);
currentCopy('consecutive failure').reject(new Error('still denied'));
await consecutiveFailureClick;
check(
  button.announce.textContent === 'Copy failed',
  'consecutive failure: failure announcement missing',
);

timers.flush();
check(!button.hasAttribute('data-copied'), 'reset timer: copied state was not cleared');
check(button.announce.textContent === '', 'reset timer: announcement was not cleared');

console.error = originalConsoleError;
console.log('copy-button smoke test passed');
