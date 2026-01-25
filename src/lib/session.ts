import { randomBytes } from 'crypto';
import { env } from '$env/dynamic/private';
import jwt from 'jsonwebtoken';
import type { UserPublic } from './IDatabase';

/**
 * Session management utilities for secure authentication
 */

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
 * Generate a cryptographically secure random session token
 */
export function generateSessionToken(): string {
  return randomBytes(TOKEN_LENGTH).toString('base64url');
}

/**
 * Generate a JWT token using private key (RS256 - RSA asymmetric)
 * Private key is kept secret on GmAnimato server
 * Public key is shared with Cloudflare Workers for verification
 */
export function generateJWT(user: JWTPayload): string | null {
  if (!JWT_ENABLED) return null;

  return jwt.sign(user, JWT_PRIVATE_KEY, {
    expiresIn: `${SESSION_EXPIRY_DAYS}d`,
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
 * Calculate session expiration date
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
 * Session cookie options
 */
export const SESSION_COOKIE_OPTIONS = {
  path: '/',
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: env.NODE_ENV === 'production',
  maxAge: 60 * 60 * 24 * SESSION_EXPIRY_DAYS, // 7 days in seconds
};
