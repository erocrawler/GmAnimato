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

  async getVideosByUser(user_id: string, page: number = 1, pageSize: number = 12, options?: import('./IDatabase').GetVideosByUserOptions): Promise<import('./IDatabase').PaginatedVideos> {
    const rows = await this.readAll();
    const includeDeleted = options?.includeDeleted ?? false;
    let filtered = rows.filter((r) => r.user_id === user_id && (includeDeleted || r.status !== 'deleted'));
    
    // Sort by created_at descending (newest first)
    filtered.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    
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

  async getActiveJobsByUser(user_id: string): Promise<VideoEntry[]> {
    const rows = await this.readAll();
    return rows.filter((r) => 
      r.user_id === user_id && 
      (r.status === 'in_queue' || r.status === 'processing')
    );
  }

  async getPublishedVideos(options?: import('./IDatabase').GetPublishedVideosOptions): Promise<import('./IDatabase').PaginatedVideos> {
    const { page = 1, pageSize = 12, likedBy, excludeId, status, isNsfw, sortBy = 'date' } = options || {};
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
}
