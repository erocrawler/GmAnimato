import type { RequestHandler } from '@sveltejs/kit';
import { getUserById, updateUser, deleteUserSessions, createSession } from '$lib/db';
import { generateSessionToken, getSessionExpiry, SESSION_COOKIE_OPTIONS } from '$lib/session';
import bcrypt from 'bcrypt';

const SALT_ROUNDS = 10;

export const POST: RequestHandler = async ({ request, locals, cookies }) => {
  if (!locals.user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const body = await request.json();
  const currentPassword = body.currentPassword as string | undefined;
  const newPassword = body.newPassword as string | undefined;

  if (!currentPassword || !newPassword) {
    return new Response(
      JSON.stringify({ error: 'Current password and new password are required' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (newPassword.length < 6) {
    return new Response(
      JSON.stringify({ error: 'New password must be at least 6 characters' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Get full user data including password hash
  const user = await getUserById(locals.user.id);
  if (!user) {
    return new Response(JSON.stringify({ error: 'User not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Verify current password
  const isValid = await bcrypt.compare(currentPassword, user.password_hash);
  if (!isValid) {
    return new Response(JSON.stringify({ error: 'Current password is incorrect' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Hash new password
  const newPasswordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);

  // Update password
  const updated = await updateUser(user.id, { password_hash: newPasswordHash });

  if (!updated) {
    return new Response(JSON.stringify({ error: 'Failed to update password' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Invalidate all existing sessions for security
  await deleteUserSessions(user.id);

  // Create new session
  const sessionToken = generateSessionToken();
  const expiresAt = getSessionExpiry();
  await createSession(user.id, sessionToken, expiresAt);

  // Set new session cookie
  cookies.set('session', sessionToken, SESSION_COOKIE_OPTIONS);

  return new Response(JSON.stringify({ success: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
