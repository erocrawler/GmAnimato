import { promises as fs } from 'fs';
import { join } from 'path';

export interface DownloadCacheOptions {
  dir: string;
  /** A cache file older than this is considered stale (not served). */
  ttlMs: number;
  /** Finished files older than this are deleted by the sweep (should be > ttlMs). */
  maxAgeMs: number;
  /** Leftover `.tmp` files older than this are deleted (should be > ffmpeg timeout). */
  tmpMaxAgeMs: number;
}

/**
 * Disk cache for converted downloads, plus age-based cleanup. The sweep never touches
 * files that are currently being generated (busy temp paths) or being streamed to a client
 * (read leases).
 */
export class DownloadCache {
  private busy = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(readonly opts: DownloadCacheOptions) {}

  async ensureDir(): Promise<void> {
    await fs.mkdir(this.opts.dir, { recursive: true }).catch(() => {/* ignore */});
  }

  filePath(id: string, format: string, fps: number, scale: number): string {
    return join(this.opts.dir, `${id}_${format}_${fps}_${scale}`);
  }

  /** Returns the path if it exists and is within TTL. */
  async fresh(path: string, now = Date.now()): Promise<string | null> {
    try {
      const st = await fs.stat(path);
      return now - st.mtimeMs > this.opts.ttlMs ? null : path;
    } catch {
      return null;
    }
  }

  /** Mark `path` (and its `.tmp` sibling) as in use; returns an idempotent release. */
  hold(path: string): () => void {
    this.busy.set(path, (this.busy.get(path) ?? 0) + 1);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const n = (this.busy.get(path) ?? 1) - 1;
      if (n <= 0) this.busy.delete(path);
      else this.busy.set(path, n);
    };
  }

  private isBusy(path: string): boolean {
    if (this.busy.has(path)) return true;
    return path.endsWith('.tmp') && this.busy.has(path.slice(0, -4));
  }

  /** Delete aged files. Returns the number removed. Never throws. */
  async sweep(now = Date.now()): Promise<number> {
    let removed = 0;
    let names: string[];
    try {
      names = await fs.readdir(this.opts.dir);
    } catch {
      return 0;
    }
    for (const name of names) {
      const path = join(this.opts.dir, name);
      if (this.isBusy(path)) continue;
      try {
        const st = await fs.stat(path);
        if (!st.isFile()) continue;
        const limit = name.endsWith('.tmp') ? this.opts.tmpMaxAgeMs : this.opts.maxAgeMs;
        if (now - st.mtimeMs <= limit) continue;
        // re-check: a lease may have been taken while we were awaiting stat
        if (this.isBusy(path)) continue;
        await fs.unlink(path);
        removed++;
      } catch {
        /* vanished or unreadable: ignore */
      }
    }
    return removed;
  }

  /** Sweep now and then every `intervalMs`; the timer does not keep the process alive. */
  startSweeper(intervalMs: number): void {
    if (this.timer) return;
    void this.sweep();
    this.timer = setInterval(() => void this.sweep(), intervalMs);
    this.timer.unref?.();
  }

  stopSweeper(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
