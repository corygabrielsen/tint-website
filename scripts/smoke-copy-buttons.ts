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

let copies: PendingCopy[] = [];

function nextCopy(context: string): PendingCopy {
  const copy = copies.shift();
  if (!copy) throw new Error(`${context}: clipboard write was not attempted`);
  return copy;
}

Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: {
    clipboard: {
      writeText: () => {
        const copy = pendingCopy();
        copies.push(copy);
        return copy.promise;
      },
    },
  },
});

wireCopyButtons('[data-copy]');
console.error = () => {};

copies = [];
const successClick = button.click();
nextCopy('success').resolve();
await successClick;
check(button.hasAttribute('data-copied'), 'success: missing copied state');
check(button.announce.textContent === 'Copied', 'success: copied announcement missing');

copies = [];
const failureAfterSuccessClick = button.click();
check(!button.hasAttribute('data-copied'), 'failure after success: copied state was stale');
check(
  button.announce.textContent === '',
  'failure after success: announcement was not cleared before retry',
);
nextCopy('failure after success').reject(new Error('denied'));
await failureAfterSuccessClick;
check(!button.hasAttribute('data-copied'), 'failure after success: copied state returned');
check(
  button.announce.textContent === 'Copy failed',
  'failure after success: failure announcement missing',
);

copies = [];
const consecutiveFailureClick = button.click();
check(
  button.announce.textContent === '',
  'consecutive failure: previous failure announcement was not cleared before retry',
);
nextCopy('consecutive failure').reject(new Error('still denied'));
await consecutiveFailureClick;
check(
  button.announce.textContent === 'Copy failed',
  'consecutive failure: failure announcement missing',
);

copies = [];
const staleFailureClick = button.click();
const staleFailure = nextCopy('stale failure');
const freshSuccessClick = button.click();
const freshSuccess = nextCopy('fresh success');
freshSuccess.resolve();
await freshSuccessClick;
check(button.hasAttribute('data-copied'), 'fresh success: copied state missing');
check(button.announce.textContent === 'Copied', 'fresh success: copied announcement missing');
staleFailure.reject(new Error('late denied'));
await staleFailureClick;
check(
  button.hasAttribute('data-copied'),
  'stale failure: older failure cleared newer success state',
);
check(
  button.announce.textContent === 'Copied',
  'stale failure: older failure overwrote newer success announcement',
);

copies = [];
const staleSuccessClick = button.click();
const staleSuccess = nextCopy('stale success');
const freshFailureClick = button.click();
const freshFailure = nextCopy('fresh failure');
freshFailure.reject(new Error('newer denied'));
await freshFailureClick;
check(!button.hasAttribute('data-copied'), 'fresh failure: copied state returned');
check(button.announce.textContent === 'Copy failed', 'fresh failure: failure announcement missing');
staleSuccess.resolve();
await staleSuccessClick;
check(!button.hasAttribute('data-copied'), 'stale success: older success set copied state');
check(
  button.announce.textContent === 'Copy failed',
  'stale success: older success overwrote newer failure announcement',
);

timers.flush();
check(!button.hasAttribute('data-copied'), 'reset timer: copied state was not cleared');
check(button.announce.textContent === '', 'reset timer: announcement was not cleared');

console.error = originalConsoleError;
console.log('copy-button smoke test passed');
