export type VideoEntry = {
  id: string;
  user_id: string;
  original_image_url: string;
  prompt?: string;
  tags?: string[];
  suggested_prompts?: string[];
  is_photo_realistic?: boolean;
  is_nsfw?: boolean;
  status: 'uploaded' | 'in_queue' | 'processing' | 'completed' | 'failed';
  job_id?: string; // RunPod job ID for status polling
  final_video_url?: string;
  is_published?: boolean;
  processing_time_ms?: number; // Time taken to process in milliseconds
  processing_started_at?: string; // ISO timestamp when job was submitted
  likes?: string[]; // Array of user_ids who liked this video
  created_at: string;
};

export type User = {
  id: string;
  username: string;
  email?: string;
  password_hash: string; // Hashed password
  roles: string[];
  created_at: string;
  updated_at?: string;
};

export type UserPublic = Omit<User, 'password_hash'>;

export type Session = {
  id: string;
  user_id: string;
  token: string;
  expires_at: string;
  created_at: string;
};

import type { LoraPreset } from './loraPresets';

export type AdminSettings = {
  id: string;
  registrationEnabled: boolean;
  freeUserQuotaPerDay: number;
  paidUserQuotaPerDay: number;
  maxConcurrentJobs: number;
  maxQueueThreshold: number;
  loraPresets?: LoraPreset[];
  updatedAt?: string;
};

export type PaginatedVideos = {
  videos: VideoEntry[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

export type GetPublishedVideosOptions = {
  page?: number;
  pageSize?: number;
  likedBy?: string; // Filter to only show videos liked by this user
  currentUserId?: string; // User ID to check like status for all videos
  excludeId?: string;
  status?: VideoEntry['status'];
  isNsfw?: boolean;
};

export interface IDatabase {
  // Video methods
  createVideoEntry(entry: Omit<VideoEntry, 'id' | 'created_at'> & { id?: string }): Promise<VideoEntry>;
  getVideosByUser(user_id: string, page?: number, pageSize?: number): Promise<PaginatedVideos>;
  getActiveJobsByUser(user_id: string): Promise<VideoEntry[]>;
  getPublishedVideos(options?: GetPublishedVideosOptions): Promise<PaginatedVideos>;
  getVideoById(id: string): Promise<VideoEntry | undefined>;
  updateVideo(id: string, patch: Partial<VideoEntry>): Promise<VideoEntry | null>;
  deleteVideo(id: string): Promise<boolean>;
  toggleLike(videoId: string, userId: string): Promise<VideoEntry | null>;
  getLikeCount(videoId: string): Promise<number>;
  isVideoLikedByUser(videoId: string, userId: string): Promise<boolean>;
  
  // User methods
  createUser(username: string, password_hash: string, email?: string, roles?: string[]): Promise<User>;
  getUserById(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  getUserByEmail(email: string): Promise<User | undefined>;
  updateUser(id: string, patch: Partial<Omit<User, 'id' | 'created_at'>>): Promise<User | null>;
  deleteUser(id: string): Promise<boolean>;
  
  // Session methods
  createSession(userId: string, token: string, expiresAt: Date): Promise<Session>;
  getSessionByToken(token: string): Promise<Session | undefined>;
  deleteSession(token: string): Promise<boolean>;
  deleteExpiredSessions(): Promise<number>;
  deleteUserSessions(userId: string): Promise<number>;
  
  // Admin settings methods
  getAdminSettings(): Promise<AdminSettings>;
  updateAdminSettings(patch: Partial<Omit<AdminSettings, 'id'>>): Promise<AdminSettings>;
  getAllUsers(): Promise<UserPublic[]>;
}
