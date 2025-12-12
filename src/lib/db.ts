// Main database module - exports interface and provides factory for database implementation
import type { IDatabase, VideoEntry, User, UserPublic, AdminSettings, Session, GetPublishedVideosOptions, GetVideosByUserOptions } from './IDatabase';
import { JsonFileDatabase } from './db-json';
import { PostgresDatabase } from './db-postgres';
import { env } from '$env/dynamic/private';

// Re-export types for backward compatibility
export type { VideoEntry, IDatabase, User, UserPublic, AdminSettings, Session, PaginatedVideos, GetPublishedVideosOptions, GetVideosByUserOptions, GetAllVideosOptions } from './IDatabase';

// Database instance (singleton)
let dbInstance: IDatabase | null = null;

/**
 * Get the database instance based on environment configuration
 * Uses DATABASE_PROVIDER environment variable to determine which implementation to use
 * - 'postgres' or 'postgresql': PostgreSQL with Prisma
 * - 'json' or undefined: JSON file-based storage (default)
 */
export function getDatabase(): IDatabase {
  if (dbInstance) {
    return dbInstance;
  }

  const provider = env.DATABASE_PROVIDER || 'json';

  if (provider === 'postgres' || provider === 'postgresql') {
    const databaseUrl = env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error('DATABASE_URL is required when using PostgreSQL');
    }
    dbInstance = new PostgresDatabase(databaseUrl);
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

export async function getAllVideos(options?: import('./IDatabase').GetAllVideosOptions) {
  return db.getAllVideos(options);
}

export async function getVideosByUser(user_id: string, page?: number, pageSize?: number, options?: GetVideosByUserOptions) {
  return db.getVideosByUser(user_id, page, pageSize, options);
}

export async function getActiveJobsByUser(user_id: string) {
  return db.getActiveJobsByUser(user_id);
}

export async function getPublishedVideos(options?: GetPublishedVideosOptions) {
  return db.getPublishedVideos(options);
}

export async function getVideoById(id: string) {
  return db.getVideoById(id);
}

export async function updateVideo(id: string, patch: Partial<VideoEntry>) {
  return db.updateVideo(id, patch);
}

export async function deleteVideo(id: string) {
  return db.deleteVideo(id);
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

export async function getDailyQuotaUsage(userId: string, date: Date) {
  return db.getDailyQuotaUsage(userId, date);
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

// ==================== Helper Functions ====================

/**
 * Check if a user has exceeded their daily video generation quota
 * @param user The user to check (only id and roles needed)
 * @param settings Admin settings containing quota limits
 * @returns {exceeded: boolean, limit: number, used: number}
 */
export async function checkDailyQuota(user: Pick<User, 'id' | 'roles'>, settings: AdminSettings): Promise<{exceeded: boolean, limit: number, used: number}> {
  // Determine quota limit based on user roles
  let dailyLimit = settings.quotaPerDay['free-tier'] || 10; // Default for free tier
  
  // Check roles in priority order: paid/premium > gmgard-user > free
  for (const role of user.roles) {
    if (settings.quotaPerDay[role] !== undefined) {
      // Use the highest quota the user has access to
      dailyLimit = Math.max(dailyLimit, settings.quotaPerDay[role]);
    }
  }
  
  // Get quota usage for today
  const today = new Date();
  const used = await db.getDailyQuotaUsage(user.id, today);
  
  return {
    exceeded: used >= dailyLimit,
    limit: dailyLimit,
    used
  };
}
