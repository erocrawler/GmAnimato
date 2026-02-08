import fs from 'fs/promises';
import path from 'path';
import type { IDatabase, VideoEntry, User, AdminSettings, UserPublic } from './IDatabase';
import { DEFAULT_LORA_PRESETS, normalizeLoraPresets } from './loraPresets';

const DATA_DIR = path.resolve('data');
const DB_FILE = path.join(DATA_DIR, 'videos.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'admin_settings.json');

export class JsonFileDatabase implements IDatabase {
  // ==================== Video Methods ====================
  
  private async ensureDB() {
    try {
      await fs.mkdir(DATA_DIR, { recursive: true });
      await fs.access(DB_FILE);
    } catch (err) {
      await fs.writeFile(DB_FILE, '[]', 'utf-8');
    }
  }

  private async readAll(): Promise<VideoEntry[]> {
    await this.ensureDB();
    const txt = await fs.readFile(DB_FILE, 'utf-8');
    return JSON.parse(txt) as VideoEntry[];
  }

  private async writeAll(rows: VideoEntry[]) {
    await this.ensureDB();
    await fs.writeFile(DB_FILE, JSON.stringify(rows, null, 2), 'utf-8');
  }

  async createVideoEntry(entry: Omit<VideoEntry, 'id' | 'created_at'> & { id?: string }): Promise<VideoEntry> {
    const rows = await this.readAll();
    const id = entry.id || String(Date.now()) + '-' + Math.floor(Math.random() * 1000);
    const created_at = new Date().toISOString();
    const row: VideoEntry = { ...entry, id, created_at } as VideoEntry;
    rows.push(row);
    await this.writeAll(rows);
    return row;
  }

  async getAllVideos(options?: import('./IDatabase').GetAllVideosOptions): Promise<import('./IDatabase').PaginatedVideos> {
    const { page = 1, pageSize = 30, userId, username, status, includeDeleted = false } = options || {};
    const rows = await this.readAll();
    
    // Get all users to add username to videos
    const users = await this.readAllUsers();
    const usersMap = new Map(users.map(u => [u.id, { username: u.username }]));
    
    // Filter videos
    let filtered = rows.filter((r) => {
      // Filter by deleted status
      if (!includeDeleted && r.status === 'deleted') return false;
      
      // Filter by userId
      if (userId && r.user_id !== userId) return false;
      
      // Filter by username (partial match, case-insensitive)
      if (username) {
        const user = usersMap.get(r.user_id);
        if (!user || !user.username.toLowerCase().includes(username.toLowerCase())) {
          return false;
        }
      }
      
      // Filter by status
      if (status && r.status !== status) return false;
      
      return true;
    });
    
    // Sort by created_at descending (newest first)
    filtered.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    
    const total = filtered.length;
    const skip = (page - 1) * pageSize;
    const videos = filtered.slice(skip, skip + pageSize).map(v => ({
      ...v,
      username: usersMap.get(v.user_id)?.username || 'Unknown'
    }));
    
    return {
      videos,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize)
    };
  }

  async getVideosByUser(user_id: string, page: number = 1, pageSize: number = 12, options?: import('./IDatabase').GetVideosByUserOptions): Promise<import('./IDatabase').PaginatedVideos> {
    const rows = await this.readAll();
    const includeDeleted = options?.includeDeleted ?? false;
    const sortBy = options?.sortBy ?? 'upload';
    const sortDirection = options?.sortDirection ?? 'desc';
    
    let filtered = rows.filter((r) => r.user_id === user_id && (includeDeleted || r.status !== 'deleted'));
    
    // Apply status filter if provided
    if (options?.status) {
      filtered = filtered.filter((r) => r.status === options.status);
    }

    // Apply isPublished filter if provided
    if (options?.isPublished !== undefined) {
      filtered = filtered.filter((r) => r.is_published === options.isPublished);
    }
    
    // Sort based on sortBy option
    // Note: 'completion' sort uses created_at as proxy since we don't have a dedicated completed_at field
    const directionMultiplier = sortDirection === 'asc' ? 1 : -1;
    if (sortBy === 'completion') {
      filtered.sort((a, b) => (new Date(a.created_at).getTime() - new Date(b.created_at).getTime()) * directionMultiplier);
    } else {
      // Default: sort by upload time (created_at)
      filtered.sort((a, b) => (new Date(a.created_at).getTime() - new Date(b.created_at).getTime()) * directionMultiplier);
    }
    
    const total = filtered.length;
    const skip = (page - 1) * pageSize;
    const videos = filtered.slice(skip, skip + pageSize);
    
    return {
      videos,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize)
    };
  }

  async getActiveJobCountByUser(user_id: string): Promise<number> {
    const rows = await this.readAll();
    return rows.filter((r) => 
      r.user_id === user_id && 
      (r.status === 'in_queue' || r.status === 'processing')
    ).length;
  }

  async getPublishedVideos(options?: import('./IDatabase').GetPublishedVideosOptions): Promise<import('./IDatabase').PaginatedVideos> {
    const { page = 1, pageSize = 12, likedBy, excludeId, status, isNsfw, sortBy = 'date', afterValue } = options || {};
    const rows = await this.readAll();
    let filtered = rows.filter((r) => r.is_published);
    
    // Filter by liked videos if likedBy is provided
    if (likedBy) {
      filtered = filtered.filter((r) => r.likes?.includes(likedBy));
    }
    
    // Exclude specific video if excludeId is provided
    if (excludeId) {
      filtered = filtered.filter((r) => r.id !== excludeId);
    }
    
    // Filter by status if provided
    if (status) {
      filtered = filtered.filter((r) => r.status === status);
    }
    
    // Filter by NSFW if provided
    if (isNsfw !== undefined) {
      filtered = filtered.filter((r) => r.is_nsfw === isNsfw);
    }
    
    // Sort by likes or date
    if (sortBy === 'likes') {
      filtered.sort((a, b) => (b.likes?.length || 0) - (a.likes?.length || 0));
    } else {
      filtered.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    }

    // Cursor-based pagination: skip up to and including afterValue (video id)
    if (afterValue) {
      const idx = filtered.findIndex((v) => v.id === afterValue);
      if (idx !== -1) {
        filtered = filtered.slice(idx + 1);
      }
    }
    
    const total = filtered.length;
    const skip = (page - 1) * pageSize;
    const videos = filtered.slice(skip, skip + pageSize);
    
    return {
      videos,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize)
    };
  }

  async getVideoById(id: string): Promise<VideoEntry | undefined> {
    const rows = await this.readAll();
    return rows.find((r) => r.id === id);
  }

  async updateVideo(id: string, patch: Partial<VideoEntry>): Promise<VideoEntry | null> {
    const rows = await this.readAll();
    const idx = rows.findIndex((r) => r.id === id);
    if (idx === -1) return null;
    rows[idx] = { ...rows[idx], ...patch } as VideoEntry;
    await this.writeAll(rows);
    return rows[idx];
  }

  async deleteVideo(id: string): Promise<boolean> {
    const rows = await this.readAll();
    const idx = rows.findIndex((r) => r.id === id);
    if (idx === -1) return false;
    rows[idx] = { ...rows[idx], status: 'deleted', is_published: false } as VideoEntry;
    await this.writeAll(rows);
    return true;
  }

  async toggleLike(videoId: string, userId: string): Promise<VideoEntry | null> {
    // Likes are only supported in SQL Server implementation
    // This keeps the JSON implementation simple and focused on development/testing
    const rows = await this.readAll();
    const video = rows.find((r) => r.id === videoId);
    if (!video) return null;
    
    // Return video without modifying likes
    console.warn('[JSON DB] toggleLike not supported - use SQL Server for like functionality');
    return video;
  }

  async getLikeCount(videoId: string): Promise<number> {
    console.warn('[JSON DB] getLikeCount not supported - use SQL Server for like functionality');
    return 0;
  }

  async isVideoLikedByUser(videoId: string, userId: string): Promise<boolean> {
    console.warn('[JSON DB] isVideoLikedByUser not supported - use SQL Server for like functionality');
    return false;
  }

  async getDailyQuotaUsage(userId: string, date: Date): Promise<number> {
    const rows = await this.readAll();
    const startOfDay = new Date(date);
    startOfDay.setHours(0, 0, 0, 0);
    
    const todayVideos = rows.filter(v => {
      if (v.user_id !== userId) return false;
      
      const createdAt = new Date(v.created_at);
      if (createdAt < startOfDay) return false;
      
      if (v.status === 'deleted') {
        // Only count deleted if it was successfully processed (has final_video_url)
        return !!v.final_video_url;
      }
      
      // Count if in: completed, in_queue, processing
      return ['completed', 'in_queue', 'processing'].includes(v.status);
    });
    
    return todayVideos.length;
  }

  async getOldestLocalJob(): Promise<VideoEntry | null> {
    const rows = await this.readAll();
    const localJobs = rows.filter(v => v.is_local_job === true && v.status === 'in_queue');
    if (localJobs.length === 0) return null;
    
    // Sort by created_at ascending (oldest first)
    localJobs.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    return localJobs[0];
  }

  async claimLocalJob(): Promise<VideoEntry | null> {
    // For JSON file database, we use a simple approach
    // Note: This is not truly atomic and is only suitable for single-worker scenarios
    // For production with multiple workers, use PostgreSQL
    const rows = await this.readAll();
    const localJobs = rows.filter(v => v.is_local_job === true && v.status === 'in_queue');
    
    if (localJobs.length === 0) return null;
    
    // Sort by created_at ascending (oldest first)
    localJobs.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    const job = localJobs[0];
    
    // Update status to processing
    const index = rows.findIndex(v => v.id === job.id);
    if (index !== -1) {
      rows[index].status = 'processing';
      await this.writeAll(rows);
      return rows[index];
    }
    
    return null;
  }

  async getLocalJobStats(): Promise<{ inQueue: number; processing: number; completed: number; failed: number }> {
    const rows = await this.readAll();
    const inQueue = rows.filter(v => v.is_local_job === true && v.status === 'in_queue').length;
    const processing = rows.filter(v => v.is_local_job === true && v.status === 'processing').length;
    const completed = rows.filter(v => v.is_local_job === true && v.status === 'completed').length;
    const failed = rows.filter(v => v.is_local_job === true && v.status === 'failed').length;
    return { inQueue, processing, completed, failed };
  }

  async getOldestMigrationCandidate(settings: AdminSettings): Promise<VideoEntry | null> {
    const rows = await this.readAll();
    const thresholdMinutes = settings.freeUserWaitThresholdMinutes || 30;
    const thresholdDate = new Date(Date.now() - thresholdMinutes * 60 * 1000);

    // Get all pending local jobs
    const candidates = rows
      .filter(v => v.is_local_job === true && v.status === 'in_queue')
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

    // Find first eligible candidate
    for (const video of candidates) {
      // Get user to check roles
      const users = await this.readAllUsers();
      const user = users.find(u => u.id === video.user_id);
      if (!user) continue;

      const userRoles = user.roles || [];
      
      // Check if user is paid
      const isPaidUser = userRoles.some(roleName => {
        const roleConfig = settings.roles?.find(rc => rc.name === roleName);
        return roleConfig?.allowAdvancedFeatures === true;
      });

      if (isPaidUser) {
        return video;
      }

      // Check if free user waited long enough
      const startedAt = video.processing_started_at || video.created_at;
      if (startedAt && new Date(startedAt) <= thresholdDate) {
        return video;
      }
    }

    return null;
  }

  async claimJobForMigration(settings: AdminSettings): Promise<VideoEntry | null> {
    // JSON database doesn't have true locking, but we can simulate by updating status
    const candidate = await this.getOldestMigrationCandidate(settings);
    
    if (!candidate) {
      return null;
    }

    // Mark as processing to prevent workers from claiming
    const rows = await this.readAll();
    const idx = rows.findIndex(v => v.id === candidate.id);
    
    if (idx === -1) {
      return null;
    }

    // Check if still in queue (not claimed by worker)
    if (rows[idx].status !== 'in_queue') {
      return null;
    }

    rows[idx].status = 'processing';
    await this.writeAll(rows);
    
    return rows[idx];
  }

  // ==================== User Methods ====================

  private async ensureUsersDB() {
    try {
      await fs.mkdir(DATA_DIR, { recursive: true });
      await fs.access(USERS_FILE);
    } catch (err) {
      await fs.writeFile(USERS_FILE, '[]', 'utf-8');
    }
  }

  private async readAllUsers(): Promise<User[]> {
    await this.ensureUsersDB();
    const txt = await fs.readFile(USERS_FILE, 'utf-8');
    return JSON.parse(txt) as User[];
  }

  private async writeAllUsers(users: User[]) {
    await this.ensureUsersDB();
    await fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2), 'utf-8');
  }

  async createUser(username: string, password_hash: string, email?: string, roles?: string[]): Promise<User> {
    const users = await this.readAllUsers();
    const id = `user-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const created_at = new Date().toISOString();
    const user: User = {
      id,
      username,
      email,
      password_hash,
      roles: roles || [],
      created_at,
      updated_at: created_at,
    };
    users.push(user);
    await this.writeAllUsers(users);
    return user;
  }

  async getUserById(id: string): Promise<User | undefined> {
    const users = await this.readAllUsers();
    return users.find((u) => u.id === id);
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const users = await this.readAllUsers();
    return users.find((u) => u.username === username);
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    if (!email) return undefined;
    const users = await this.readAllUsers();
    return users.find((u) => u.email === email);
  }

  async updateUser(id: string, patch: Partial<Omit<User, 'id' | 'created_at'>>): Promise<User | null> {
    const users = await this.readAllUsers();
    const idx = users.findIndex((u) => u.id === id);
    if (idx === -1) return null;
    
    users[idx] = { 
      ...users[idx], 
      ...patch, 
      updated_at: new Date().toISOString() 
    } as User;
    await this.writeAllUsers(users);
    return users[idx];
  }

  async deleteUser(id: string): Promise<boolean> {
    const users = await this.readAllUsers();
    const idx = users.findIndex((u) => u.id === id);
    if (idx === -1) return false;
    
    users.splice(idx, 1);
    await this.writeAllUsers(users);
    return true;
  }

  // ==================== Admin Settings Methods ====================

  private async ensureSettingsDB() {
    try {
      await fs.mkdir(DATA_DIR, { recursive: true });
      await fs.access(SETTINGS_FILE);
    } catch (err) {
      const defaultSettings: AdminSettings = {
        id: 'default',
        registrationEnabled: true,
        freeUserQuotaPerDay: 5,
        paidUserQuotaPerDay: 50,
        maxConcurrentJobs: 5,
        maxQueueThreshold: 5000,
        loraPresets: DEFAULT_LORA_PRESETS,
        updatedAt: new Date().toISOString(),
      };
      await fs.writeFile(SETTINGS_FILE, JSON.stringify(defaultSettings, null, 2), 'utf-8');
    }
  }

  async getAdminSettings(): Promise<AdminSettings> {
    await this.ensureSettingsDB();
    const txt = await fs.readFile(SETTINGS_FILE, 'utf-8');
    const parsed = JSON.parse(txt) as AdminSettings;
    return {
      ...parsed,
      loraPresets: normalizeLoraPresets(parsed.loraPresets),
    };
  }

  async updateAdminSettings(patch: Partial<Omit<AdminSettings, 'id'>>): Promise<AdminSettings> {
    await this.ensureSettingsDB();
    const settings = await this.getAdminSettings();
    const updated: AdminSettings = {
      ...settings,
      ...patch,
      loraPresets: normalizeLoraPresets(patch.loraPresets ?? settings.loraPresets),
      id: 'default',
      updatedAt: new Date().toISOString(),
    };
    await fs.writeFile(SETTINGS_FILE, JSON.stringify(updated, null, 2), 'utf-8');
    return updated;
  }

  async getAllUsers(): Promise<UserPublic[]> {
    const users = await this.readAllUsers();
    return users.map(user => ({
      id: user.id,
      username: user.username,
      email: user.email,
      roles: user.roles,
      created_at: user.created_at,
      updated_at: user.updated_at,
    }));
  }

  // ==================== Session Methods ====================
  // Note: JSON storage is not recommended for production sessions
  // Sessions are stored in memory only and will be lost on restart

  private sessions: Map<string, import('./IDatabase').Session> = new Map();

  async createSession(userId: string, token: string, expiresAt: Date): Promise<import('./IDatabase').Session> {
    const session: import('./IDatabase').Session = {
      id: `session_${Date.now()}_${Math.random()}`,
      user_id: userId,
      token,
      expires_at: expiresAt.toISOString(),
      created_at: new Date().toISOString(),
    };
    this.sessions.set(token, session);
    return session;
  }

  async getSessionByToken(token: string): Promise<import('./IDatabase').Session | undefined> {
    return this.sessions.get(token);
  }

  async deleteSession(token: string): Promise<boolean> {
    return this.sessions.delete(token);
  }

  async deleteExpiredSessions(): Promise<number> {
    const now = new Date();
    let count = 0;
    for (const [token, session] of this.sessions.entries()) {
      if (new Date(session.expires_at) < now) {
        this.sessions.delete(token);
        count++;
      }
    }
    return count;
  }

  async deleteUserSessions(userId: string): Promise<number> {
    let count = 0;
    for (const [token, session] of this.sessions.entries()) {
      if (session.user_id === userId) {
        this.sessions.delete(token);
        count++;
      }
    }
    return count;
  }

  // ==================== Sponsor Claim Methods (JSON DB: Stub Implementation) ====================
  
  async getSponsorClaimByUsername(sponsorUsername: string): Promise<import('./IDatabase').SponsorClaim | null> {
    // JSON database doesn't support sponsor claims - always return null
    return null;
  }

  async getSponsorClaimsByUser(userId: string): Promise<import('./IDatabase').SponsorClaim[]> {
    // JSON database doesn't support sponsor claims - always return empty array
    return [];
  }

  async createSponsorClaim(claim: Omit<import('./IDatabase').SponsorClaim, 'id' | 'claimed_at' | 'expired_at'>): Promise<import('./IDatabase').SponsorClaim> {
    throw new Error('Sponsor claims are only supported with PostgreSQL database');
  }

  async deleteSponsorClaim(id: string): Promise<boolean> {
    // JSON database doesn't support sponsor claims
    return false;
  }

  async getAllSponsorClaims(): Promise<import('./IDatabase').SponsorClaim[]> {
    // JSON database doesn't support sponsor claims - always return empty array
    return [];
  }

  async expireSponsorClaim(id: string): Promise<boolean> {
    console.warn('[JSON DB] expireSponsorClaim not supported - use PostgreSQL');
    return false;
  }

  // renewSponsorClaim removed; use updateSponsorClaim with expired_at

  async updateSponsorClaim(id: string, patch: { sponsor_tier?: string; applied_role?: string }): Promise<import('./IDatabase').SponsorClaim | null> {
    console.warn('[JSON DB] updateSponsorClaim not supported - use PostgreSQL');
    return null;
  }

  // ==================== Workflow Methods (JSON DB: Stub) ====================
  async getWorkflowById(id: string): Promise<import('./IDatabase').Workflow | null> {
    console.warn('[JSON DB] getWorkflowById not supported - use PostgreSQL');
    return null;
  }

  async getWorkflows(): Promise<import('./IDatabase').Workflow[]> {
    console.warn('[JSON DB] getWorkflows not supported - use PostgreSQL');
    return [];
  }

  async getDefaultWorkflow(workflowType?: 'i2v' | 'fl2v'): Promise<import('./IDatabase').Workflow | null> {
    console.warn('[JSON DB] getDefaultWorkflow not supported - use PostgreSQL');
    return null;
  }
}
