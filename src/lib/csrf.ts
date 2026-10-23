/**
 * Origin check for cross-site form submissions.
 *
 * SvelteKit's built-in `csrf.checkOrigin` runs inside `respond()` BEFORE the
 * `handle` hook, so a hook cannot exempt a request from it. To let API-token
 * clients upload multipart bodies without faking an `Origin` header, the
 * built-in check is disabled in svelte.config.js and this function reproduces
 * it one-to-one (same content types, same methods, same comparison, dev skip)
 * and is called from the `handle` hook for every request except authenticated
 * token requests.
 *
 * Why skipping for PAT requests is safe: CSRF relies on the browser attaching
 * ambient credentials (cookies). PAT requests are authenticated only by an
 * explicit `Authorization: Bearer anim_pat_…` header, which a cross-site form
 * cannot set; the hook ignores cookies entirely when such a header is present.
 */

const FORM_CONTENT_TYPES = new Set([
  'application/x-www-form-urlencoded',
  'multipart/form-data',
  'text/plain',
  'application/x-sveltekit-formdata',
]);

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function isFormContentType(contentType: string | null | undefined): boolean {
  const type = contentType?.split(';', 1)[0].trim() ?? '';
  return FORM_CONTENT_TYPES.has(type.toLowerCase());
}

/** True when the request must be refused as a cross-site form submission. */
export function isCrossSiteFormSubmission(
  req: { method: string; headers: Headers },
  serverOrigin: string,
  opts: { dev?: boolean } = {}
): boolean {
  if (opts.dev) return false; // SvelteKit only enforces this in production
  if (!MUTATING_METHODS.has(req.method.toUpperCase())) return false;
  if (!isFormContentType(req.headers.get('content-type'))) return false;
  return req.headers.get('origin') !== serverOrigin;
}
