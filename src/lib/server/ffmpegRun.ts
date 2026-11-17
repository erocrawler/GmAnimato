import { spawn } from 'child_process';
import { promises as fs } from 'fs';

export class FfmpegTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`ffmpeg timed out after ${timeoutMs}ms`);
    this.name = 'FfmpegTimeoutError';
  }
}

export interface RunFfmpegOptions {
  timeoutMs: number;
  /** Binary to run; overridable for tests. */
  bin?: string;
}

/**
 * Run ffmpeg writing to `tmpPath`. On timeout the process is SIGKILLed, `tmpPath` is
 * removed and FfmpegTimeoutError is thrown. Non-zero exit / spawn failure also removes
 * `tmpPath`. The timer covers only the process run time (the caller acquires the
 * concurrency slot before calling this).
 */
export function runFfmpeg(args: string[], tmpPath: string, opts: RunFfmpegOptions): Promise<void> {
  const { timeoutMs, bin = 'ffmpeg' } = opts;
  return new Promise<void>((resolve, reject) => {
    const errChunks: Buffer[] = [];
    let timedOut = false;
    let settled = false;
    const proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
    }, timeoutMs);

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fs.unlink(tmpPath).catch(() => {/* ignore */}).then(() => reject(err));
    };

    proc.stderr?.on('data', (chunk: Buffer) => {
      errChunks.push(chunk);
      // keep only a bounded tail
      if (errChunks.length > 50) errChunks.splice(0, errChunks.length - 50);
    });
    proc.on('close', (code) => {
      if (settled) return;
      if (timedOut) return fail(new FfmpegTimeoutError(timeoutMs));
      if (code === 0) {
        settled = true;
        clearTimeout(timer);
        resolve();
      } else {
        const stderr = Buffer.concat(errChunks).toString();
        fail(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-500)}`));
      }
    });
    proc.on('error', (err) => fail(new Error(`Failed to spawn ffmpeg: ${err.message}`)));
  });
}
