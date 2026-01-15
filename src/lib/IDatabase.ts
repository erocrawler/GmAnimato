export type VideoEntry = {
  id: string;
  user_id: string;
  workflow_id?: string; // ID of the workflow used to generate this video
  original_image_url: string;
  last_image_url?: string; // For FL2V workflow: the last frame image
  prompt?: string;
  tags?: string[];
  suggested_prompts?: string[];
  is_photo_realistic?: boolean;
  is_nsfw?: boolean;
  status: 'uploaded' | 'in_queue' | 'processing' | 'completed' | 'failed' | 'deleted';
  job_id?: string; // RunPod job ID for status polling
  is_local_job?: boolean; // Whether this is a local job or RunPod job
  final_video_url?: string;
  is_published?: boolean;
  processing_time_ms?: number; // Time taken to process in milliseconds
  processing_started_at?: string; // ISO timestamp when job was submitted
  progress_percentage?: number; // Overall workflow progress (0-100)
  progress_details?: {
    completed_nodes?: number;
    total_nodes?: number;
    current_node?: string;
    current_node_progress?: number;
  };
  iteration_steps?: number; // 4, 6, or 8 steps
  video_duration?: number; // 4 or 6 seconds
  video_resolution?: string; // '480p' or '720p'
  lora_weights?: Record<string, number>; // LoRA weights for customization
  seed?: number; // Random seed for reproducibility
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

export type RoleConfig = {
  name: string;
  sponsorTier?: string; // Map sponsor tier (schemeName) to this role
  description?: string;
  allowAdvancedFeatures?: boolean; // Allow 720p resolution and other premium features
};

export type Workflow = {
  id: string;
  name: string;
  description?: string;
  templatePath: string;
  workflowType: 'i2v' | 'fl2v'; // Type of workflow: i2v (single image) or fl2v (two images)
  compatibleLoraIds: string[]; // Array of LoRA IDs compatible with this workflow
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
};

export type AdminSettings = {
  id: string;
  registrationEnabled: boolean;
  roles?: RoleConfig[]; // Configurable roles with tier mapping
  quotaPerDay: Record<string, number>; // Role-based quota map, e.g. { "free": 10, "gmgard-user": 50, "paid": 100, "premium": 100 }
  maxConcurrentJobs: number;
  maxQueueThreshold: number;
  localQueueThreshold: number;
  localQueueMigrationThreshold: number; // Trigger migration when local queue exceeds this
  freeUserWaitThresholdMinutes: number; // Free users must wait this long before eligible for RunPod migration
  freeUserQueueLimit: number; // Max concurrent jobs for free users
  paidUserQueueLimit: number; // Max concurrent jobs for paid users
  loraPresets?: LoraPreset[];
  sponsorApiUrl?: string; // GmCrawler sponsor API endpoint
  sponsorApiToken?: string; // Auth token for sponsor API
  updatedAt?: string;
};

export type SponsorClaim = {
  id: string;
  user_id: string;
  sponsor_username: string;
  sponsor_nickname?: string;
  sponsor_avatar?: string;
  sponsor_tier: string;
  applied_role: string;
  claimed_at: string;
};

export type PaginatedVideos = {
  videos: VideoEntry[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

export type GetVideosByUserOptions = {
  includeDeleted?: boolean;
};

export type GetPublishedVideosOptions = {
  page?: number;
  pageSize?: number;
  likedBy?: string; // Filter to only show videos liked by this user
  currentUserId?: string; // User ID to check like status for all videos
  excludeId?: string;
  status?: VideoEntry['status'];
  isNsfw?: boolean;
  sortBy?: 'date' | 'likes'; // Sort by creation date or like count
};

export type GetAllVideosOptions = {
  page?: number;
  pageSize?: number;
  userId?: string; // Filter by user ID
  username?: string; // Filter by username (partial match)
  status?: VideoEntry['status']; // Filter by status
  workflowType?: 'i2v' | 'fl2v'; // Filter by workflow type (i2v = single image, fl2v = two images)
  includeDeleted?: boolean; // Include deleted videos
};

export interface IDatabase {
  // Video methods
  createVideoEntry(entry: Omit<VideoEntry, 'id' | 'created_at'> & { id?: string }): Promise<VideoEntry>;
  getAllVideos(options?: GetAllVideosOptions): Promise<PaginatedVideos>;
  getVideosByUser(user_id: string, page?: number, pageSize?: number, options?: GetVideosByUserOptions): Promise<PaginatedVideos>;
  getActiveJobCountByUser(user_id: string): Promise<number>;
  getPublishedVideos(options?: GetPublishedVideosOptions): Promise<PaginatedVideos>;
  getVideoById(id: string): Promise<VideoEntry | undefined>;
  updateVideo(id: string, patch: Partial<VideoEntry>): Promise<VideoEntry | null>;
  deleteVideo(id: string): Promise<boolean>;
  toggleLike(videoId: string, userId: string): Promise<VideoEntry | null>;
  getLikeCount(videoId: string): Promise<number>;
  isVideoLikedByUser(videoId: string, userId: string): Promise<boolean>;
  getDailyQuotaUsage(userId: string, date: Date): Promise<number>;
  getOldestLocalJob(): Promise<VideoEntry | null>;
  claimLocalJob(): Promise<VideoEntry | null>; // Atomically claim a job for processing
  getLocalJobStats(): Promise<{ inQueue: number; processing: number; completed: number; failed: number }>;
  getOldestMigrationCandidate(settings: AdminSettings): Promise<VideoEntry | null>; // Find oldest eligible job for RunPod migration
  claimJobForMigration(settings: AdminSettings): Promise<VideoEntry | null>; // Atomically claim and mark job for migration
  
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
  
  // Sponsor claim methods
  getSponsorClaimByUsername(sponsorUsername: string): Promise<SponsorClaim | null>;
  getSponsorClaimsByUser(userId: string): Promise<SponsorClaim[]>;
  createSponsorClaim(claim: Omit<SponsorClaim, 'id' | 'claimed_at'>): Promise<SponsorClaim>;
  deleteSponsorClaim(id: string): Promise<boolean>;
  getAllSponsorClaims(): Promise<SponsorClaim[]>;

  // Workflow methods
  getWorkflowById(id: string): Promise<Workflow | null>;
  getWorkflows(): Promise<Workflow[]>;
  getDefaultWorkflow(workflowType?: 'i2v' | 'fl2v'): Promise<Workflow | null>;
}
