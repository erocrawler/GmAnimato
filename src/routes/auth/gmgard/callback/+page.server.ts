import type { PageServerLoad } from './$types';
import { error, redirect } from '@sveltejs/kit';
import { exchangeCodeForTokens, getUserInfo } from '$lib/oauth';
import { getUserByUsername, createUser, createSession } from '$lib/db';

export const load: PageServerLoad = async ({ url, cookies }) => {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const errorParam = url.searchParams.get('error');
  const errorDescription = url.searchParams.get('error_description');
  
  // Check for OAuth errors
  if (errorParam) {
    console.error('OAuth error:', errorParam, errorDescription);
    throw error(400, errorDescription || 'Authentication failed');
  }
  
  // Validate code and state
  if (!code || !state) {
    throw error(400, 'Missing authorization code or state');
  }
  
  // Retrieve and validate state from cookie
  const storedState = cookies.get('oauth_state');
  if (!storedState || storedState !== state) {
    throw error(400, 'Invalid state parameter');
  }
  
  // Retrieve PKCE verifier
  const verifier = cookies.get('oauth_verifier');
  if (!verifier) {
    throw error(400, 'Missing PKCE verifier');
  }
  
  try {
    // Exchange code for tokens
    console.log('Exchanging code for tokens...');
    const tokens = await exchangeCodeForTokens(code, verifier);
    console.log('Token exchange successful, access_token:', tokens.access_token?.substring(0, 20) + '...');
    
    // Get user info from GmGard
    console.log('Fetching user info...');
    const userInfo = await getUserInfo(tokens.access_token);
    console.log('User info received:', userInfo);
    
    // Check if user exists in local database
    console.log('Looking up user by username:', userInfo.preferred_username || userInfo.sub);
    let user = await getUserByUsername(userInfo.preferred_username || userInfo.sub);
    
    // Create user if doesn't exist (federated identity)
    if (!user) {
      console.log('User not found, creating new user...');
      // Generate a random password hash since this user will only login via OAuth
      const randomPassword = Math.random().toString(36).substring(2, 15);
      user = await createUser(
        userInfo.preferred_username || userInfo.sub,
        randomPassword, // This won't be used for OAuth users
        userInfo.email,
        ['gmgard-user']
      );
      console.log('User created:', user);
    } else {
      console.log('User found:', user);
    }
    
    // Create session
    const sessionData = {
      id: user.id,
      username: user.username,
      email: user.email,
      roles: user.roles,
      oauth_provider: 'gmgard',
      oauth_sub: userInfo.sub
    };
    
    console.log('Setting session cookie...');
    // Generate a unique session token
    const sessionToken = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 60 * 60 * 24 * 7 * 1000); // 7 days
    
    // Create session in database
    await createSession(user.id, sessionToken, expiresAt);
    
    // Store session token in cookie (not the whole session data)
    cookies.set('session', sessionToken, {
      path: '/',
      httpOnly: true,
      secure: false, // Set to true in production
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 7 // 7 days
    });
    
    // Clean up temporary OAuth cookies
    cookies.delete('oauth_state', { path: '/' });
    cookies.delete('oauth_verifier', { path: '/' });
    
    console.log('OAuth callback successful, redirecting to home...');
    // Redirect to home page
    throw redirect(302, '/');
    
  } catch (err) {
    // Check if this is a SvelteKit redirect (has status property and location)
    if (err && typeof err === 'object' && 'status' in err && 'location' in err) {
      console.log('Redirect caught, re-throwing to SvelteKit...');
      throw err;
    }
    console.error('OAuth callback error:', err);
    throw error(500, `Failed to complete authentication: ${err instanceof Error ? err.message : String(err)}`);
  }
};
