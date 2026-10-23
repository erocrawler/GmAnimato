/**
 * OAuth client module for GmGard authentication
 * Implements Authorization Code Flow with PKCE
 */

import { env } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  userinfoEndpoint: string;
  logoutEndpoint: string;
  redirectUri: string;
}

export interface OAuthTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  id_token?: string;
  scope?: string;
}

export interface OAuthUserInfo {
  sub: string;
  name?: string;
  preferred_username?: string;
  email?: string;
  email_verified?: boolean;
  nickname?: string;
  points?: number;
  level?: number;
  role?: string[];
}

/**
 * Get OAuth configuration from environment variables
 */
export function getOAuthConfig(): OAuthConfig {
  return {
    clientId: publicEnv.PUBLIC_OAUTH_CLIENT_ID || 'gmanimato',
    clientSecret: env.OAUTH_CLIENT_SECRET || '',
    issuer: publicEnv.PUBLIC_OAUTH_ISSUER || 'https://localhost:59145',
    authorizationEndpoint: publicEnv.PUBLIC_OAUTH_AUTHORIZATION_ENDPOINT || 'https://localhost:59145/connect/authorize',
    tokenEndpoint: publicEnv.PUBLIC_OAUTH_TOKEN_ENDPOINT || 'https://localhost:59145/connect/token',
    userinfoEndpoint: publicEnv.PUBLIC_OAUTH_USERINFO_ENDPOINT || 'https://localhost:59145/connect/userinfo',
    logoutEndpoint: publicEnv.PUBLIC_OAUTH_LOGOUT_ENDPOINT || 'https://localhost:59145/connect/logout',
    redirectUri: env.OAUTH_REDIRECT_URI || 'http://localhost:5173/auth/gmgard/callback'
  };
}

/**
 * Resolve the OAuth redirect_uri for the current request.
 *
 * OAUTH_REDIRECT_URI stays the default (canonical) redirect. When the request
 * arrives on another origin listed in OAUTH_ALLOWED_ORIGINS (comma-separated,
 * e.g. "https://animato.gmgard.us"), the same callback path is used on that
 * origin so the authorize -> callback -> token exchange round trip stays on one
 * host (the oauth_state/oauth_verifier cookies are host-only). Unlisted
 * origins fall back to the default, so a spoofed Host header cannot pick an
 * arbitrary redirect_uri. Every allowed origin must also be registered on the
 * GmGard OpenIddict client.
 */
export function resolveRedirectUri(requestOrigin?: string): string {
  const config = getOAuthConfig();
  if (!requestOrigin) return config.redirectUri;

  const allowed = (env.OAUTH_ALLOWED_ORIGINS || '')
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  if (!allowed.includes(requestOrigin)) return config.redirectUri;

  return `${requestOrigin}${new URL(config.redirectUri).pathname}`;
}

/**
 * Generate PKCE code verifier and challenge
 */
export async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  // Generate random code verifier
  const verifier = base64URLEncode(randomBytes(32));
  
  // Create SHA256 hash of verifier
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const hash = await crypto.subtle.digest('SHA-256', data);
  
  // Base64 URL encode the hash
  const challenge = base64URLEncode(new Uint8Array(hash));
  
  return { verifier, challenge };
}

/**
 * Generate random bytes
 */
function randomBytes(length: number): Uint8Array {
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return array;
}

/**
 * Base64 URL encode
 */
function base64URLEncode(buffer: Uint8Array): string {
  const base64 = btoa(String.fromCharCode(...buffer));
  return base64
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

/**
 * Generate authorization URL
 */
export function getAuthorizationUrl(state: string, codeChallenge: string, requestOrigin?: string): string {
  const config = getOAuthConfig();
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: resolveRedirectUri(requestOrigin),
    response_type: 'code',
    scope: 'openid profile email roles',
    state: state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256'
  });

  return `${config.authorizationEndpoint}?${params.toString()}`;
}

/**
 * Exchange authorization code for tokens
 */
export async function exchangeCodeForTokens(
  code: string,
  codeVerifier: string,
  requestOrigin?: string
): Promise<OAuthTokenResponse> {
  const config = getOAuthConfig();

  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code: code,
    redirect_uri: resolveRedirectUri(requestOrigin),
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code_verifier: codeVerifier
  });

  const response = await fetch(config.tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: params.toString()
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Token exchange failed: ${error}`);
  }

  return response.json();
}

/**
 * Get user info from access token
 */
export async function getUserInfo(accessToken: string): Promise<OAuthUserInfo> {
  const config = getOAuthConfig();

  const response = await fetch(config.userinfoEndpoint, {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`UserInfo request failed: ${error}`);
  }

  return response.json();
}

/**
 * Refresh access token
 */
export async function refreshAccessToken(refreshToken: string): Promise<OAuthTokenResponse> {
  const config = getOAuthConfig();

  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: config.clientId,
    client_secret: config.clientSecret
  });

  const response = await fetch(config.tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: params.toString()
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Token refresh failed: ${error}`);
  }

  return response.json();
}
