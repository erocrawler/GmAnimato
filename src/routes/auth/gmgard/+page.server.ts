import type { PageServerLoad, Actions } from './$types';
import { redirect } from '@sveltejs/kit';
import { getAuthorizationUrl, generatePKCE } from '$lib/oauth';
import { randomBytes } from 'crypto';

export const load: PageServerLoad = async ({ cookies }) => {
  // Start OAuth flow immediately on GET so link clicks work without a form submit
  const { verifier, challenge } = await generatePKCE();
  const state = randomBytes(32).toString('hex');

  cookies.set('oauth_state', state, {
    path: '/',
    httpOnly: true,
    secure: false, // Set to true in production with HTTPS
    sameSite: 'lax',
    maxAge: 600 // 10 minutes
  });

  cookies.set('oauth_verifier', verifier, {
    path: '/',
    httpOnly: true,
    secure: false,
    sameSite: 'lax',
    maxAge: 600
  });

  const authUrl = getAuthorizationUrl(state, challenge);
  throw redirect(302, authUrl);
};

export const actions: Actions = {
  default: async ({ cookies }) => {
    // Generate PKCE challenge
    const { verifier, challenge } = await generatePKCE();
    
    // Generate random state
    const state = randomBytes(32).toString('hex');
    
    // Store PKCE verifier and state in httpOnly cookies (temporary, 10 minutes)
    cookies.set('oauth_state', state, {
      path: '/',
      httpOnly: true,
      secure: false, // Set to true in production with HTTPS
      sameSite: 'lax',
      maxAge: 600 // 10 minutes
    });
    
    cookies.set('oauth_verifier', verifier, {
      path: '/',
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      maxAge: 600
    });
    
    // Get authorization URL
    const authUrl = getAuthorizationUrl(state, challenge);
    
    // Redirect to GmGard authorization endpoint
    throw redirect(302, authUrl);
  }
};
