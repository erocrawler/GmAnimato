import type { RequestHandler } from '@sveltejs/kit';
import { authenticateUser, registerUser } from '$lib/auth';
import { validateUser, formatValidationErrors } from '$lib/validation';
import { getAdminSettings, createSession } from '$lib/db';
import {
  generateJWT,
  generateSessionToken,
  getSessionExpiry,
  SESSION_COOKIE_OPTIONS,
  JWT_ENABLED,
} from '$lib/session';

export const POST: RequestHandler = async ({ request, cookies }) => {
  const body = await request.json();
  const action = body.action as string | undefined; // 'login' or 'register'
  const username = body.username as string | undefined;
  const password = body.password as string | undefined;
  const email = body.email as string | undefined;

  if (!action || !username || !password) {
    return new Response(
      JSON.stringify({ error: 'Missing required fields (action, username, password)' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Validate field lengths
  const validationErrors = validateUser({ username, email });
  if (validationErrors.length > 0) {
    return new Response(
      JSON.stringify({ error: formatValidationErrors(validationErrors) }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (action === 'login') {
    const user = await authenticateUser(username, password);
    if (!user) {
      return new Response(JSON.stringify({ error: 'Invalid credentials' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (JWT_ENABLED) {
      // Generate short-lived JWT (30 min) for API access
      const jwt = generateJWT({
        id: user.id,
        username: user.username,
        email: user.email,
        roles: user.roles,
      });

      if (!jwt) {
        return new Response(JSON.stringify({ error: 'JWT not available' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Generate long-lived refresh token (7 days) for token refresh
      const refreshToken = generateSessionToken();
      const expiresAt = getSessionExpiry();
      await createSession(user.id, refreshToken, expiresAt);

      // Set JWT as httpOnly cookie (short-lived)
      cookies.set('session', jwt, SESSION_COOKIE_OPTIONS);
      
      // Set refresh token in separate cookie for seamless auto-refresh
      cookies.set('refresh_token', refreshToken, {
        ...SESSION_COOKIE_OPTIONS,
        expires: expiresAt,
      });

      return new Response(JSON.stringify({ success: true, user, jwt, refreshToken }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Fallback: use legacy DB-backed session when JWT keys are not configured
    const sessionToken = generateSessionToken();
    const expiresAt = getSessionExpiry();
    await createSession(user.id, sessionToken, expiresAt);

    cookies.set('session', sessionToken, {
      ...SESSION_COOKIE_OPTIONS,
      expires: expiresAt,
    });

    return new Response(JSON.stringify({ success: true, user, session: sessionToken }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (action === 'register') {
    // Check if registration is enabled
    const settings = await getAdminSettings();
    if (!settings.registrationEnabled) {
      return new Response(JSON.stringify({ error: 'Registration is currently disabled' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const user = await registerUser(username, password, email);
    if (!user) {
      return new Response(JSON.stringify({ error: 'Username already exists' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (JWT_ENABLED) {
      // Generate short-lived JWT (30 min) for API access
      const jwt = generateJWT({
        id: user.id,
        username: user.username,
        email: user.email,
        roles: user.roles,
      });

      if (!jwt) {
        return new Response(JSON.stringify({ error: 'JWT not available' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Generate long-lived refresh token (7 days) for token refresh
      const refreshToken = generateSessionToken();
      const expiresAt = getSessionExpiry();
      await createSession(user.id, refreshToken, expiresAt);

      // Set JWT as httpOnly cookie (short-lived)
      cookies.set('session', jwt, SESSION_COOKIE_OPTIONS);
      
      // Set refresh token in separate cookie for seamless auto-refresh
      cookies.set('refresh_token', refreshToken, {
        ...SESSION_COOKIE_OPTIONS,
        expires: expiresAt,
      });

      return new Response(JSON.stringify({ success: true, user, jwt, refreshToken }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Fallback: use legacy DB-backed session when JWT keys are not configured
    const sessionToken = generateSessionToken();
    const expiresAt = getSessionExpiry();
    await createSession(user.id, sessionToken, expiresAt);

    cookies.set('session', sessionToken, {
      ...SESSION_COOKIE_OPTIONS,
      expires: expiresAt,
    });

    return new Response(JSON.stringify({ success: true, user, session: sessionToken }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ error: 'Unknown action' }), {
    status: 400,
    headers: { 'Content-Type': 'application/json' },
  });
};
