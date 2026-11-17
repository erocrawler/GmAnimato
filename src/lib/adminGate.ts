/**
 * Path canonicalisation for the admin gate in hooks.server.ts.
 *
 * SvelteKit routes on the decoded pathname, so `/api/%61dmin/x` reaches the
 * `/api/admin/x` handler while a raw `startsWith('/api/admin')` check misses it.
 * The gate therefore tests a canonical form: percent-decoding (repeated until
 * stable, so double-encoding cannot hide a prefix), duplicate slashes collapsed,
 * trailing slashes removed. A path that cannot be decoded is treated as an admin
 * path (fail closed). The public-route allowlist keeps using the raw path.
 */
export function canonicalizeGatePath(pathname: string): string | null {
  let p = pathname;
  for (let i = 0; i < 5; i++) {
    let next: string;
    try {
      next = decodeURIComponent(p);
    } catch {
      return null;
    }
    if (next === p) break;
    p = next;
  }
  p = p.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  return p === '' ? '/' : p;
}

/** True when the request path must pass the admin role check. Undecodable paths are gated. */
export function isAdminGatedPath(pathname: string): boolean {
  const p = canonicalizeGatePath(pathname);
  if (p === null) return true;
  return p.startsWith('/admin') || p.startsWith('/api/admin');
}
