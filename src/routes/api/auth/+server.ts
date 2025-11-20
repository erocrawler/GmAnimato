import type { RequestHandler } from '@sveltejs/kit';
import { authenticateUser, registerUser } from '$lib/auth';

export const POST: RequestHandler = async ({ request, cookies }) => {
  const body = await request.json();
  const action = body.action as string | undefined; // 'login' or 'register'
  const username = body.username as string | undefined;
  const password = body.password as string | undefined;

  if (!action || !username || !password) {
    return new Response(
      JSON.stringify({ error: 'Missing required fields (action, username, password)' }),
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

    // Set session cookie
    cookies.set('session', JSON.stringify(user), {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 7, // 7 days
    });

    return new Response(JSON.stringify({ success: true, user }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (action === 'register') {
    const user = await registerUser(username, password);
    if (!user) {
      return new Response(JSON.stringify({ error: 'Username already exists' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Set session cookie
    cookies.set('session', JSON.stringify(user), {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 7, // 7 days
    });

    return new Response(JSON.stringify({ success: true, user }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ error: 'Unknown action' }), {
    status: 400,
    headers: { 'Content-Type': 'application/json' },
  });
};
