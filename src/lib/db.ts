// Main database module - exports interface and provides factory for database implementation
import type { IDatabase, VideoEntry, User, UserPublic, AdminSettings, Session, GetPublishedVideosOptions, GetVideosByUserOptions } from './IDatabase';
import { JsonFileDatabase } from './db-json';
import { PostgresDatabase } from './db-postgres';
import { env } from '$env/dynamic/private';

// Re-export types for backward compatibility
export type { VideoEntry, IDatabase, User, UserPublic, AdminSettings, Session, Workflow, PaginatedVideos, GetPublishedVideosOptions, GetVideosByUserOptions, GetAllVideosOptions } from './IDatabase';

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

// Export db for direct Prisma access in API routes
export { db };

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

export async function getActiveJobCountByUser(user_id: string) {
  return db.getActiveJobCountByUser(user_id);
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

export async function getOldestLocalJob() {
  return db.getOldestLocalJob();
}

export async function claimLocalJob() {
  return db.claimLocalJob();
}

export async function getLocalJobStats() {
  return db.getLocalJobStats();
}

export async function getOldestMigrationCandidate(settings: AdminSettings) {
  return db.getOldestMigrationCandidate(settings);
}

export async function claimJobForMigration(settings: AdminSettings) {
  return db.claimJobForMigration(settings);
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

// Cache for admin settings to avoid frequent database queries
let adminSettingsCache: {
  data: AdminSettings | null;
  timestamp: number;
} = {
  data: null,
  timestamp: 0
};

const ADMIN_SETTINGS_CACHE_MS = 30 * 1000; // 30 seconds cache

export async function getAdminSettings() {
  const now = Date.now();
  
  // Return cached settings if still valid
  if (adminSettingsCache.data && (now - adminSettingsCache.timestamp) < ADMIN_SETTINGS_CACHE_MS) {
    return adminSettingsCache.data;
  }
  
  // Fetch fresh settings
  const settings = await db.getAdminSettings();
  
  // Update cache
  adminSettingsCache = {
    data: settings,
    timestamp: now
  };
  
  return settings;
}

export async function updateAdminSettings(patch: Partial<Omit<AdminSettings, 'id'>>) {
  const result = await db.updateAdminSettings(patch);
  
  // Invalidate cache when settings are updated
  adminSettingsCache = {
    data: null,
    timestamp: 0
  };
  
  return result;
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

// ==================== Sponsor Claim Functions ====================

export async function getSponsorClaimByUsername(sponsorUsername: string) {
  return db.getSponsorClaimByUsername(sponsorUsername);
}

export async function getSponsorClaimsByUser(userId: string) {
  return db.getSponsorClaimsByUser(userId);
}

export async function createSponsorClaim(claim: Omit<import('./IDatabase').SponsorClaim, 'id' | 'claimed_at'>) {
  return db.createSponsorClaim(claim);
}

export async function deleteSponsorClaim(id: string) {
  return db.deleteSponsorClaim(id);
}

export async function getAllSponsorClaims() {
  return db.getAllSponsorClaims();
}

// ==================== Workflow Functions ====================

export async function getWorkflowById(id: string) {
  return db.getWorkflowById(id);
}

export async function getWorkflows() {
  return db.getWorkflows();
}

export async function getDefaultWorkflow(workflowType?: 'i2v' | 'fl2v') {
  return db.getDefaultWorkflow(workflowType);
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
  let dailyLimit = 0;
  
  for (const role of user.roles) {
    if (settings.quotaPerDay[role] !== undefined) {
      // sum up all applicable role limits
      dailyLimit += settings.quotaPerDay[role];
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

/**
 * Check if a user is a paid user (has any role with allowAdvancedFeatures enabled)
 * @param user The user to check (only roles needed)
 * @param settings Admin settings containing role configurations
 * @returns true if user is paid, false otherwise
 */
export function isUserPaid(user: Pick<User, 'roles'>, settings: AdminSettings): boolean {
  return user.roles.some(roleName => {
    const roleConfig = settings.roles?.find(rc => rc.name === roleName);
    return roleConfig?.allowAdvancedFeatures === true;
  });
}
