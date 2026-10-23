import type { RequestHandler } from '@sveltejs/kit';
import { revokeApiToken } from '$lib/db';
import { jsonError } from '$lib/patAuth';

export const DELETE: RequestHandler = async ({ params, locals }) => {
  if (!locals.user) return jsonError(401, 'Unauthorized', 'unauthenticated');
  if (locals.token) return jsonError(403, 'Tokens cannot manage tokens', 'token_scope');

  const id = params.id;
  if (!id) return jsonError(400, 'missing id', 'missing_id');

  // Scoped to the caller: someone else's token (or an already revoked one) is a plain 404.
  const revoked = await revokeApiToken(id, locals.user.id);
  if (!revoked) return jsonError(404, 'Token not found', 'not_found');

  return new Response(JSON.stringify({ success: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
