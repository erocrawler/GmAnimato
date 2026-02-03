import type { PageServerLoad } from './$types';
import { error, redirect } from '@sveltejs/kit';
import { exchangeCodeForTokens, getUserInfo } from '$lib/oauth';
import { getUserByUsername, createUser, createSession } from '$lib/db';
import { generateJWT, generateSessionToken, getSessionExpiry, SESSION_COOKIE_OPTIONS, JWT_ENABLED } from '$lib/session';

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
    
    if (JWT_ENABLED) {
      // Generate short-lived JWT
      const jwt = generateJWT({
        id: user.id,
        username: user.username,
        email: user.email,
        roles: user.roles,
      });

      if (!jwt) {
        throw error(500, 'Failed to generate authentication token');
      }

      // Generate long-lived refresh token
      const refreshToken = generateSessionToken();
      const expiresAt = getSessionExpiry();
      await createSession(user.id, refreshToken, expiresAt);

      console.log('Setting JWT cookie...');
      
      // Store JWT in cookie
      cookies.set('session', jwt, SESSION_COOKIE_OPTIONS);
      
      // Set refresh token in separate cookie for seamless auto-refresh
      cookies.set('refresh_token', refreshToken, {
        ...SESSION_COOKIE_OPTIONS,
        expires: expiresAt,
      });
      
      // Clean up temporary OAuth cookies
      cookies.delete('oauth_state', { path: '/' });
      cookies.delete('oauth_verifier', { path: '/' });
      
      console.log('OAuth callback successful, redirecting to home...');
      // Redirect to home page
      throw redirect(302, '/');
    }

    // Fallback: use session token when JWT is not enabled
    const sessionToken = generateSessionToken();
    const expiresAt = getSessionExpiry();
    await createSession(user.id, sessionToken, expiresAt);

    console.log('Setting session cookie...');
    
    cookies.set('session', sessionToken, {
      ...SESSION_COOKIE_OPTIONS,
      expires: expiresAt,
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
