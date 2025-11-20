// Main database module - exports interface and provides factory for database implementation
import type { IDatabase, VideoEntry, User, UserPublic } from './IDatabase';
import { JsonFileDatabase } from './db-json';

// Re-export types for backward compatibility
export type { VideoEntry, IDatabase, User, UserPublic };

// Database instance (singleton)
let dbInstance: IDatabase | null = null;

/**
 * Get the database instance based on environment configuration
 * Uses DATABASE_PROVIDER environment variable to determine which implementation to use
 * - 'sqlserver': SQL Server with Prisma
 * - 'json' or undefined: JSON file-based storage (default)
 */
export function getDatabase(): IDatabase {
  if (dbInstance) {
    return dbInstance;
  }

  const provider = process.env.DATABASE_PROVIDER || 'json';

  if (provider === 'sqlserver') {
    // Dynamically import to avoid loading Prisma when not needed
    const { SqlServerDatabase } = require('./db-sqlserver');
    dbInstance = new SqlServerDatabase();
  } else {
    dbInstance = new JsonFileDatabase();
  }

  return dbInstance!;
}

// Convenience functions that delegate to the database instance
// These maintain backward compatibility with existing code
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

// ==================== User Functions ====================

export async function createUser(username: string, password_hash: string, email?: string) {
  return db.createUser(username, password_hash, email);
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
