/**
 * Strict handling of in-site media references (`/media/{bucket}/{key}`).
 *
 * Used where a client-supplied URL ends up being fetched/probed by the server
 * (ref videos for ref2v): only paths under our own media proxy are accepted,
 * never arbitrary external URLs and never traversal tricks.
 */

const ABS_MEDIA_RE = /^https?:\/\/[^/]+\/(media\/.+)$/i;
const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;
const MAX_MEDIA_PATH_LENGTH = 300;

/** True for `/media/a/b.mp4`-style paths: plain segments only, no `.`/`..`, no query, no encoding. */
export function isSafeMediaPath(path: unknown): path is string {
  if (typeof path !== 'string' || path.length > MAX_MEDIA_PATH_LENGTH) return false;
  if (!path.startsWith('/media/')) return false;
  const segments = path.slice('/media/'.length).split('/');
  if (segments.length < 1) return false;
  return segments.every((s) => s !== '.' && s !== '..' && SEGMENT_RE.test(s));
}

/**
 * Normalise a client-supplied reference to a safe `/media/...` path, or null.
 * Accepts `/media/...` directly or an absolute URL whose path is `/media/...`
 * (same normalisation the /new form applies); everything else is rejected.
 */
export function normalizeMediaRef(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  const abs = trimmed.match(ABS_MEDIA_RE);
  const candidate = abs ? `/${abs[1]}` : trimmed;
  return isSafeMediaPath(candidate) ? candidate : null;
}
