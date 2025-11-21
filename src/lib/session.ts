import { randomBytes } from 'crypto';
import type { UserPublic } from './IDatabase';

/**
 * Session management utilities for secure authentication
 */

const SESSION_EXPIRY_DAYS = 7;
const TOKEN_LENGTH = 32;

/**
 * Generate a cryptographically secure random session token
 */
export function generateSessionToken(): string {
  return randomBytes(TOKEN_LENGTH).toString('base64url');
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
  secure: process.env.NODE_ENV === 'production',
  maxAge: 60 * 60 * 24 * SESSION_EXPIRY_DAYS, // 7 days in seconds
};
