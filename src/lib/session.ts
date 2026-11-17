import { randomBytes } from 'crypto';
import { env } from '$env/dynamic/private';
import jwt from 'jsonwebtoken';
import type { UserPublic } from './IDatabase';

/**
 * Session management utilities for secure authentication
 * 
 * Hybrid approach:
 * - Access Token (JWT): Short-lived (30 min), validated without DB lookup
 * - Refresh Token (DB Session): Long-lived (7 days), allows token refresh and revocation
 * - Fallback: If JWT keys not configured, use session token auth exclusively
 */

const ACCESS_TOKEN_EXPIRY_MINUTES = 30;
const SESSION_EXPIRY_DAYS = 7;
const TOKEN_LENGTH = 32;

// JWT Configuration
// Use RS256 (RSA asymmetric) for better security in distributed systems
// Sign with private key, verify with public key

const JWT_ALGORITHM = 'RS256';

// Private/Public keys are expected from environment. If either is missing, JWT is disabled.
const JWT_PRIVATE_KEY = env.JWT_PRIVATE_KEY || '';
const JWT_PUBLIC_KEY = env.JWT_PUBLIC_KEY || '';
export const JWT_ENABLED = Boolean(JWT_PRIVATE_KEY && JWT_PUBLIC_KEY);

export interface JWTPayload {
  id: string;
  username: string;
  email?: string;
  roles: string[];
}

/**
 * Generate a cryptographically secure random session token (refresh token)
 */
export function generateSessionToken(): string {
  return randomBytes(TOKEN_LENGTH).toString('base64url');
}

/**
 * Generate a JWT token using private key (RS256 - RSA asymmetric)
 * Short-lived access token (30 minutes)
 * Private key is kept secret on GmAnimato server
 * Public key is shared with Cloudflare Workers for verification
 */
export function generateJWT(user: JWTPayload): string | null {
  if (!JWT_ENABLED) return null;

  return jwt.sign(user, JWT_PRIVATE_KEY, {
    expiresIn: `${ACCESS_TOKEN_EXPIRY_MINUTES}m`,
    algorithm: JWT_ALGORITHM as 'RS256',
  });
}

/**
 * Verify JWT token using public key (RS256)
 * Can be used anywhere (even in Cloudflare Workers)
 * No access to private key needed
 */
export function verifyJWT(token: string): JWTPayload | null {
  if (!JWT_ENABLED) return null;

  try {
    const decoded = jwt.verify(token, JWT_PUBLIC_KEY, { algorithms: [JWT_ALGORITHM as 'RS256'] });
    return decoded as JWTPayload;
  } catch (err) {
    return null;
  }
}

/**
 * Calculate session expiration date (7 days for refresh tokens)
 */
export function getSessionExpiry(): Date {
  const expiry = new Date();
  expiry.setDate(expiry.getDate() + SESSION_EXPIRY_DAYS);
  return expiry;
}

/**
 * Check if a session is expired
 */
export function isSessionExpired(expiresAt: Date): boolean {
  return new Date() > expiresAt;
}

/**
 * Whether cookies should carry the Secure flag. Read from env on every call.
 * COOKIE_SECURE=true|1 forces on, false|0 forces off; anything else falls back to NODE_ENV === 'production'.
 */
export function cookieSecure(): boolean {
  const v = (env.COOKIE_SECURE ?? '').trim().toLowerCase();
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  return env.NODE_ENV === 'production';
}

/**
 * Session cookie options.
 * `secure` is a getter so it is resolved per request (cookies.set spreads the object, which invokes it).
 */
export const SESSION_COOKIE_OPTIONS = {
  path: '/',
  httpOnly: true,
  sameSite: 'lax' as const,
  get secure(): boolean {
    return cookieSecure();
  },
  maxAge: 60 * 60 * 24 * SESSION_EXPIRY_DAYS, // 7 days in seconds
};
