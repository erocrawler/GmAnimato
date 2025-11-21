// Database module for Node.js scripts (seed, migrations, etc.)
// This is separate from src/lib/db.ts which uses SvelteKit-specific imports

import type { IDatabase, VideoEntry, User, UserPublic, AdminSettings, Session } from '../src/lib/IDatabase';
import { PostgresDatabase } from '../src/lib/db-postgres';
import { JsonFileDatabase } from '../src/lib/db-json';

// Re-export types for convenience
export type { VideoEntry, IDatabase, User, UserPublic, AdminSettings, Session };

// Database instance (singleton)
let dbInstance: IDatabase | null = null;

/**
 * Get the database instance for scripts
 * Uses process.env.DATABASE_PROVIDER to determine which implementation to use
 */
export function getDatabase(): IDatabase {
  if (dbInstance) {
    return dbInstance;
  }

  const provider = process.env.DATABASE_PROVIDER || 'json';
  console.log(`Using database provider: ${provider}`);
  if (provider === 'postgres' || provider === 'postgresql') {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error('DATABASE_URL environment variable is required for PostgreSQL');
    }
    dbInstance = new PostgresDatabase(databaseUrl);
  } else {
    dbInstance = new JsonFileDatabase();
  }

  return dbInstance!;
}

// Convenience functions that delegate to the database instance
const db = getDatabase();

// ==================== Video Functions ====================

export async function createVideoEntry(entry: Omit<VideoEntry, 'id' | 'created_at'> & { id?: string }) {
  return db.createVideoEntry(entry);
}

export async function getVideosByUser(user_id: string) {
  return db.getVideosByUser(user_id);
}

export async function getActiveJobsByUser(user_id: string) {
  return db.getActiveJobsByUser(user_id);
}

export async function getPublishedVideos() {
  return db.getPublishedVideos();
}

export async function getVideoById(id: string) {
  return db.getVideoById(id);
}

export async function updateVideo(id: string, patch: Partial<VideoEntry>) {
  return db.updateVideo(id, patch);
}

export async function toggleLike(videoId: string, userId: string) {
  return db.toggleLike(videoId, userId);
}

export async function getLikeCount(videoId: string) {
  return db.getLikeCount(videoId);
}

export async function isVideoLikedByUser(videoId: string, userId: string) {
  return db.isVideoLikedByUser(videoId, userId);
}

// ==================== User Functions ====================

export async function createUser(username: string, password_hash: string, email?: string, roles?: string[]) {
  return db.createUser(username, password_hash, email, roles);
}

export async function getUserById(id: string) {
  return db.getUserById(id);
}

export async function getUserByUsername(username: string) {
  return db.getUserByUsername(username);
}

export async function getUserByEmail(email: string) {
  return db.getUserByEmail(email);
}

export async function updateUser(id: string, patch: Partial<Omit<User, 'id' | 'created_at'>>) {
  return db.updateUser(id, patch);
}

export async function deleteUser(id: string) {
  return db.deleteUser(id);
}

// ==================== Admin Settings Functions ====================

export async function getAdminSettings() {
  return db.getAdminSettings();
}

export async function updateAdminSettings(patch: Partial<Omit<AdminSettings, 'id'>>) {
  return db.updateAdminSettings(patch);
}

export async function getAllUsers() {
  return db.getAllUsers();
}

// ==================== Session Functions ====================

export async function createSession(userId: string, token: string, expiresAt: Date) {
  return db.createSession(userId, token, expiresAt);
}

export async function getSessionByToken(token: string) {
  return db.getSessionByToken(token);
}

export async function deleteSession(token: string) {
  return db.deleteSession(token);
}

export async function deleteExpiredSessions() {
  return db.deleteExpiredSessions();
}

export async function deleteUserSessions(userId: string) {
  return db.deleteUserSessions(userId);
}
