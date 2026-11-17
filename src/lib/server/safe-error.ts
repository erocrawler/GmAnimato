/**
 * "Log the detail, answer with a fixed message."
 *
 * Raw exception text (`String(err)` / `err.message`) can carry SQL fragments,
 * file paths, upstream URLs/hostnames, stack frames or library internals. None of
 * that belongs in an HTTP response body or in a DB column a user can read. Route
 * handlers use these helpers so the full error goes to the server log only and the
 * client only ever sees a stable, localized string.
 */

/** Default user-facing message for an unexpected server-side failure. */
export const GENERIC_ERROR_MESSAGE = '服务器内部错误,请稍后重试';

/**
 * Log `err` (with its stack) under `tag` and return the user-safe message.
 * Use this when the message is stored or composed into a larger payload rather
 * than returned as a whole Response.
 */
export function safeErrorMessage(tag: string, err: unknown, message: string = GENERIC_ERROR_MESSAGE): string {
  console.error(tag, err);
  return message;
}

export interface JsonServerErrorOptions {
  /** HTTP status; defaults to 500. Pass the status the route already used. */
  status?: number;
  /** Fixed user-facing message; defaults to GENERIC_ERROR_MESSAGE. */
  message?: string;
  /** Extra static fields merged into the body (e.g. `{ available: false }`). Never put error text here. */
  extra?: Record<string, unknown>;
  /** Extra response headers. */
  headers?: Record<string, string>;
}

/**
 * Log `err` under `tag` and build a JSON error Response carrying only the fixed
 * message: `{ ...extra, error: message }`.
 */
export function jsonServerError(tag: string, err: unknown, options: JsonServerErrorOptions = {}): Response {
  const { status = 500, message = GENERIC_ERROR_MESSAGE, extra, headers } = options;
  console.error(tag, err);
  return new Response(JSON.stringify({ ...(extra ?? {}), error: message }), {
    status,
    headers: { 'Content-Type': 'application/json', ...(headers ?? {}) },
  });
}
