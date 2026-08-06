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
  processing_started_at?: string; // ISO timestamp when job was enqueued
  dequeued_at?: string; // ISO timestamp when job was dequeued and actually started processing
  progress_percentage?: number; // Overall workflow progress (0-100)
  progress_details?: {
    completed_nodes?: number;
    total_nodes?: number;
    current_node?: string;
    current_node_progress?: number;
  };
  iteration_steps?: number; // 4, 6, or 8 steps
  video_duration?: number; // 4, 6, 8, or 10 seconds (8 = MiniMax H3 premium only)
  video_resolution?: string; // '480p' or '720p'
  quota_cost?: number; // Credits this video consumed (snapshot of workflow quotaCost at kickoff)
  validation_metadata?: {
    manual_recognition_done?: boolean;
    manual_recognition_requested_at?: string;
    manual_recognition_completed_at?: string;
    manual_recognition_error?: string;
    revalidation_status?: 'idle' | 'pending' | 'processing' | 'completed' | 'failed';
    revalidation_requested_at?: string;
    revalidation_completed_at?: string;
    revalidation_error?: string;
  };
  additional_options?: {
    motion_scale?: number; // Motion scale (0.5 to 2.0)
    freelong_blend_strength?: number; // FreeLong blend strength (0 to 1)
    prompt_relay_mode?: boolean;
    prompt_relay_segments?: { prompt: string; frames: number }[];
    // Add future options here without DB migration
  };
  lora_weights?: Record<string, number>; // LoRA weights for customization
  seed?: number; // Random seed for reproducibility
  likesCount?: number; // Total like count (when available)
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

export type GalleryState = {
  lastVideoId?: string;       // Last video the user was viewing in the short feed
  newestSeenId?: string;      // Newest video ID the user has seen (for "new videos" count)
  lastVisitAt?: string;       // ISO timestamp of last visit
  history?: string[];         // Recently viewed video IDs (max ~20), for the history dropdown
};

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
  // Preset mechanism extensions
  tags?: string[]; // e.g. ['wan22', 'nsfw'] — used for auto-matching LoRAs
  autoIncludeNewLoras?: boolean; // if true, new LoRAs with matching tags auto-added
  presetGroup?: string; // optional UI grouping
  quotaCost?: number; // Credits consumed per video generated with this workflow (default 1)
  quotaCostRules?: import('./quotaCost').QuotaCostRule[]; // Optional multiplier rules (e.g. 2x if duration >= 8s)
  isDefault: boolean;
  isDeleted: boolean; // Soft-delete: workflow is retired but kept for historical video reference
  createdAt: string;
  updatedAt: string;
};

export type AdminSettings = {
  id: string;
  registrationEnabled: boolean;
  registrationPasscode?: string; // Optional passcode required to register
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
  deviceId?: string; // Device ID for sponsor API requests
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
  expired_at?: string | null;
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
  sortBy?: 'upload' | 'completion'; // Sort by upload time (created_at) or completion time (when status became 'completed')
  sortDirection?: 'asc' | 'desc'; // Sort ascending or descending
  status?: VideoEntry['status']; // Filter by video status
  isPublished?: boolean; // Filter by published status
  modelTypeIds?: string[]; // Filter by specific model/workflow IDs (multi-select)
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
  afterValue?: string; // Cursor-based pagination: skip up to and including this video ID (exclusive)
  startAtId?: string; // Start from this video ID (inclusive) — for "resume position"
};

export type GetAllVideosOptions = {
  page?: number;
  pageSize?: number;
  userId?: string; // Filter by user ID
  username?: string; // Filter by username (partial match)
  status?: VideoEntry['status']; // Filter by status
  workflowType?: 'i2v' | 'fl2v'; // Filter by workflow type (i2v = single image, fl2v = two images)
  modelTypeIds?: string[]; // Filter by specific model/workflow IDs (multi-select). Implies workflowType.
  includeDeleted?: boolean; // Include deleted videos
};

export type VideoModelType = {
  id: string; // Workflow ID (or 'unassigned' for videos without a workflow)
  name: string; // Display name (workflow name or fallback)
  workflowType?: 'i2v' | 'fl2v'; // The broad category, if known
  available: boolean; // true = workflow exists and is not soft-deleted
  isDeleted: boolean; // true = soft-deleted (name/type known but no longer usable)
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
  getVideoModelTypes(): Promise<VideoModelType[]>; // Distinct model/workflow types present in the video table (includes legacy/unavailable)
  
  // User methods
  createUser(username: string, password_hash: string, email?: string, roles?: string[]): Promise<User>;
  getUserById(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  getUserByEmail(email: string): Promise<User | undefined>;
  updateUser(id: string, patch: Partial<Omit<User, 'id' | 'created_at'>>): Promise<User | null>;
  deleteUser(id: string): Promise<boolean>;
  getGalleryState(userId: string): Promise<GalleryState | null>;
  setGalleryState(userId: string, state: GalleryState): Promise<void>;
  
  // Session/Refresh token methods (used for token refresh)
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
  createSponsorClaim(claim: Omit<SponsorClaim, 'id' | 'claimed_at' | 'expired_at'>): Promise<SponsorClaim>;
  deleteSponsorClaim(id: string): Promise<boolean>;
  expireSponsorClaim(id: string): Promise<boolean>;
  updateSponsorClaim(id: string, patch: { sponsor_tier?: string; applied_role?: string; expired_at?: string | null }): Promise<SponsorClaim | null>;
  getAllSponsorClaims(): Promise<SponsorClaim[]>;

  // Workflow methods
  getWorkflowById(id: string): Promise<Workflow | null>;
  getWorkflows(): Promise<Workflow[]>;
  getAllWorkflowsIncludingDeleted(): Promise<Workflow[]>; // Admin: includes soft-deleted workflows
  getDefaultWorkflow(workflowType?: 'i2v' | 'fl2v'): Promise<Workflow | null>;
  createWorkflow(data: Omit<Workflow, 'createdAt' | 'updatedAt'>): Promise<Workflow>;
  updateWorkflow(id: string, patch: Partial<Omit<Workflow, 'id' | 'createdAt'>>): Promise<Workflow | null>;
  deleteWorkflow(id: string): Promise<boolean>;
  restoreWorkflow(id: string): Promise<Workflow | null>; // Un-soft-delete a workflow
  setDefaultWorkflow(id: string): Promise<Workflow | null>;
}
