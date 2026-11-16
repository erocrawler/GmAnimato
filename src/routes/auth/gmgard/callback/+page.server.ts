import type { PageServerLoad } from './$types';
import { error, isHttpError, isRedirect, redirect } from '@sveltejs/kit';
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcrypt';
import { exchangeCodeForTokens, getUserInfo, type OAuthUserInfo } from '$lib/oauth';
import {
  getUserByUsername,
  getUserByOAuthIdentity,
  linkOAuthIdentity,
  createOAuthUser,
  createSession,
  type User,
} from '$lib/db';
import { generateJWT, generateSessionToken, getSessionExpiry, SESSION_COOKIE_OPTIONS, JWT_ENABLED } from '$lib/session';

const OAUTH_PROVIDER = 'gmgard';
const OAUTH_ROLE = 'gmgard-user';
const SALT_ROUNDS = 10;
const USERNAME_TAKEN_MESSAGE = '该用户名已被本站其他账号占用,请联系管理员';

/**
 * Resolve the local account for a GmGard identity. The stable key is (provider, sub); the username is
 * only used to adopt a legacy OAuth account (role gmgard-user, no sub yet) or to name a new one.
 * Never logs in or merges into a local-registered account / an account bound to another sub.
 */
async function resolveOAuthUser(sub: string, username: string, email: string | undefined): Promise<User> {
  // a. known identity -> log in (also after a rename on the GmGard side)
  const bound = await getUserByOAuthIdentity(OAUTH_PROVIDER, sub);
  if (bound) return bound;

  // b. legacy OAuth account: created by the old flow (role gmgard-user), never bound to a sub
  const existing = await getUserByUsername(username);
  if (existing) {
    // Same identity created/bound by a concurrent request between our lookups.
    if (existing.oauth_provider === OAUTH_PROVIDER && existing.oauth_sub === sub) return existing;
    if (existing.roles?.includes(OAUTH_ROLE) && !existing.oauth_sub) {
      if (await linkOAuthIdentity(existing.id, OAUTH_PROVIDER, sub)) {
        return { ...existing, oauth_provider: OAUTH_PROVIDER, oauth_sub: sub };
      }
      // Lost the race: a concurrent login of the same identity may have bound it just now.
      const raced = await getUserByOAuthIdentity(OAUTH_PROVIDER, sub);
      if (raced) return raced;
    }
    // c. username belongs to a local-registered account or to another identity: no login, no merge
    console.warn(`OAuth username conflict: provider=${OAUTH_PROVIDER} username=${username}`);
    throw error(403, USERNAME_TAKEN_MESSAGE);
  }

  // d. new user. The password hash is a valid bcrypt of 32 random bytes nobody knows, so password
  //    login can never succeed for this account.
  const unknownPasswordHash = await bcrypt.hash(randomBytes(32).toString('hex'), SALT_ROUNDS);
  const base = { username, password_hash: unknownPasswordHash, roles: [OAUTH_ROLE], provider: OAUTH_PROVIDER, sub };
  let created = await createOAuthUser({ ...base, email });
  if (!created && email) {
    // The email may be held by another account (it is not an identity): retry without it.
    created = await createOAuthUser({ ...base });
  }
  if (created) return created;

  // Unique conflict: a concurrent first login of the same identity may have created it.
  const raced = await getUserByOAuthIdentity(OAUTH_PROVIDER, sub);
  if (raced) return raced;
  console.warn(`OAuth username conflict: provider=${OAUTH_PROVIDER} username=${username}`);
  throw error(403, USERNAME_TAKEN_MESSAGE);
}

/** Error summary that never includes message text of DB errors (Prisma messages embed the query args). */
function describeError(err: unknown): string {
  if (!err || typeof err !== 'object') return typeof err;
  const e = err as { name?: string; code?: string; message?: string };
  if (typeof e.name === 'string' && e.name.startsWith('PrismaClient')) return `${e.name}${e.code ? ` ${e.code}` : ''}`;
  return `${e.name ?? 'Error'}: ${String(e.message ?? '').slice(0, 200)}`;
}

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
    const tokens = await exchangeCodeForTokens(code, verifier, url.origin);
    const userInfo: OAuthUserInfo = await getUserInfo(tokens.access_token);

    // The stable key must be a non-empty string; without it we cannot tell identities apart.
    const sub = typeof userInfo?.sub === 'string' && userInfo.sub.trim() !== '' ? userInfo.sub : '';
    if (!sub) {
      console.warn('OAuth userinfo has no usable sub, rejecting login');
      throw error(400, 'Invalid user info from identity provider');
    }
    const preferred = typeof userInfo.preferred_username === 'string' ? userInfo.preferred_username.trim() : '';
    const username = preferred || sub;
    const email = typeof userInfo.email === 'string' && userInfo.email ? userInfo.email : undefined;

    const user = await resolveOAuthUser(sub, username, email);
    console.log(`OAuth login ok, user id=${user.id}`);

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
      
      // Redirect to home page
      throw redirect(302, '/');
    }

    // Fallback: use session token when JWT is not enabled
    const sessionToken = generateSessionToken();
    const expiresAt = getSessionExpiry();
    await createSession(user.id, sessionToken, expiresAt);

    cookies.set('session', sessionToken, {
      ...SESSION_COOKIE_OPTIONS,
      expires: expiresAt,
    });
    
    // Clean up temporary OAuth cookies
    cookies.delete('oauth_state', { path: '/' });
    cookies.delete('oauth_verifier', { path: '/' });
    
    // Redirect to home page
    throw redirect(302, '/');
    
  } catch (err) {
    // SvelteKit redirects and deliberate HTTP errors (400/403/...) pass through untouched
    if (isRedirect(err) || isHttpError(err)) throw err;
    console.error('OAuth callback error:', describeError(err));
    throw error(500, 'Failed to complete authentication');
  }
};
