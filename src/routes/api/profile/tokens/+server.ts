import type { RequestHandler } from '@sveltejs/kit';
import { createApiToken, listApiTokensByUser } from '$lib/db';
import {
  computeExpiry,
  countActiveTokens,
  generateApiToken,
  MAX_ACTIVE_TOKENS_PER_USER,
  parseExpiresInDays,
  toPublicToken,
  validateTokenName,
} from '$lib/apiTokens';
import { jsonError } from '$lib/patAuth';

/**
 * Token management is cookie-session only. The hook already refuses PAT
 * requests to /api/profile/** (403); the `locals.token` checks below are a
 * second line of defence in case the allowlist ever changes.
 */

const NO_STORE = { 'Cache-Control': 'no-store' };

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user) return jsonError(401, 'Unauthorized', 'unauthenticated');
  if (locals.token) return jsonError(403, 'Tokens cannot manage tokens', 'token_scope');

  const now = new Date();
  const tokens = await listApiTokensByUser(locals.user.id);
  return new Response(JSON.stringify({ tokens: tokens.map((t) => toPublicToken(t, now)), max_active: MAX_ACTIVE_TOKENS_PER_USER }), {
    headers: { 'Content-Type': 'application/json', ...NO_STORE },
  });
};

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user) return jsonError(401, 'Unauthorized', 'unauthenticated');
  if (locals.token) return jsonError(403, 'Tokens cannot manage tokens', 'token_scope');

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return jsonError(400, 'Invalid JSON body', 'invalid_body');
  }

  const name = validateTokenName((body as any).name);
  if (!name.ok) return jsonError(400, name.error, 'invalid_name');

  const days = parseExpiresInDays((body as any).expiresInDays);
  if (days === null) {
    return jsonError(400, 'expiresInDays must be one of 7, 30, 90', 'invalid_expiry');
  }

  const now = new Date();
  const existing = await listApiTokensByUser(locals.user.id);
  if (countActiveTokens(existing, now) >= MAX_ACTIVE_TOKENS_PER_USER) {
    return jsonError(
      409,
      `You already have ${MAX_ACTIVE_TOKENS_PER_USER} active tokens; revoke one first`,
      'token_limit'
    );
  }

  const generated = generateApiToken();
  const record = await createApiToken({
    user_id: locals.user.id,
    name: name.name,
    token_hash: generated.hash,
    prefix: generated.prefix,
    expires_at: computeExpiry(days, now),
  });

  // The secret is returned exactly once; only its hash is stored.
  return new Response(JSON.stringify({ ...toPublicToken(record, now), token: generated.token }), {
    status: 201,
    headers: { 'Content-Type': 'application/json', ...NO_STORE },
  });
};
