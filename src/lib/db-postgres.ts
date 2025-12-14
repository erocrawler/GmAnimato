import { PrismaClient } from '@prisma/client';
import type { IDatabase, VideoEntry, User, AdminSettings, UserPublic } from './IDatabase';
import { DEFAULT_LORA_PRESETS, normalizeLoraPresets } from './loraPresets';
import { PrismaPg } from '@prisma/adapter-pg'

export class PostgresDatabase implements IDatabase {
  private prisma: PrismaClient;

  constructor(databaseUrl: string) {
    const adapter = new PrismaPg({ connectionString: databaseUrl });
    this.prisma = new PrismaClient({
      adapter: adapter
    });
  }

  // ==================== Video Methods ====================

  async createVideoEntry(entry: Omit<VideoEntry, 'id' | 'created_at'> & { id?: string }): Promise<VideoEntry> {
    const video = await this.prisma.video.create({
      data: {
        id: entry.id,
        userId: entry.user_id,
        originalImageUrl: entry.original_image_url,
        prompt: entry.prompt,
        tags: entry.tags ? JSON.stringify(entry.tags) : null,
        suggestedPrompts: entry.suggested_prompts ? JSON.stringify(entry.suggested_prompts) : null,
        isPhotoRealistic: entry.is_photo_realistic,
        isNsfw: entry.is_nsfw,
        status: entry.status,
        jobId: entry.job_id,
        isLocalJob: entry.is_local_job ?? false,
        finalVideoUrl: entry.final_video_url,
        isPublished: entry.is_published ?? false,
        iterationSteps: entry.iteration_steps,
        videoDuration: entry.video_duration,
        videoResolution: entry.video_resolution,
        loraWeights: entry.lora_weights,
        seed: entry.seed,
      },
    });

    return this.mapToVideoEntry(video);
  }

  async getAllVideos(options?: import('./IDatabase').GetAllVideosOptions): Promise<import('./IDatabase').PaginatedVideos> {
    const { page = 1, pageSize = 30, userId, username, status, includeDeleted = false } = options || {};
    const skip = (page - 1) * pageSize;
    
    const where: any = {};
    
    // Filter by deleted status
    if (!includeDeleted) {
      where.status = { not: 'deleted' };
    }
    
    // Filter by userId
    if (userId) {
      where.userId = userId;
    }
    
    // Filter by username (partial match, case-insensitive)
    if (username) {
      where.user = {
        username: {
          contains: username,
          mode: 'insensitive'
        }
      };
    }
    
    // Filter by status
    if (status) {
      where.status = status;
    }
    
    const [videos, total] = await Promise.all([
      this.prisma.video.findMany({
        where,
        include: {
          user: {
            select: {
              username: true
            }
          }
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
      }),
      this.prisma.video.count({ where })
    ]);

    return {
      videos: videos.map((v) => ({
        ...this.mapToVideoEntry(v),
        username: v.user.username
      })),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize)
    };
  }

