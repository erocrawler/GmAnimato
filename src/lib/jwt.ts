/**
 * JWT token utilities for validation and decoding
 */

export interface JWTPayload {
  exp?: number;
  [key: string]: any;
}

export interface TokenStatus {
  valid: boolean;
  message: string;
  severity: 'info' | 'warning' | 'error';
  expiresInDays?: number;
}

/**
 * Decode a JWT token payload
 * @param token JWT token string
 * @returns Decoded payload or null if invalid
 */
export function decodeJWT(token: string): JWTPayload | null {
  try {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = payload.length % 4;
    const padded = payload + (pad ? '='.repeat(4 - pad) : '');
    const json = atob(padded);
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * Check if a JWT token is expired
 * @param token JWT token string
 * @returns true if expired, false if valid or no expiration
 */
export function isTokenExpired(token: string | null | undefined): boolean {
  if (!token) return true;
  const payload = decodeJWT(token);
  if (!payload || !payload.exp) return false;
  return payload.exp <= Math.floor(Date.now() / 1000);
}

/**
 * Get token status with user-friendly message
 * @param token JWT token string
 * @returns Token status object with validity, message, and severity
 */
export function getTokenStatus(token: string | null | undefined): TokenStatus {
  if (!token) {
    return { valid: false, message: '', severity: 'info' };
  }
  
  const payload = decodeJWT(token);
  if (!payload) {
    return { valid: false, message: 'Invalid JWT token format', severity: 'error' };
  }
  
  if (!payload.exp) {
    return { valid: true, message: '', severity: 'info' };
  }
  
  const nowSec = Math.floor(Date.now() / 1000);
  const expiresInDays = Math.floor((payload.exp - nowSec) / 86400);
  
  if (payload.exp <= nowSec) {
    return { 
      valid: false, 
      message: `Token expired ${Math.abs(expiresInDays)} day(s) ago`, 
      severity: 'error',
      expiresInDays
    };
  } else if (expiresInDays <= 3) {
    return { 
      valid: true, 
      message: `Token expires in ${expiresInDays} day(s)`, 
      severity: 'warning',
      expiresInDays
    };
  } else if (expiresInDays <= 30) {
    return { 
      valid: true, 
      message: `Token expires in ${expiresInDays} day(s)`, 
      severity: 'info',
      expiresInDays
    };
  }
  
  return { valid: true, message: '', severity: 'info', expiresInDays };
}
