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
export function getAuthorizationUrl(state: string, codeChallenge: string): string {
  const config = getOAuthConfig();
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
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
  codeVerifier: string
): Promise<OAuthTokenResponse> {
  const config = getOAuthConfig();

  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code: code,
    redirect_uri: config.redirectUri,
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
