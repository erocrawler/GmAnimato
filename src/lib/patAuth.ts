import type { ApiToken, User } from './IDatabase';
import {
  getTokenState,
  hashApiToken,
  isApiTokenString,
  isHeavyTokenRoute,
  isRouteAllowedForToken,
  parseBearer,
  TOUCH_INTERVAL_MS,
  TOKEN_ALLOWED_ENDPOINTS,
} from './apiTokens';
import type { TokenRateLimiter } from './rateLimit';

/**
 * PAT request handling used by hooks.server.ts. Kept free of $env / SvelteKit
 * imports and fed with injected deps so it can be unit-tested.
 */

export type PatDeps = {
  getApiTokenByHash(hash: string): Promise<ApiToken | undefined>;
  getUserById(id: string): Promise<User | undefined>;
  touchApiToken(id: string, usedAt: Date): Promise<void>;
};

export function jsonError(status: number, error: string, errorCode: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error, errorCode }), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

export type PatAuthResult =
  | { ok: true; token: ApiToken; user: User }
  | { ok: false; response: Response };

/** Validate a raw `anim_pat_…` string: hash lookup, expiry, revocation, owner still exists. */
export async function authenticatePat(raw: string, deps: PatDeps, now: Date = new Date()): Promise<PatAuthResult> {
  const record = await deps.getApiTokenByHash(hashApiToken(raw));
  if (!record) {
    return { ok: false, response: jsonError(401, 'Invalid API token', 'invalid_token') };
  }
  const state = getTokenState(record, now);
  if (state === 'revoked') {
    return { ok: false, response: jsonError(401, 'API token has been revoked', 'token_revoked') };
  }
  if (state === 'expired') {
    return {
      ok: false,
      response: jsonError(401, 'API token has expired; create a new one on the profile page', 'token_expired'),
    };
  }
  const user = await deps.getUserById(record.user_id);
  if (!user) {
    return { ok: false, response: jsonError(401, 'Invalid API token', 'invalid_token') };
  }
  const last = record.last_used_at ? new Date(record.last_used_at).getTime() : 0;
  if (now.getTime() - last > TOUCH_INTERVAL_MS) {
    try {
      await deps.touchApiToken(record.id, now);
    } catch (err) {
      console.error('[PAT] failed to update last_used_at:', err);
    }
  }
  return { ok: true, token: record, user };
}

export type PatGateInput = {
  authorization: string | null;
  method: string;
  pathname: string;
  isDataRequest?: boolean;
};

export type PatGateResult =
  | { kind: 'not-pat' } // no PAT in the request: continue with the normal cookie/JWT flow
  | { kind: 'reject'; response: Response }
  | { kind: 'ok'; token: ApiToken; user: User };

/**
 * Order matters: authenticate (401) → scope allowlist (403) → rate limit (429).
 * A PAT request never falls through to cookie handling.
 */
export async function gatePatRequest(
  input: PatGateInput,
  deps: PatDeps,
  limiter: TokenRateLimiter,
  now: Date = new Date()
): Promise<PatGateResult> {
  const bearer = parseBearer(input.authorization);
  if (!isApiTokenString(bearer)) return { kind: 'not-pat' };

  const auth = await authenticatePat(bearer as string, deps, now);
  if (!auth.ok) return { kind: 'reject', response: auth.response };

  if (input.isDataRequest || !isRouteAllowedForToken(input.method, input.pathname)) {
    return {
      kind: 'reject',
      response: new Response(
        JSON.stringify({
          error: 'This API token is not allowed to access this endpoint',
          errorCode: 'token_scope',
          allowed: TOKEN_ALLOWED_ENDPOINTS,
        }),
        { status: 403, headers: { 'Content-Type': 'application/json' } }
      ),
    };
  }

  const limit = limiter.check(auth.token.id, isHeavyTokenRoute(input.method, input.pathname));
  if (!limit.allowed) {
    return {
      kind: 'reject',
      response: jsonError(429, 'Rate limit exceeded for this API token', 'rate_limited', {
        'Retry-After': String(limit.retryAfterSeconds),
      }),
    };
  }

  return { kind: 'ok', token: auth.token, user: auth.user };
}

/**
 * Should an unauthenticated /api/** request get a 401 JSON instead of the
 * browser-oriented 303 → /login? Only for programmatic clients (Authorization
 * header or Accept: application/json); page navigations keep redirecting.
 */
export function wantsJsonUnauthorized(pathname: string, headers: Headers): boolean {
  if (!pathname.startsWith('/api/')) return false;
  if (headers.get('authorization')) return true;
  return (headers.get('accept') ?? '').toLowerCase().includes('application/json');
}