  async getVideosByUser(user_id: string, page: number = 1, pageSize: number = 12, options?: import('./IDatabase').GetVideosByUserOptions): Promise<import('./IDatabase').PaginatedVideos> {
    const skip = (page - 1) * pageSize;
    const includeDeleted = options?.includeDeleted ?? false;

    const where: any = { userId: user_id };
    if (!includeDeleted) {
      where.status = { not: 'deleted' };
    }
    
    const [videos, total] = await Promise.all([
      this.prisma.video.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
      }),
      this.prisma.video.count({ where })
    ]);

    return {
      videos: videos.map(this.mapToVideoEntry),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize)
    };
  }

  async getActiveJobsByUser(user_id: string): Promise<VideoEntry[]> {
    const videos = await this.prisma.video.findMany({
      where: {
        userId: user_id,
        status: {
          in: ['in_queue', 'processing'],
        },
      },
      orderBy: { processingStartedAt: 'desc' },
    });

    return videos.map(this.mapToVideoEntry);
  }

  async getPublishedVideos(options?: import('./IDatabase').GetPublishedVideosOptions): Promise<import('./IDatabase').PaginatedVideos> {
    const { page = 1, pageSize = 12, likedBy, currentUserId, excludeId, status, isNsfw, sortBy = 'date' } = options || {};
    const skip = (page - 1) * pageSize;
    
    const where: any = { isPublished: true, status: { not: 'deleted' } };
    
    // Filter by liked videos if likedBy is provided (for "My Liked" filter)
    if (likedBy) {
      where.likes = {
        some: {
          userId: likedBy
        }
      };
    }
    
    // Exclude specific video if excludeId is provided
    if (excludeId) {
      where.id = { not: excludeId };
    }
    
    // Filter by status if provided
    if (status) {
      where.status = status;
    }
    
    // Filter by NSFW if provided
    if (isNsfw !== undefined) {
      where.isNsfw = isNsfw;
    }
    
    // Determine sort order
    const orderBy = sortBy === 'likes' 
      ? { likes: { _count: 'desc' as const } }
      : [{ processingStartedAt: 'desc' as const }, { createdAt: 'desc' as const }];
    
    const [videos, total] = await Promise.all([
      this.prisma.video.findMany({
        where,
        include: {
          // Only include likes from the current user to check isLiked status
          likes: currentUserId ? {
            where: { userId: currentUserId },
            select: { userId: true }
          } : false,
          _count: {
            select: { likes: true }
          }
        },
        orderBy,
        skip,
        take: pageSize,
      }),
      this.prisma.video.count({ where })
    ]);

    return {
      videos: videos.map((v) => ({
        ...this.mapToVideoEntry(v),
        likesCount: v._count.likes,
        isLiked: currentUserId ? v.likes.length > 0 : false
      })),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize)
    };
  }

  async getVideoById(id: string): Promise<VideoEntry | undefined> {
    const video = await this.prisma.video.findUnique({
      where: { id },
    });

    return video ? this.mapToVideoEntry(video) : undefined;
  }

  async updateVideo(id: string, patch: Partial<VideoEntry>): Promise<VideoEntry | null> {
    try {
      const data: any = {};
      
      if (patch.user_id !== undefined) data.userId = patch.user_id;
      if (patch.original_image_url !== undefined) data.originalImageUrl = patch.original_image_url;
      if (patch.prompt !== undefined) data.prompt = patch.prompt;
      if (patch.tags !== undefined) data.tags = patch.tags ? JSON.stringify(patch.tags) : null;
      if (patch.suggested_prompts !== undefined) data.suggestedPrompts = patch.suggested_prompts ? JSON.stringify(patch.suggested_prompts) : null;
      if (patch.is_photo_realistic !== undefined) data.isPhotoRealistic = patch.is_photo_realistic;
      if (patch.is_nsfw !== undefined) data.isNsfw = patch.is_nsfw;
      if (patch.status !== undefined) data.status = patch.status;
      if (patch.job_id !== undefined) data.jobId = patch.job_id;
      if (patch.is_local_job !== undefined) data.isLocalJob = patch.is_local_job;
      if (patch.final_video_url !== undefined) data.finalVideoUrl = patch.final_video_url;
      if (patch.is_published !== undefined) data.isPublished = patch.is_published;
      if (patch.processing_time_ms !== undefined) data.processingTimeMs = patch.processing_time_ms;
      if (patch.processing_started_at !== undefined) data.processingStartedAt = patch.processing_started_at ? new Date(patch.processing_started_at) : null;
      if (patch.progress_percentage !== undefined) data.progressPercentage = patch.progress_percentage;
      if (patch.progress_details !== undefined) data.progressDetails = patch.progress_details;
      if (patch.iteration_steps !== undefined) data.iterationSteps = patch.iteration_steps;
      if (patch.video_duration !== undefined) data.videoDuration = patch.video_duration;
      if (patch.video_resolution !== undefined) data.videoResolution = patch.video_resolution;
      if (patch.lora_weights !== undefined) data.loraWeights = patch.lora_weights;
      if (patch.seed !== undefined) data.seed = patch.seed;
      // Note: likes are handled via toggleLike method now

      const video = await this.prisma.video.update({
        where: { id },
        data,
      });

      return this.mapToVideoEntry(video);
    } catch (error) {
      return null;
    }
  }

  async deleteVideo(id: string): Promise<boolean> {
    try {
      await this.prisma.video.update({
        where: { id },
        data: {
          status: 'deleted',
          isPublished: false,
        },
      });
      return true;
    } catch (error) {
      return false;
    }
  }

  async toggleLike(videoId: string, userId: string): Promise<VideoEntry | null> {
    // Check if like exists
    const existingLike = await this.prisma.videoLike.findUnique({
      where: {
        videoId_userId: {
          videoId,
          userId,
        },
      },
    });

    let isLiked: boolean;
    
    if (existingLike) {
      // Unlike - delete the like
      await this.prisma.videoLike.delete({
        where: {
          id: existingLike.id,
        },
      });
      isLiked = false;
    } else {
      // Like - create the like
      await this.prisma.videoLike.create({
        data: {
          videoId,
          userId,
        },
      });
      isLiked = true;
    }

    // Get updated video with like count in a single query
    const video = await this.prisma.video.findUnique({
      where: { id: videoId },
      include: {
        _count: {
          select: { likes: true }
        }
      }
    });

    if (!video) return null;

    // Return video entry with like information
    return {
      ...this.mapToVideoEntry(video),
      likesCount: video._count.likes,
      isLiked
    } as any;
  }

  async getLikeCount(videoId: string): Promise<number> {
    return await this.prisma.videoLike.count({
      where: { videoId },
    });
  }

  async isVideoLikedByUser(videoId: string, userId: string): Promise<boolean> {
    const like = await this.prisma.videoLike.findUnique({
      where: {
        videoId_userId: {
          videoId,
          userId,
        },
      },
    });
    return !!like;
  }

  async getDailyQuotaUsage(userId: string, date: Date): Promise<number> {
    const startOfDay = new Date(date);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(date);
    endOfDay.setHours(23, 59, 59, 999);
    
    // Count videos that consumed quota:
    // 1. Status is completed, in_queue, or processing
    // 2. Status is deleted AND finalVideoUrl is not null (was successfully processed before deletion)
    // Count by processingStartedAt (when job was submitted)
    const count = await this.prisma.video.count({
      where: {
        userId,
        processingStartedAt: {
          gte: startOfDay,
          lte: endOfDay,
        },
        OR: [
          { status: { in: ['completed', 'in_queue', 'processing'] } },
          { 
            status: 'deleted',
            finalVideoUrl: { not: null }
          }
        ]
      }
    });
    
    return count;
  }

  async getLocalQueueLength(): Promise<number> {
    const count = await this.prisma.video.count({
      where: {
        isLocalJob: true,
        status: 'in_queue'
      }
    });
    return count;
  }

  async getOldestLocalJob(): Promise<VideoEntry | null> {
    const video = await this.prisma.video.findFirst({
      where: {
        isLocalJob: true,
        status: 'in_queue'
      },
      orderBy: {
        createdAt: 'asc'
      }
    });
    return video ? this.mapToVideoEntry(video) : null;
  }

  async claimLocalJob(): Promise<VideoEntry | null> {
    // Use a transaction to atomically find and update a job
    // This prevents race conditions where two workers claim the same job
    try {
      const video = await this.prisma.$transaction(async (tx) => {
        // Find the oldest job in queue with FOR UPDATE lock
        const job = await tx.$queryRaw<Array<{id: string}>>`
          SELECT id FROM videos 
          WHERE is_local_job = true AND status = 'in_queue'
          ORDER BY created_at ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        `;

        if (!job || job.length === 0) {
          return null;
        }

        const jobId = job[0].id;

        // Update the job status to processing
        const updated = await tx.video.update({
          where: { id: jobId },
          data: { status: 'processing' }
        });

        return updated;
      });

      return video ? this.mapToVideoEntry(video) : null;
    } catch (error) {
      console.error('[DB] Error claiming local job:', error);
      return null;
    }
  }

  async getLocalJobStats(): Promise<{ inQueue: number; processing: number; completed: number; failed: number }> {
    try {
      const stats = await this.prisma.$queryRaw<Array<{
        status: string;
        count: number;
      }>>`
        SELECT status, COUNT(*)::int as count
        FROM videos
        WHERE is_local_job = true AND status IN ('in_queue', 'processing', 'completed', 'failed')
        GROUP BY status
      `;

      let inQueue = 0;
      let processing = 0;
      let completed = 0;
      let failed = 0;

      stats.forEach(stat => {
        if (stat.status === 'in_queue') {
          inQueue = stat.count;
        } else if (stat.status === 'processing') {
          processing = stat.count;
        } else if (stat.status === 'completed') {
          completed = stat.count;
        } else if (stat.status === 'failed') {
          failed = stat.count;
        }
      });

      return { inQueue, processing, completed, failed };
    } catch (error) {
      console.error('[DB] Error getting local job stats:', error);
      return { inQueue: 0, processing: 0, completed: 0, failed: 0 };
    }
  }

  // ==================== User Methods ====================

  async createUser(username: string, password_hash: string, email?: string, roles?: string[]): Promise<User> {
    const user = await this.prisma.user.create({
      data: {
        username,
        email: email || null,
        passwordHash: password_hash,
        roles: JSON.stringify(roles || []),
      },
    });

    return this.mapToUser(user);
  }

  async getUserById(id: string): Promise<User | undefined> {
    const user = await this.prisma.user.findUnique({
      where: { id },
    });

    return user ? this.mapToUser(user) : undefined;
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const user = await this.prisma.user.findUnique({
      where: { username },
    });

    return user ? this.mapToUser(user) : undefined;
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    if (!email) return undefined;
    
    const user = await this.prisma.user.findUnique({
      where: { email },
    });

    return user ? this.mapToUser(user) : undefined;
  }

  async updateUser(id: string, patch: Partial<Omit<User, 'id' | 'created_at'>>): Promise<User | null> {
    try {
      const data: any = {};
      
      if (patch.username !== undefined) data.username = patch.username;
      if (patch.email !== undefined) data.email = patch.email || null;
      if (patch.password_hash !== undefined) data.passwordHash = patch.password_hash;
      if (patch.roles !== undefined) data.roles = JSON.stringify(patch.roles);

      const user = await this.prisma.user.update({
        where: { id },
        data,
      });

      return this.mapToUser(user);
    } catch (error) {
      return null;
    }
  }

  async deleteUser(id: string): Promise<boolean> {
    try {
      await this.prisma.user.delete({
        where: { id },
      });
      return true;
    } catch (error) {
      return false;
    }
  }

  // ==================== Session Methods ====================

  async createSession(userId: string, token: string, expiresAt: Date): Promise<import('./IDatabase').Session> {
    const session = await this.prisma.session.create({
      data: {
        userId,
        token,
        expiresAt,
      },
    });

    return {
      id: session.id,
      user_id: session.userId,
      token: session.token,
      expires_at: session.expiresAt.toISOString(),
      created_at: session.createdAt.toISOString(),
    };
  }

  async getSessionByToken(token: string): Promise<import('./IDatabase').Session | undefined> {
    const session = await this.prisma.session.findUnique({
      where: { token },
    });

    if (!session) return undefined;

    return {
      id: session.id,
      user_id: session.userId,
      token: session.token,
      expires_at: session.expiresAt.toISOString(),
      created_at: session.createdAt.toISOString(),
    };
  }

  async deleteSession(token: string): Promise<boolean> {
    try {
      await this.prisma.session.delete({
        where: { token },
      });
      return true;
    } catch (error) {
      return false;
    }
  }

  async deleteExpiredSessions(): Promise<number> {
    const result = await this.prisma.session.deleteMany({
      where: {
        expiresAt: {
          lt: new Date(),
        },
      },
    });
    return result.count;
  }

  async deleteUserSessions(userId: string): Promise<number> {
    const result = await this.prisma.session.deleteMany({
      where: { userId },
    });
    return result.count;
  }

  // ==================== Admin Settings Methods ====================

  async getAdminSettings(): Promise<AdminSettings> {
    let settings = await this.prisma.adminSettings.findUnique({
      where: { id: 'default' },
    });

    // Create default settings if they don't exist
    if (!settings) {
      settings = await this.prisma.adminSettings.create({
        data: {
          id: 'default',
          registrationEnabled: true,
          quotaPerDay: { "free-tier": 10, "gmgard-user": 50, "paid-tier": 100, "premium-tier": 100 },
          maxConcurrentJobs: 5,
          maxQueueThreshold: 5000,
          loraPresets: DEFAULT_LORA_PRESETS,
        },
      });
    }

    return this.mapToAdminSettings(settings);
  }

  async updateAdminSettings(patch: Partial<Omit<AdminSettings, 'id'>>): Promise<AdminSettings> {
    const data: any = {};
    
    if (patch.registrationEnabled !== undefined) data.registrationEnabled = patch.registrationEnabled;
    if (patch.quotaPerDay !== undefined) data.quotaPerDay = patch.quotaPerDay;
    if (patch.maxConcurrentJobs !== undefined) data.maxConcurrentJobs = patch.maxConcurrentJobs;
    if (patch.maxQueueThreshold !== undefined) data.maxQueueThreshold = patch.maxQueueThreshold;
    if (patch.localQueueThreshold !== undefined) data.localQueueThreshold = patch.localQueueThreshold;
    if (patch.loraPresets !== undefined) data.loraPresets = normalizeLoraPresets(patch.loraPresets);

    const settings = await this.prisma.adminSettings.upsert({
      where: { id: 'default' },
      update: data,
      create: {
        id: 'default',
        registrationEnabled: patch.registrationEnabled ?? true,
        quotaPerDay: patch.quotaPerDay ?? { "free-tier": 10, "gmgard-user": 50, "paid-tier": 100, "premium-tier": 100 },
        maxConcurrentJobs: patch.maxConcurrentJobs ?? 5,
        maxQueueThreshold: patch.maxQueueThreshold ?? 5000,
        localQueueThreshold: patch.localQueueThreshold ?? 0,
        loraPresets: normalizeLoraPresets(patch.loraPresets) ?? DEFAULT_LORA_PRESETS,
      },
    });

    return this.mapToAdminSettings(settings);
  }

  async getAllUsers(): Promise<UserPublic[]> {
    const users = await this.prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
    });

    return users.map(user => ({
      id: user.id,
      username: user.username,
      email: user.email || undefined,
      roles: JSON.parse(user.roles),
      created_at: user.createdAt.toISOString(),
      updated_at: user.updatedAt.toISOString(),
    }));
  }

  // ==================== Mapping Methods ====================

  private mapToVideoEntry(video: any): VideoEntry {
    return {
      id: video.id,
      user_id: video.userId,
      original_image_url: video.originalImageUrl,
      prompt: video.prompt || undefined,
      tags: video.tags ? JSON.parse(video.tags) : undefined,
      suggested_prompts: video.suggestedPrompts ? JSON.parse(video.suggestedPrompts) : undefined,
      is_photo_realistic: video.isPhotoRealistic ?? undefined,
      is_nsfw: video.isNsfw ?? undefined,
      status: video.status as VideoEntry['status'],
      job_id: video.jobId || undefined,
      is_local_job: video.isLocalJob ?? undefined,
      final_video_url: video.finalVideoUrl || undefined,
      is_published: video.isPublished || undefined,
      processing_time_ms: video.processingTimeMs ?? undefined,
      processing_started_at: video.processingStartedAt ? video.processingStartedAt.toISOString() : undefined,
      progress_percentage: video.progressPercentage ?? undefined,
      progress_details: video.progressDetails || undefined,
      iteration_steps: video.iterationSteps ?? undefined,
      video_duration: video.videoDuration ?? undefined,
      video_resolution: video.videoResolution || undefined,
      lora_weights: video.loraWeights || undefined,
      seed: video.seed ?? undefined,
      likes: [], // Deprecated - use getLikeCount() and isVideoLikedByUser() instead
      created_at: video.createdAt.toISOString(),
    };
  }

  private mapToUser(user: any): User {
    return {
      id: user.id,
      username: user.username,
      email: user.email || undefined,
      password_hash: user.passwordHash,
      roles: JSON.parse(user.roles),
      created_at: user.createdAt.toISOString(),
      updated_at: user.updatedAt.toISOString(),
    };
  }

  private mapToAdminSettings(settings: any): AdminSettings {
    // Parse quotaPerDay if it's a string, otherwise use as-is
    const quotaPerDay = typeof settings.quotaPerDay === 'string' 
      ? JSON.parse(settings.quotaPerDay) 
      : (settings.quotaPerDay || { "free-tier": 10, "gmgard-user": 50, "paid-tier": 100, "premium-tier": 100 });
    
    return {
      id: settings.id,
      registrationEnabled: settings.registrationEnabled,
      quotaPerDay,
      maxConcurrentJobs: settings.maxConcurrentJobs,
      maxQueueThreshold: settings.maxQueueThreshold,
      localQueueThreshold: settings.localQueueThreshold,
      loraPresets: normalizeLoraPresets(settings.loraPresets ?? DEFAULT_LORA_PRESETS),
      updatedAt: settings.updatedAt.toISOString(),
    };
  }

  async disconnect() {
    await this.prisma.$disconnect();
  }
}
