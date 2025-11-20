import fs from 'fs/promises';
import path from 'path';
import type { IDatabase, VideoEntry, User } from './IDatabase';

const DATA_DIR = path.resolve('data');
const DB_FILE = path.join(DATA_DIR, 'videos.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

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

  async getVideosByUser(user_id: string): Promise<VideoEntry[]> {
    const rows = await this.readAll();
    return rows.filter((r) => r.user_id === user_id);
  }

  async getActiveJobsByUser(user_id: string): Promise<VideoEntry[]> {
    const rows = await this.readAll();
    return rows.filter((r) => 
      r.user_id === user_id && 
      (r.status === 'in_queue' || r.status === 'processing')
    );
  }

  async getPublishedVideos(): Promise<VideoEntry[]> {
    const rows = await this.readAll();
    return rows.filter((r) => r.is_published);
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
}
