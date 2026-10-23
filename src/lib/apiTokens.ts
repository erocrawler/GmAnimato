import { createHash, randomBytes } from 'node:crypto';
import type { ApiToken } from './IDatabase';

/**
 * Personal access tokens (PAT) for the video-creation flow.
 *
 * Design rules (decided by the site owner):
 * - A PAT may only drive the video flow (see TOKEN_ROUTE_ALLOWLIST). It can
 *   never change profile data, manage tokens, log in/out, or reach admin routes.
 * - Every token expires: 7, 30 or 90 days (default 30). No "never expires",
 *   no auto-renewal — to renew, create a new one on the profile page.
 * - Only the SHA-256 hash is stored; the secret is shown once at creation.
 * - Token management itself (create/list/revoke) requires a cookie session.
 *
 * This module is pure (no $env / DB imports) so it can be unit-tested directly.
 */

export const TOKEN_PREFIX = 'anim_pat_';
/** Length of the display prefix: first N chars of the random part. */
export const TOKEN_DISPLAY_PREFIX_LENGTH = 8;
export const TOKEN_RANDOM_BYTES = 32; // -> 43 base64url chars (>= 32 required)
export const ALLOWED_EXPIRY_DAYS = [7, 30, 90] as const;
export type TokenExpiryDays = (typeof ALLOWED_EXPIRY_DAYS)[number];
export const DEFAULT_EXPIRY_DAYS: TokenExpiryDays = 30;
export const MAX_ACTIVE_TOKENS_PER_USER = 5;
export const MAX_TOKEN_NAME_LENGTH = 50;
/** last_used_at is only rewritten when older than this, to avoid a DB write per request. */
export const TOUCH_INTERVAL_MS = 60_000;

export type GeneratedToken = { token: string; prefix: string; hash: string };

export function generateApiToken(): GeneratedToken {
  const random = randomBytes(TOKEN_RANDOM_BYTES).toString('base64url');
  const token = TOKEN_PREFIX + random;
  return { token, prefix: random.slice(0, TOKEN_DISPLAY_PREFIX_LENGTH), hash: hashApiToken(token) };
}

export function hashApiToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** True when a raw Bearer value looks like a PAT (routes it to PAT validation instead of JWT). */
export function isApiTokenString(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(TOKEN_PREFIX);
}

/** Extract the Bearer credential from an Authorization header, if any. */
export function parseBearer(authHeader: string | null | undefined): string | null {
  if (!authHeader) return null;
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

export type TokenState = 'active' | 'expired' | 'revoked';

export function getTokenState(t: Pick<ApiToken, 'expires_at' | 'revoked_at'>, now: Date = new Date()): TokenState {
  if (t.revoked_at) return 'revoked';
  if (new Date(t.expires_at).getTime() <= now.getTime()) return 'expired';
  return 'active';
}

export function countActiveTokens(tokens: Pick<ApiToken, 'expires_at' | 'revoked_at'>[], now: Date = new Date()): number {
  return tokens.filter((t) => getTokenState(t, now) === 'active').length;
}

export function validateTokenName(raw: unknown): { ok: true; name: string } | { ok: false; error: string } {
  if (typeof raw !== 'string') return { ok: false, error: 'name is required' };
  const name = raw.trim();
  if (!name) return { ok: false, error: 'name is required' };
  if (name.length > MAX_TOKEN_NAME_LENGTH) {
    return { ok: false, error: `name must be at most ${MAX_TOKEN_NAME_LENGTH} characters` };
  }
  return { ok: true, name };
}

/** expiresInDays must be exactly one of 7/30/90; absent means the default (30). */
export function parseExpiresInDays(raw: unknown): TokenExpiryDays | null {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_EXPIRY_DAYS;
  const n = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw;
  return (ALLOWED_EXPIRY_DAYS as readonly unknown[]).includes(n) ? (n as TokenExpiryDays) : null;
}

export function computeExpiry(days: TokenExpiryDays, now: Date = new Date()): Date {
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// Scope allowlist (method + path). Everything not listed is refused with 403.
// ---------------------------------------------------------------------------

type Rule = { methods: readonly string[]; pattern: RegExp };

const ID = '[^/]+';
const GET_ONLY = ['GET', 'HEAD'] as const;
const POST_ONLY = ['POST'] as const;

export const TOKEN_ROUTE_ALLOWLIST: readonly Rule[] = [
  // read-only
  { methods: GET_ONLY, pattern: /^\/api\/quota$/ },
  { methods: GET_ONLY, pattern: /^\/api\/auth\/session$/ }, // whoami (email stripped for tokens)
  { methods: GET_ONLY, pattern: /^\/api\/workflows$/ },
  { methods: GET_ONLY, pattern: /^\/api\/videos$/ },
  { methods: GET_ONLY, pattern: new RegExp(`^/api/video/${ID}$`) },
  { methods: GET_ONLY, pattern: new RegExp(`^/api/video/${ID}/status$`) },
  { methods: GET_ONLY, pattern: new RegExp(`^/api/video/${ID}/download$`) },
  { methods: GET_ONLY, pattern: /^\/media\/.+$/ },
  // video-creation flow
  { methods: POST_ONLY, pattern: /^\/api\/uploads$/ },
  { methods: POST_ONLY, pattern: /^\/api\/video\/update$/ },
  { methods: POST_ONLY, pattern: /^\/api\/i2v\/kickoff$/ },
  { methods: POST_ONLY, pattern: new RegExp(`^/api/video/${ID}/reopen$`) },
  { methods: POST_ONLY, pattern: new RegExp(`^/api/video/${ID}/retry$`) },
  { methods: POST_ONLY, pattern: /^\/api\/video\/reuse$/ },
  { methods: POST_ONLY, pattern: /^\/api\/video\/resolve-ref$/ },
];

/**
 * Human-readable list for docs / the 403 body. Keep in sync with
 * TOKEN_ROUTE_ALLOWLIST (a unit test asserts every entry is accepted).
 */
export const TOKEN_ALLOWED_ENDPOINTS = [
  'GET /api/quota',
  'GET /api/auth/session',
  'GET /api/workflows',
  'GET /api/videos',
  'GET /api/video/{id}',
  'GET /api/video/{id}/status',
  'GET /api/video/{id}/download',
  'GET /media/**',
  'POST /api/uploads',
  'POST /api/video/update',
  'POST /api/i2v/kickoff',
  'POST /api/video/{id}/reopen',
  'POST /api/video/{id}/retry',
  'POST /api/video/reuse',
  'POST /api/video/resolve-ref',
] as const;

export function isRouteAllowedForToken(method: string, pathname: string): boolean {
  const m = method.toUpperCase();
  return TOKEN_ROUTE_ALLOWLIST.some((r) => r.methods.includes(m) && r.pattern.test(pathname));
}

/** Requests that count against the stricter 10/min bucket. */
export function isHeavyTokenRoute(method: string, pathname: string): boolean {
  return method.toUpperCase() === 'POST' && (pathname === '/api/uploads' || pathname === '/api/i2v/kickoff');
}

/** Shape returned by the management API / profile page — never includes the hash. */
export function toPublicToken(t: ApiToken, now: Date = new Date()) {
  return {
    id: t.id,
    name: t.name,
    prefix: t.prefix,
    display: `${TOKEN_PREFIX}${t.prefix}…`,
    created_at: t.created_at,
    expires_at: t.expires_at,
    last_used_at: t.last_used_at ?? null,
    revoked_at: t.revoked_at ?? null,
    status: getTokenState(t, now),
  };
}
