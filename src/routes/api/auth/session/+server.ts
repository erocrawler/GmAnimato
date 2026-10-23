import type { RequestHandler } from '@sveltejs/kit';

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user) {
    return new Response(
      JSON.stringify({ error: 'Unauthorized', errorCode: 'unauthenticated' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // API-token callers get a whoami view only: no email, plus the token's own
  // expiry so an agent can tell when it needs a new one.
  if (locals.token) {
    const { id, username, roles, created_at } = locals.user;
    return new Response(
      JSON.stringify({
        user: { id, username, roles, created_at },
        token: { name: locals.token.name, prefix: locals.token.prefix, expires_at: locals.token.expires_at },
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  }

  return new Response(
    JSON.stringify({ user: locals.user }),
    { headers: { 'Content-Type': 'application/json' } }
  );
};
