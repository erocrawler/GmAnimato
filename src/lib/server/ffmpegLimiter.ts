/**
 * Process-wide limiter for expensive ffmpeg jobs: at most `maxConcurrent` run at once,
 * up to `maxQueue` more wait in FIFO order, anything beyond that is rejected immediately
 * with FfmpegQueueFullError (the route turns it into 429 + Retry-After).
 */
export class FfmpegQueueFullError extends Error {
  constructor(public readonly retryAfterSeconds: number) {
    super('ffmpeg queue is full');
    this.name = 'FfmpegQueueFullError';
  }
}

export class FfmpegLimiter {
  private active = 0;
  private waiters: Array<() => void> = [];

  constructor(
    readonly maxConcurrent: number,
    readonly maxQueue: number,
    readonly retryAfterSeconds = 30,
  ) {}

  get activeCount(): number {
    return this.active;
  }
  get queuedCount(): number {
    return this.waiters.length;
  }

  /** Resolves with an idempotent release function once a slot is held. */
  acquire(): Promise<() => void> {
    if (this.active < this.maxConcurrent) {
      this.active++;
      return Promise.resolve(this.makeRelease());
    }
    if (this.waiters.length >= this.maxQueue) {
      return Promise.reject(new FfmpegQueueFullError(this.retryAfterSeconds));
    }
    return new Promise((resolve) => {
      // the slot is handed over directly (active is not decremented in between)
      this.waiters.push(() => resolve(this.makeRelease()));
    });
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next();
      else this.active--;
    };
  }
}
