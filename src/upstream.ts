import { USER_AGENT } from './config.ts';

/** Too many requests are waiting for an upstream service. */
export class OverloadedError extends Error {}

/** An upstream server failed or answered with an error. */
export class UpstreamError extends Error {}

const MAX_QUEUED = 100;

interface UpstreamOptions {
  concurrency: number;
  queueTimeoutMs: number;
  requestTimeoutMs: number;
}

/**
 * Requests to an upstream service, at most `concurrency` at a time. Up to MAX_QUEUED more wait up to
 * `queueTimeoutMs`; beyond that, requests fail fast instead of finishing after their client gave up.
 */
export class Upstream {
  readonly #options: UpstreamOptions;
  readonly #queue: Array<() => void> = [];
  #active = 0;

  constructor(options: UpstreamOptions) {
    this.#options = options;
  }

  /**
   * fetch() with the add-on's user agent. Network failures, 429 and 5xx, and errors thrown by `read`
   * reject with UpstreamError; an unread body is discarded.
   */
  fetch<T>(url: string | URL, init: { method?: string; headers?: Record<string, string>; body?: string }, read: (res: Response) => Promise<T>): Promise<T> {
    return this.run(async () => {
      const { host } = new URL(url);
      try {
        const res = await fetch(url, {
          ...init,
          headers: { ...init.headers, 'user-agent': USER_AGENT },
          signal: AbortSignal.timeout(this.#options.requestTimeoutMs),
        });
        try {
          if (res.status === 429 || res.status >= 500) throw new UpstreamError(`${host} responded ${res.status}`);
          return await read(res);
        } finally {
          if (!res.bodyUsed) await res.body?.cancel();
        }
      } catch (err) {
        throw err instanceof UpstreamError ? err : new UpstreamError(`request to ${host} failed: ${err}`, { cause: err });
      }
    });
  }

  /** Runs `task` in a free slot. Rejects with OverloadedError when the queue is full or the wait too long. */
  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.#acquire();
    try {
      return await task();
    } finally {
      // Hand the slot straight to the next waiter.
      const next = this.#queue.shift();
      if (next) next();
      else this.#active--;
    }
  }

  async #acquire(): Promise<void> {
    if (this.#active < this.#options.concurrency) {
      this.#active++;
      return;
    }
    if (this.#queue.length >= MAX_QUEUED) throw new OverloadedError('too many queued requests');
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const start = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      this.#queue.splice(this.#queue.indexOf(start), 1);
      reject(new OverloadedError('queued too long'));
    }, this.#options.queueTimeoutMs);
    this.#queue.push(start);
    await promise;
  }
}
