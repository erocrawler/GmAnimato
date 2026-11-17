import type { RequestHandler } from '@sveltejs/kit';
import { updateUser } from '$lib/db';
import { validateUser, formatValidationErrors } from '$lib/validation';
import { generateJWT, SESSION_COOKIE_OPTIONS, JWT_ENABLED } from '$lib/session';

export const PUT: RequestHandler = async ({ request, locals, cookies }) => {
  if (!locals.user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const body = await request.json();
  const email = body.email as string | undefined;

  // Validate email if provided
  if (email !== undefined && email !== '') {
    const validationErrors = validateUser({ username: locals.user.username, email });
    if (validationErrors.length > 0) {
      return new Response(
        JSON.stringify({ error: formatValidationErrors(validationErrors) }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  // Update user
  const updated = await updateUser(locals.user.id, { email: email || undefined });

  if (!updated) {
    return new Response(JSON.stringify({ error: 'Failed to update user' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Update session cookie with new user data
  const userPublic = {
    id: updated.id,
    username: updated.username,
    email: updated.email,
    roles: updated.roles,
    created_at: updated.created_at,
    updated_at: updated.updated_at,
  };

  // JWT mode: the session cookie carries the claims (incl. email), so re-issue it.
  // Opaque-token mode: the cookie is a DB session token and user data is looked up
  // server-side per request, so the cookie must stay untouched.
  if (JWT_ENABLED) {
    const jwt = generateJWT({
      id: updated.id,
      username: updated.username,
      email: updated.email,
      roles: updated.roles,
    });
    if (jwt) {
      cookies.set('session', jwt, SESSION_COOKIE_OPTIONS);
    }
  }

  return new Response(JSON.stringify({ success: true, user: userPublic }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
