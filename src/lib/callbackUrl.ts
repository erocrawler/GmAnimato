import { env } from '$env/dynamic/private';
import { isSafeMediaPath } from '$lib/mediaPath';

/**
 * Validation of the result-video address a worker reports in its completion
 * callback (POST /api/i2v-webhook/[id]). The callback is authenticated only by
 * the job id, so the address must never be taken at face value: it ends up in
 * `final_video_url`, which pages render and the server later probes.
 *
 * Accepted:
 *   - an object under our own S3 endpoint (`S3_ENDPOINT + '/'` prefix) -> stored
 *     as the proxied `/media/{bucket}/{key}` path (same conversion as toProxiedUrl);
 *   - a safe in-site `/media/...` path as-is;
 *   - an absolute http(s) URL under one of the extra trusted prefixes listed in
 *     `S3_ALLOWED_URL_PREFIXES` (comma separated; for workers whose public bucket
 *     address differs from the site's S3_ENDPOINT) -> stored as-is.
 * Anything else yields null.
 */
export function resolveCallbackVideoUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const url = raw.trim();
  if (!url) return null;

  // isSafeMediaPath is a type predicate; test through `unknown` so the false branch keeps `url: string`.
  if (isSafeMediaPath(url as unknown)) return url;

  const s3Endpoint = (env.S3_ENDPOINT || '').trim().replace(/\/+$/, '');
  if (s3Endpoint && url.startsWith(s3Endpoint + '/')) {
    const proxied = `/media${url.slice(s3Endpoint.length)}`;
    return isSafeMediaPath(proxied) ? proxied : null;
  }

  if (!/^https?:\/\//i.test(url) || /[\s\\]/.test(url) || /(^|\/)\.\.?(\/|$|\?|#)/.test(url.replace(/^https?:\/\/[^/]*/i, ''))) {
    return null;
  }
  for (const prefix of extraTrustedPrefixes()) {
    if (url.startsWith(prefix) && url.length > prefix.length) return url;
  }
  return null;
}

function extraTrustedPrefixes(): string[] {
  return (env.S3_ALLOWED_URL_PREFIXES || '')
    .split(',')
    .map((p) => p.trim())
    .filter((p) => /^https?:\/\/[^/\s]+/i.test(p))
    // Trailing slash keeps `https://cdn.example` from matching `https://cdn.example.evil.test`.
    .map((p) => (p.endsWith('/') ? p : p + '/'));
}

/** Host of a rejected address for log lines — never the path or query string (may carry signatures). */
export function describeRejectedHost(raw: unknown): string {
  if (typeof raw !== 'string') return '(not a string)';
  try {
    return new URL(raw.trim()).host || '(no host)';
  } catch {
    return raw.trim().startsWith('/') ? '(relative path)' : '(unparseable)';
  }
}
