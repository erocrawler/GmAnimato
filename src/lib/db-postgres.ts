import { PrismaClient } from '@prisma/client';
import type { IDatabase, VideoEntry, User, AdminSettings, UserPublic, Workflow, SponsorClaim } from './IDatabase';
import { DEFAULT_LORA_PRESETS, normalizeLoraPresets } from './loraPresets';
import { normalizeQuotaCostRules } from './quotaCost';
import { PrismaPg } from '@prisma/adapter-pg'

export class PostgresDatabase implements IDatabase {
  public prisma: PrismaClient;

  constructor(databaseUrl: string) {
    const adapter = new PrismaPg({ connectionString: databaseUrl });
    this.prisma = new PrismaClient({
      adapter: adapter
    });
  }

  // ==================== Video Methods ====================

  async createVideoEntry(entry: Omit<VideoEntry, 'id' | 'created_at'> & { id?: string }): Promise<VideoEntry> {
    const data: any = {
      id: entry.id,
      userId: entry.user_id,
      workflowId: entry.workflow_id,
      originalImageUrl: entry.original_image_url,
      lastImageUrl: entry.last_image_url,
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
      validationMetadata: entry.validation_metadata,
      additionalOptions: entry.additional_options,
      loraWeights: entry.lora_weights,
      seed: entry.seed,
      processingStartedAt: entry.processing_started_at ? new Date(entry.processing_started_at) : null,
      dequeuedAt: entry.dequeued_at ? new Date(entry.dequeued_at) : null,
    };

    const video = await this.prisma.video.create({
      data,
    });

    return this.mapToVideoEntry(video);
  }

  async getAllVideos(options?: import('./IDatabase').GetAllVideosOptions): Promise<import('./IDatabase').PaginatedVideos> {
    const { page = 1, pageSize = 30, userId, username, status, workflowType, modelTypeIds, includeDeleted = false } = options || {};
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
    
    // Filter by model type (specific workflow IDs). This implies the workflow type,
    // so when modelTypeIds is provided we don't also apply the broad workflowType filter.
    if (modelTypeIds && modelTypeIds.length > 0) {
      // 'unassigned' is a sentinel value used by getVideoModelTypes for videos with no workflow
      const hasUnassigned = modelTypeIds.includes('unassigned');
      const ids = modelTypeIds.filter((id) => id !== 'unassigned');
      const workflowIdClause = ids.length > 0 ? { workflowId: { in: ids } } : {};
      if (hasUnassigned && ids.length > 0) {
        where.OR = [
          workflowIdClause,
          { workflowId: null }
        ];
      } else if (hasUnassigned) {
        where.workflowId = null;
      } else {
        Object.assign(where, workflowIdClause);
      }
    } else if (workflowType) {
      // Filter by workflow type (broad category)
      where.workflow = {
        workflowType: workflowType
      };
    }
    
    const [videos, total] = await Promise.all([
      this.prisma.video.findMany({
        where,
        include: {
          user: {
            select: {
              username: true
            }
          },
          workflow: true,
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
      }),
      this.prisma.video.count({ where })
    ]);

    return {
      videos: videos.map((v) => (({
        ...this.mapToVideoEntry(v),
        username: v.user.username
      }))),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize)
    };
  }

  async getVideoModelTypes(): Promise<import('./IDatabase').VideoModelType[]> {
    // Gather distinct workflowIds actually referenced by videos
    const videoWorkflowIds = await this.prisma.video.findMany({
      where: { workflowId: { not: null } },
      select: { workflowId: true },
      distinct: ['workflowId'],
    });
    const ids = videoWorkflowIds.map((v) => v.workflowId!).filter(Boolean) as string[];

    // Count videos that have no workflow assigned (null workflowId)
    const unassignedCount = await this.prisma.video.count({ where: { workflowId: null } });

    // Fetch ALL matching workflows including soft-deleted ones so names/types are preserved
    const workflows = ids.length > 0
      ? await this.prisma.workflow.findMany({ where: { id: { in: ids } } })
      : [];
    const workflowMap = new Map(workflows.map((w) => [w.id, w]));

    const result: import('./IDatabase').VideoModelType[] = ids.map((id) => {
      const wf = workflowMap.get(id);
      // wf exists: it was soft-deleted (isDeleted=true) or is active
      // wf missing: it was hard-deleted before the soft-delete migration
      return {
        id,
        name: wf?.name ?? id,
        workflowType: (wf?.workflowType ?? undefined) as 'i2v' | 'fl2v' | undefined,
        available: Boolean(wf) && !wf!.isDeleted,
        isDeleted: wf ? Boolean(wf.isDeleted) : false,
      };
    });

    if (unassignedCount > 0) {
      result.push({
        id: 'unassigned',
        name: 'Unassigned (no model)',
        workflowType: undefined,
        available: false,
        isDeleted: false,
      });
    }

    // Sort: active first (by name), then deleted (by name), then unknown/unassigned last
    result.sort((a, b) => {
      const aRank = a.available ? 0 : a.isDeleted ? 1 : 2;
      const bRank = b.available ? 0 : b.isDeleted ? 1 : 2;
      if (aRank !== bRank) return aRank - bRank;
      return a.name.localeCompare(b.name);
    });

    return result;
  }

  async getVideosByUser(user_id: string, page: number = 1, pageSize: number = 12, options?: import('./IDatabase').GetVideosByUserOptions): Promise<import('./IDatabase').PaginatedVideos> {
    const skip = (page - 1) * pageSize;
    const includeDeleted = options?.includeDeleted ?? false;
    const sortBy = options?.sortBy ?? 'upload';
    const sortDirection = options?.sortDirection ?? 'desc';

    const where: any = { userId: user_id };
    if (!includeDeleted) {
      where.status = { not: 'deleted' };
    }
    if (options?.status) {
      where.status = options.status;
    }
    if (options?.isPublished !== undefined) {
      where.isPublished = options.isPublished;
    }
    if (options?.modelTypeIds && options.modelTypeIds.length > 0) {
      const hasUnassigned = options.modelTypeIds.includes('unassigned');
      const ids = options.modelTypeIds.filter((id) => id !== 'unassigned');
      const clauses: any[] = [];
      if (ids.length > 0) clauses.push({ workflowId: { in: ids } });
      if (hasUnassigned) clauses.push({ workflowId: null as any });
      if (clauses.length === 1) Object.assign(where, clauses[0]);
      else if (clauses.length > 1) where.OR = clauses;
    }

    const orderBy = sortBy === 'completion' ? { completionTime: sortDirection } : { createdAt: sortDirection };

    const [videos, total] = await Promise.all([
      this.prisma.video.findMany({ where, orderBy, skip, take: pageSize }),
      this.prisma.video.count({ where })
    ]);

    return {
      videos: videos.map((video: any) => ({
        ...this.mapToVideoEntry(video),
        likesCount: video.likesCountCache ?? 0
      })),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize)
    };
  }

  async getActiveJobCountByUser(user_id: string): Promise<number> {
    const count = await this.prisma.video.count({
      where: {
        userId: user_id,
        status: {
          in: ['in_queue', 'processing'],
        },
      },
    });

    return count;
  }

  async getPublishedVideos(options?: import('./IDatabase').GetPublishedVideosOptions): Promise<import('./IDatabase').PaginatedVideos> {
    const { page = 1, pageSize = 12, likedBy, currentUserId, excludeId, status, isNsfw, sortBy = 'date', afterValue, startAtId } = options || {};
    const skip = (page - 1) * pageSize;
    const baseWhere: any = { isPublished: true, status: { not: 'deleted' } };
    let where: any = { ...baseWhere };
    const cursorId = afterValue || startAtId;
    const useCursor = Boolean(cursorId);

    if (cursorId) {
      const cursorVideo = await this.prisma.video.findUnique({
        where: { id: cursorId },
        select: { processingStartedAt: true, createdAt: true, likesCountCache: true },
      });
      if (cursorVideo) {
        if (sortBy === 'likes') {
          const op = startAtId ? 'lte' : 'lt';
          where.AND = [
            {
              OR: [
                { likesCountCache: { lt: cursorVideo.likesCountCache } },
                {
                  likesCountCache: cursorVideo.likesCountCache,
                  processingStartedAt: { lt: cursorVideo.processingStartedAt },
                },
                {
                  likesCountCache: cursorVideo.likesCountCache,
                  processingStartedAt: cursorVideo.processingStartedAt,
                  createdAt: { [op]: cursorVideo.createdAt },
                },
              ],
            },
          ];
        } else {
          const op = startAtId ? 'lte' : 'lt';
          where.AND = [
            {
              OR: [
                { processingStartedAt: { lt: cursorVideo.processingStartedAt } },
                {
                  processingStartedAt: cursorVideo.processingStartedAt,
                  createdAt: { [op]: cursorVideo.createdAt },
                },
              ],
            },
          ];
        }
      }
      if (afterValue) {
        where.id = where.id ? { ...where.id, not: afterValue } : { not: afterValue };
      }
    }

    if (likedBy) {
      where.likes = { some: { userId: likedBy } };
    }
    if (excludeId) {
      where.id = where.id ? { ...where.id, not: excludeId } : { not: excludeId };
    }
    if (status) {
      where.status = status;
    }
    if (isNsfw !== undefined) {
      where.isNsfw = isNsfw;
    }

    const orderBy =
      sortBy === 'likes'
        ? [{ likesCountCache: 'desc' as const }, { processingStartedAt: 'desc' as const }, { createdAt: 'desc' as const }]
        : [{ processingStartedAt: 'desc' as const }, { createdAt: 'desc' as const }];

    const totalWhere: any = { ...baseWhere };
    if (likedBy) totalWhere.likes = { some: { userId: likedBy } };
    if (excludeId) totalWhere.id = { not: excludeId };
    if (status) totalWhere.status = status;
    if (isNsfw !== undefined) totalWhere.isNsfw = isNsfw;

    const [videos, total] = await Promise.all([
      this.prisma.video.findMany({
        where,
        include: {
          likes: currentUserId ? { where: { userId: currentUserId }, select: { userId: true } } : false,
        },
        orderBy,
        skip: useCursor ? 0 : skip,
        take: pageSize,
      }),
      this.prisma.video.count({ where: totalWhere }),
    ]);

    return {
      videos: videos.map((v: any) => ({
        ...this.mapToVideoEntry(v),
        likesCount: v.likesCountCache ?? 0,
        isLiked: currentUserId ? v.likes.length > 0 : false,
      })),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  async getVideoById(id: string): Promise<VideoEntry | undefined> {
    const video = await this.prisma.video.findUnique({
      where: { id },
      include: {
        workflow: true,
      },
    });

    return video ? this.mapToVideoEntry(video) : undefined;
  }

  async updateVideo(id: string, patch: Partial<VideoEntry>): Promise<VideoEntry | null> {
    try {
      const data: any = {};
      
      if (patch.user_id !== undefined) data.userId = patch.user_id;
      if (patch.workflow_id !== undefined) data.workflowId = patch.workflow_id;
      if (patch.original_image_url !== undefined) data.originalImageUrl = patch.original_image_url;
      if (patch.last_image_url !== undefined) data.lastImageUrl = patch.last_image_url;
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
      if (patch.dequeued_at !== undefined) data.dequeuedAt = patch.dequeued_at ? new Date(patch.dequeued_at) : null;
      if (patch.progress_percentage !== undefined) data.progressPercentage = patch.progress_percentage;
      if (patch.progress_details !== undefined) data.progressDetails = patch.progress_details;
      if (patch.iteration_steps !== undefined) data.iterationSteps = patch.iteration_steps;
      if (patch.video_duration !== undefined) data.videoDuration = patch.video_duration;
      if (patch.video_resolution !== undefined) data.videoResolution = patch.video_resolution;
      if (patch.validation_metadata !== undefined) data.validationMetadata = patch.validation_metadata;
      if (patch.additional_options !== undefined) data.additionalOptions = patch.additional_options;
      if (patch.lora_weights !== undefined) data.loraWeights = patch.lora_weights;
      if (patch.seed !== undefined) data.seed = patch.seed;

      const video = await this.prisma.video.update({
        where: { id },
        data,
      });

      return this.mapToVideoEntry(video);
    } catch (error) {
      // Re-throw so the caller's own error handling surfaces it.
      console.error('[DB] updateVideo error for id', id, ':', error);
      throw error;
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
    // DB trigger maintains likesCountCache — no app-level increment to avoid double count
    const existingLike = await this.prisma.videoLike.findUnique({
      where: { videoId_userId: { videoId, userId } },
    });

    let isLiked: boolean;
    if (existingLike) {
      await this.prisma.videoLike.delete({ where: { id: existingLike.id } });
      isLiked = false;
    } else {
      await this.prisma.videoLike.create({ data: { videoId, userId } });
      isLiked = true;
    }

    // Trigger has already updated likes_count_cache; fetch fresh video
    const video = await this.prisma.video.findUnique({ where: { id: videoId } });
    if (!video) return null;
    return {
      ...this.mapToVideoEntry(video),
      likesCount: video.likesCountCache,
      isLiked,
    } as any;
  }

  async getLikeCount(videoId: string): Promise<number> {
    // Use cached counter — trigger keeps it accurate
    const video = await this.prisma.video.findUnique({
      where: { id: videoId },
      select: { likesCountCache: true },
    });
    return video?.likesCountCache ?? 0;
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
    
    // Sum credits consumed today. Videos without an explicit quota_cost default
    // to 1 (backfilled by the migration), so legacy rows count as 1 each.
    const result = await this.prisma.video.aggregate({
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
      },
      _sum: { quotaCost: true },
    });
    
    return result._sum.quotaCost ?? 0;
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

        // Update the job status to processing and record when processing actually started
        const updated = await tx.video.update({
          where: { id: jobId },
          data: { 
            status: 'processing',
            dequeuedAt: new Date()
          }
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

  async getOldestMigrationCandidate(settings: AdminSettings): Promise<VideoEntry | null> {
    try {
      // Find oldest local queue job where user is paid OR has waited >= threshold minutes
      const thresholdMinutes = settings.freeUserWaitThresholdMinutes || 30;
      const thresholdDate = new Date(Date.now() - thresholdMinutes * 60 * 1000);

      // Get all pending local jobs with user info
      const candidates = await this.prisma.video.findMany({
        where: {
          isLocalJob: true,
          status: 'in_queue'
        },
        include: {
          user: true
        },
        orderBy: {
          processingStartedAt: 'asc'
        },
        take: 100 // Limit to prevent loading entire queue
      });

      // Filter for eligible candidates (paid users OR free users who waited long enough)
      for (const video of candidates) {
        const userRoles = JSON.parse(video.user.roles || '[]') as string[];
        
        // Check if user is paid (has any role with allowAdvancedFeatures)
        const isPaidUser = userRoles.some(roleName => {
          const roleConfig = settings.roles?.find(rc => rc.name === roleName);
          return roleConfig?.allowAdvancedFeatures === true;
        });

        // If paid user, they're eligible immediately
        if (isPaidUser) {
          return this.mapToVideoEntry(video);
        }

        // If free user, check if they've waited long enough
        if (video.processingStartedAt && new Date(video.processingStartedAt) <= thresholdDate) {
          return this.mapToVideoEntry(video);
        }
      }

      return null;
    } catch (error) {
      console.error('[DB] Error getting oldest migration candidate:', error);
      return null;
    }
  }

  async claimJobForMigration(settings: AdminSettings): Promise<VideoEntry | null> {
    // Atomically claim a job for migration to prevent race condition with worker claiming
    // This uses FOR UPDATE SKIP LOCKED to ensure only one process can claim the job
    try {
      const thresholdMinutes = settings.freeUserWaitThresholdMinutes || 30;
      const thresholdDate = new Date(Date.now() - thresholdMinutes * 60 * 1000);

      const video = await this.prisma.$transaction(async (tx) => {
        // Find eligible jobs with FOR UPDATE lock
        const candidates = await tx.$queryRaw<Array<{
          id: string;
          user_id: string;
          processing_started_at: Date | null;
        }>>`
          SELECT v.id, v.user_id, v.processing_started_at
          FROM videos v
          INNER JOIN users u ON v.user_id = u.id
          WHERE v.is_local_job = true AND v.status = 'in_queue'
          ORDER BY v.processing_started_at ASC
          LIMIT 100
          FOR UPDATE SKIP LOCKED
        `;

        if (!candidates || candidates.length === 0) {
          return null;
        }

        // Check each candidate for eligibility
        for (const candidate of candidates) {
          // Get user to check roles
          const user = await tx.user.findUnique({
            where: { id: candidate.user_id }
          });

          if (!user) continue;

          const userRoles = JSON.parse(user.roles || '[]') as string[];
          
          // Check if user is paid
          const isPaidUser = userRoles.some(roleName => {
            const roleConfig = settings.roles?.find(rc => rc.name === roleName);
            return roleConfig?.allowAdvancedFeatures === true;
          });

          // Check eligibility
          const isEligible = isPaidUser || 
            (candidate.processing_started_at && new Date(candidate.processing_started_at) <= thresholdDate);

          if (isEligible) {
            // Mark as migrating by setting status to 'processing' temporarily
            // This prevents workers from claiming it
            const updated = await tx.video.update({
              where: { id: candidate.id },
              data: { status: 'processing' }
            });

            return updated;
          }
        }

        return null;
      });

      return video ? this.mapToVideoEntry(video) : null;
    } catch (error) {
      console.error('[DB] Error claiming job for migration:', error);
      return null;
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

  async getGalleryState(userId: string): Promise<import('./IDatabase').GalleryState | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { galleryState: true },
    });
    if (!user?.galleryState) return null;
    const state = typeof user.galleryState === 'string'
      ? JSON.parse(user.galleryState)
      : user.galleryState;
    return state as import('./IDatabase').GalleryState;
  }

  async setGalleryState(userId: string, state: import('./IDatabase').GalleryState): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { galleryState: state as any },
    });
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
          quotaPerDay: { "gmgard-user": 5 },
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
    if (patch.roles !== undefined) data.roles = patch.roles;
    if (patch.quotaPerDay !== undefined) data.quotaPerDay = patch.quotaPerDay;
    if (patch.maxConcurrentJobs !== undefined) data.maxConcurrentJobs = patch.maxConcurrentJobs;
    if (patch.maxQueueThreshold !== undefined) data.maxQueueThreshold = patch.maxQueueThreshold;
    if (patch.localQueueThreshold !== undefined) data.localQueueThreshold = patch.localQueueThreshold;
    if (patch.localQueueMigrationThreshold !== undefined) data.localQueueMigrationThreshold = patch.localQueueMigrationThreshold;
    if (patch.freeUserWaitThresholdMinutes !== undefined) data.freeUserWaitThresholdMinutes = patch.freeUserWaitThresholdMinutes;
    if (patch.freeUserQueueLimit !== undefined) data.freeUserQueueLimit = patch.freeUserQueueLimit;
    if (patch.paidUserQueueLimit !== undefined) data.paidUserQueueLimit = patch.paidUserQueueLimit;
    let newLoraIds: string[] = [];
    let newLoras: any[] = [];
    let removedLoraIds: string[] = [];
    let validLoraIds: Set<string> | null = null;
    if (patch.loraPresets !== undefined) {
      const normalized = normalizeLoraPresets(patch.loraPresets);
      data.loraPresets = normalized;
      validLoraIds = new Set(normalized.map(l => l.id));
      // Detect new vs removed LoRA IDs vs existing (rename = old removed + new added)
      try {
        const existing = await this.prisma.adminSettings.findUnique({ where: { id: 'default' }, select: { loraPresets: true } });
        const existedNormalized = normalizeLoraPresets((existing?.loraPresets as any) ?? []);
        const oldIds = new Set(existedNormalized.map(l => l.id));
        const newIds = new Set(normalized.map(l => l.id));
        newLoras = normalized.filter(l => !oldIds.has(l.id));
        newLoraIds = newLoras.map(l => l.id);
        removedLoraIds = [...oldIds].filter(id => !newIds.has(id));
      } catch { /* ignore */ }
    }
    
    // Store sponsor config as JSON for flexibility
    const sponsorConfig: any = {};
    if (patch.sponsorApiUrl !== undefined) sponsorConfig.sponsorApiUrl = patch.sponsorApiUrl;
    if (patch.sponsorApiToken !== undefined) sponsorConfig.sponsorApiToken = patch.sponsorApiToken;
    if (patch.deviceId !== undefined) sponsorConfig.deviceId = patch.deviceId;
    if (patch.registrationPasscode !== undefined) sponsorConfig.registrationPasscode = patch.registrationPasscode;
    if (Object.keys(sponsorConfig).length > 0) data.sponsorConfig = sponsorConfig;

    const settings = await this.prisma.adminSettings.upsert({
      where: { id: 'default' },
      update: data,
      create: {
        id: 'default',
        registrationEnabled: patch.registrationEnabled ?? true,
        quotaPerDay: patch.quotaPerDay ?? { "gmgard-user": 5 },
        maxConcurrentJobs: patch.maxConcurrentJobs ?? 5,
        maxQueueThreshold: patch.maxQueueThreshold ?? 5000,
        localQueueThreshold: patch.localQueueThreshold ?? 0,
        loraPresets: normalizeLoraPresets(patch.loraPresets) ?? DEFAULT_LORA_PRESETS,
      },
    });

    // Orphan cleanup: purge any workflow refs to LoRA ids that no longer exist
    // in the preset list. Handles both the current rename (removedLoraIds) and
    // historical ghosts from renames that happened before this fix — we filter
    // by the authoritative validLoraIds set, not just the delta.
    // Also cleans quotaCostRules that reference deleted ids. Otherwise the old
    // filename stays assigned as a ghost checkbox and kickoff fails loading it.
    if (validLoraIds) {
      try {
        const allWorkflows = await this.prisma.workflow.findMany({ where: { isDeleted: false } });
        for (const wf of allWorkflows) {
          const w = wf as any;
          const compatibleIds: string[] = Array.isArray(w.compatibleLoraIds) ? w.compatibleLoraIds as string[] : [];
          const rules: any[] = Array.isArray(w.quotaCostRules) ? w.quotaCostRules : [];
          const filteredIds = compatibleIds.filter((id: string) => validLoraIds.has(id));
          let rulesChanged = false;
          const filteredRules = rules.map((r: any) => {
            const when = r?.when || {};
            const rawNot = when.notUsingLoras as string[] | undefined;
            const rawUsing = when.usingLoras as string[] | undefined;
            const notUsing = Array.isArray(rawNot) ? rawNot.filter((id: string) => validLoraIds!.has(id)) : rawNot;
            const using = Array.isArray(rawUsing) ? rawUsing.filter((id: string) => validLoraIds!.has(id)) : rawUsing;
            if (notUsing?.length !== rawNot?.length || using?.length !== rawUsing?.length) rulesChanged = true;
            if (notUsing?.length === rawNot?.length && using?.length === rawUsing?.length) return r;
            return { ...r, when: { ...when, notUsingLoras: notUsing, usingLoras: using } };
          });
          const idsChanged = filteredIds.length !== compatibleIds.length;
          if (idsChanged || rulesChanged) {
            const data: any = { updatedAt: new Date() };
            if (idsChanged) data.compatibleLoraIds = filteredIds;
            if (rulesChanged) data.quotaCostRules = normalizeQuotaCostRules(filteredRules);
            await this.prisma.workflow.update({ where: { id: wf.id }, data });
            if (idsChanged) console.log(`[DB] Purged ${compatibleIds.length - filteredIds.length} orphan LoRA id(s) from workflow ${wf.id}`);
          }
        }
      } catch (err) {
        console.error('[DB] Failed to purge orphan LoRA ids from workflows:', err);
      }
    }

    // Auto-compat: if new LoRAs were added, auto-assign to eligible workflows
    // Primary logic: same presetGroup (model family)
    if (newLoraIds.length) {
      try {
        const allWorkflows = await this.prisma.workflow.findMany({ where: { isDeleted: false } });
        for (const wf of allWorkflows) {
          const wfTags: string[] = Array.isArray((wf as any).tags) ? (wf as any).tags : [];
          const wfGroup: string | undefined = typeof (wf as any).presetGroup === 'string' ? (wf as any).presetGroup : undefined;
          const autoInclude = (wf as any).autoIncludeNewLoras ?? true;
          if (!autoInclude) continue;
          const compatibleIds: string[] = Array.isArray(wf.compatibleLoraIds) ? wf.compatibleLoraIds as string[] : [];
          let toAdd: string[] = [];
          for (const nl of newLoras) {
            // LoRA is agnostic to i2v/fl2v - no type filtering
            if (nl.autoAddToWorkflows) { toAdd.push(nl.id); continue; }
            // Primary: same presetGroup (free-form configurable group / model family)
            if (wfGroup && nl.presetGroup) {
              if (wfGroup.toLowerCase() !== String(nl.presetGroup).toLowerCase()) continue;
              // Group matches - if both have tags, require tag overlap as secondary filter, else allow
              if (wfTags.length && Array.isArray(nl.tags) && nl.tags.length) {
                const hasOverlap = nl.tags.some((t: string) => wfTags.map((x: string)=>String(x).toLowerCase()).includes(String(t).toLowerCase()));
                if (!hasOverlap) continue;
              }
              toAdd.push(nl.id);
              continue;
            }
            // Fallback: tag overlap when group not defined on one side
            if (wfTags.length && Array.isArray(nl.tags) && nl.tags.length) {
              const hasOverlap = nl.tags.some((t: string) => wfTags.map((x: string)=>String(x).toLowerCase()).includes(String(t).toLowerCase()));
              if (hasOverlap) toAdd.push(nl.id);
            }
          }
          toAdd = toAdd.filter(id => !compatibleIds.includes(id));
          if (toAdd.length) {
            const updatedIds = [...compatibleIds, ...toAdd];
            await this.prisma.workflow.update({ where: { id: wf.id }, data: { compatibleLoraIds: updatedIds, updatedAt: new Date() } });
          }
        }
      } catch (err) {
        console.error('[DB] Failed to auto-assign new LoRAs to workflows:', err);
      }
    }

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

  private safeParseJsonArray(value: unknown): string[] {
    if (!value) return [];

    if (Array.isArray(value)) {
      return value.filter((item): item is string => typeof item === 'string');
    }

    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed)) {
          return parsed.filter((item): item is string => typeof item === 'string');
        }
      } catch (error) {
        console.error('[DB] Failed to parse JSON array:', error);
      }
    }

    return [];
  }

  private mapToVideoEntry(video: any): VideoEntry {
    return {
      id: video.id,
      user_id: video.userId,
      workflow_id: video.workflowId || undefined,
      original_image_url: video.originalImageUrl,
      last_image_url: video.lastImageUrl || undefined,
      prompt: video.prompt || undefined,
      tags: this.safeParseJsonArray(video.tags),
      suggested_prompts: this.safeParseJsonArray(video.suggestedPrompts),
      is_photo_realistic: video.isPhotoRealistic ?? undefined,
      is_nsfw: video.isNsfw ?? undefined,
      status: video.status as VideoEntry['status'],
      job_id: video.jobId || undefined,
      is_local_job: video.isLocalJob ?? undefined,
      final_video_url: video.finalVideoUrl || undefined,
      is_published: video.isPublished || undefined,
      processing_time_ms: video.processingTimeMs ?? undefined,
      processing_started_at: video.processingStartedAt ? video.processingStartedAt.toISOString() : undefined,
      dequeued_at: video.dequeuedAt ? video.dequeuedAt.toISOString() : undefined,
      progress_percentage: video.progressPercentage ?? undefined,
      progress_details: video.progressDetails || undefined,
      iteration_steps: video.iterationSteps ?? undefined,
      video_duration: video.videoDuration ?? undefined,
      video_resolution: video.videoResolution || undefined,
      validation_metadata: video.validationMetadata || undefined,
      additional_options: video.additionalOptions || undefined,
      lora_weights: video.loraWeights || undefined,
      seed: video.seed ?? undefined,
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
      : (settings.quotaPerDay || { "gmgard-user": 5 });
    
    const roles = settings.roles 
      ? (typeof settings.roles === 'string' ? JSON.parse(settings.roles) : settings.roles)
      : undefined;
    
    // Parse sponsor config from JSON
    const sponsorConfig = typeof settings.sponsorConfig === 'string'
      ? JSON.parse(settings.sponsorConfig)
      : (settings.sponsorConfig || {});
    
    return {
      id: settings.id,
      registrationEnabled: settings.registrationEnabled,
      roles,
      quotaPerDay,
      maxConcurrentJobs: settings.maxConcurrentJobs,
      maxQueueThreshold: settings.maxQueueThreshold,
      localQueueThreshold: settings.localQueueThreshold,
      localQueueMigrationThreshold: settings.localQueueMigrationThreshold || 5,
      freeUserWaitThresholdMinutes: settings.freeUserWaitThresholdMinutes || 30,
      freeUserQueueLimit: settings.freeUserQueueLimit || 3,
      paidUserQueueLimit: settings.paidUserQueueLimit || 5,
      loraPresets: normalizeLoraPresets(settings.loraPresets ?? DEFAULT_LORA_PRESETS),
      sponsorApiUrl: sponsorConfig.sponsorApiUrl || undefined,
      sponsorApiToken: sponsorConfig.sponsorApiToken || undefined,
      deviceId: sponsorConfig.deviceId || undefined,
      registrationPasscode: sponsorConfig.registrationPasscode || undefined,
      updatedAt: settings.updatedAt.toISOString(),
    };
  }

  // ==================== Sponsor Claim Methods ====================

  async getSponsorClaimByUsername(sponsorUsername: string): Promise<SponsorClaim | null> {
    const claim = await this.prisma.sponsorClaim.findUnique({
      where: { sponsorUsername: sponsorUsername.toLowerCase() },
    });

    if (!claim) return null;

    return {
      id: claim.id,
      user_id: claim.userId,
      sponsor_username: claim.sponsorUsername,
      sponsor_nickname: claim.sponsorNickname || undefined,
      sponsor_avatar: claim.sponsorAvatar || undefined,
      sponsor_tier: claim.sponsorTier,
      applied_role: claim.appliedRole,
      claimed_at: claim.claimedAt.toISOString(),
      expired_at: claim.expiredAt ? claim.expiredAt.toISOString() : null,
    };
  }

  async getSponsorClaimsByUser(userId: string): Promise<SponsorClaim[]> {
    const claims = await this.prisma.sponsorClaim.findMany({
      where: { userId },
      orderBy: { claimedAt: 'desc' },
    });

    return claims.map(claim => ({
      id: claim.id,
      user_id: claim.userId,
      sponsor_username: claim.sponsorUsername,
      sponsor_nickname: claim.sponsorNickname || undefined,
      sponsor_avatar: claim.sponsorAvatar || undefined,
      sponsor_tier: claim.sponsorTier,
      applied_role: claim.appliedRole,
      claim_type: (claim.claimType || 'sponsor') as 'sponsor' | 'manual',
      claimed_at: claim.claimedAt.toISOString(),
      expired_at: claim.expiredAt ? claim.expiredAt.toISOString() : null,
    }));
  }

  async createSponsorClaim(claim: Omit<SponsorClaim, 'id' | 'claimed_at' | 'expired_at'>): Promise<SponsorClaim> {
    const created = await this.prisma.sponsorClaim.create({
      data: {
        userId: claim.user_id,
        sponsorUsername: claim.sponsor_username.toLowerCase(),
        sponsorNickname: claim.sponsor_nickname || null,
        sponsorAvatar: claim.sponsor_avatar || null,
        sponsorTier: claim.sponsor_tier,
        appliedRole: claim.applied_role,
        claimType: claim.claim_type || 'sponsor',
      },
    });

    return {
      id: created.id,
      user_id: created.userId,
      sponsor_username: created.sponsorUsername,
      sponsor_nickname: created.sponsorNickname || undefined,
      sponsor_avatar: created.sponsorAvatar || undefined,
      sponsor_tier: created.sponsorTier,
      applied_role: created.appliedRole,
      claim_type: (created.claimType || 'sponsor') as 'sponsor' | 'manual',
      claimed_at: created.claimedAt.toISOString(),
      expired_at: null,
    };
  }

  async deleteSponsorClaim(id: string): Promise<boolean> {
    try {
      await this.prisma.sponsorClaim.delete({ where: { id } });
      return true;
    } catch {
      return false;
    }
  }

  async getAllSponsorClaims(): Promise<SponsorClaim[]> {
    const claims = await this.prisma.sponsorClaim.findMany();
    return claims.map(c => ({
      id: c.id,
      user_id: c.userId,
      sponsor_username: c.sponsorUsername,
      sponsor_nickname: c.sponsorNickname || undefined,
      sponsor_avatar: c.sponsorAvatar || undefined,
      sponsor_tier: c.sponsorTier,
      applied_role: c.appliedRole,
      claim_type: (c.claimType || 'sponsor') as 'sponsor' | 'manual',
      claimed_at: c.claimedAt.toISOString(),
      expired_at: c.expiredAt ? c.expiredAt.toISOString() : null,
    }));
  }

  async expireSponsorClaim(id: string): Promise<boolean> {
    try {
      await this.prisma.sponsorClaim.update({
        where: { id },
        data: { expiredAt: new Date() },
      });
      return true;
    } catch {
      return false;
    }
  }

  // Removed renewSponsorClaim: use updateSponsorClaim with expired_at: null

  async updateSponsorClaim(id: string, patch: { sponsor_tier?: string; applied_role?: string; expired_at?: string | null }): Promise<SponsorClaim | null> {
    try {
      const updated = await this.prisma.sponsorClaim.update({
        where: { id },
        data: {
          sponsorTier: patch.sponsor_tier ?? undefined,
          appliedRole: patch.applied_role ?? undefined,
          expiredAt: patch.expired_at === undefined ? undefined : (patch.expired_at ? new Date(patch.expired_at) : null),
        },
      });
      return {
        id: updated.id,
        user_id: updated.userId,
        sponsor_username: updated.sponsorUsername,
        sponsor_nickname: updated.sponsorNickname || undefined,
        sponsor_avatar: updated.sponsorAvatar || undefined,
        sponsor_tier: updated.sponsorTier,
        applied_role: updated.appliedRole,
        claim_type: (updated.claimType || 'sponsor') as 'sponsor' | 'manual',
        claimed_at: updated.claimedAt.toISOString(),
        expired_at: updated.expiredAt ? updated.expiredAt.toISOString() : null,
      };
    } catch {
      return null;
    }
  }

  async deleteSponsorClaimsForRole(userId: string, role: string): Promise<number> {
    try {
      const result = await this.prisma.sponsorClaim.deleteMany({
        where: { userId, appliedRole: role, claimType: 'manual' },
      });
      return result.count;
    } catch {
      return 0;
    }
  }

  // ==================== Workflow Methods ====================

  async getWorkflowById(id: string): Promise<Workflow | null> {
    const workflow = await this.prisma.workflow.findUnique({ where: { id } });
    return workflow ? this.mapToWorkflow(workflow) : null;
  }

  async getWorkflows(): Promise<Workflow[]> {
    // Only return active (non-deleted) workflows for normal use
    const workflows = await this.prisma.workflow.findMany({ where: { isDeleted: false } });
    return workflows.map(w => this.mapToWorkflow(w));
  }

  async getAllWorkflowsIncludingDeleted(): Promise<Workflow[]> {
    // Admin only: include soft-deleted workflows so they can be restored
    const workflows = await this.prisma.workflow.findMany({ orderBy: { createdAt: 'asc' } });
    return workflows.map(w => this.mapToWorkflow(w));
  }

  async getDefaultWorkflow(workflowType: 'i2v' | 'fl2v' | 'ref2v' = 'i2v'): Promise<Workflow | null> {
    const workflow = await this.prisma.workflow.findFirst({ 
      where: { 
        isDefault: true,
        workflowType: workflowType 
      } 
    });
    return workflow ? this.mapToWorkflow(workflow) : null;
  }

  async createWorkflow(data: Omit<Workflow, 'createdAt' | 'updatedAt'>): Promise<Workflow> {
    const { id, name, description, templatePath, workflowType, isDefault, compatibleLoraIds, tags, autoIncludeNewLoras, presetGroup, quotaCost, quotaCostRules } = data as any;
    if (isDefault) {
      await this.prisma.workflow.updateMany({
        where: { workflowType: workflowType || 'i2v' },
        data: { isDefault: false },
      });
    }
    const created = await this.prisma.workflow.create({
      data: {
        id,
        name,
        description: description || null,
        templatePath,
        workflowType: workflowType || 'i2v',
        isDefault: isDefault || false,
        compatibleLoraIds,
        // new fields — stored as JSON / columns if exist, otherwise ignored by Prisma if not in schema (we store in compatibleLoraIds JSON fallback)
        // For flexibility, we try to write tags etc. into extra columns if they exist.
        ...(tags !== undefined ? { tags } : {}),
        ...(autoIncludeNewLoras !== undefined ? { autoIncludeNewLoras } : {}),
        ...(presetGroup !== undefined ? { presetGroup } : {}),
        quotaCost: typeof quotaCost === 'number' && quotaCost >= 1 ? quotaCost : 1,
        quotaCostRules: quotaCostRules !== undefined ? normalizeQuotaCostRules(quotaCostRules) : [],
      } as any,
    });
    return this.mapToWorkflow(created);
  }

  async updateWorkflow(id: string, patch: Partial<Omit<Workflow, 'id' | 'createdAt'>>): Promise<Workflow | null> {
    const updateData: any = { updatedAt: new Date() };
    if (patch.compatibleLoraIds !== undefined) updateData.compatibleLoraIds = patch.compatibleLoraIds;
    if (patch.name !== undefined) updateData.name = patch.name;
    if (patch.description !== undefined) updateData.description = patch.description;
    if (patch.templatePath !== undefined) updateData.templatePath = patch.templatePath;
    if (patch.workflowType !== undefined) updateData.workflowType = patch.workflowType;
    if ((patch as any).tags !== undefined) updateData.tags = (patch as any).tags;
    if ((patch as any).autoIncludeNewLoras !== undefined) updateData.autoIncludeNewLoras = (patch as any).autoIncludeNewLoras;
    if ((patch as any).presetGroup !== undefined) updateData.presetGroup = (patch as any).presetGroup;
    if ((patch as any).quotaCost !== undefined) updateData.quotaCost = Math.max(1, (patch as any).quotaCost);
    if ((patch as any).quotaCostRules !== undefined) updateData.quotaCostRules = normalizeQuotaCostRules((patch as any).quotaCostRules);
    if (patch.isDefault !== undefined) {
      if (patch.isDefault) {
        const current = await this.prisma.workflow.findUnique({ where: { id }, select: { workflowType: true } });
        if (current) {
          await this.prisma.workflow.updateMany({
            where: { workflowType: current.workflowType },
            data: { isDefault: false },
          });
        }
      }
      updateData.isDefault = patch.isDefault;
    }
    try {
      const updated = await this.prisma.workflow.update({ where: { id }, data: updateData });
      return this.mapToWorkflow(updated);
    } catch {
      return null;
    }
  }

  async deleteWorkflow(id: string): Promise<boolean> {
    try {
      // Soft-delete: mark as deleted so videos referencing this workflow
      // retain their workflowId and we can still display the model name/type.
      await this.prisma.workflow.update({
        where: { id },
        data: { isDeleted: true, isDefault: false },
      });
      return true;
    } catch {
      return false;
    }
  }

  async restoreWorkflow(id: string): Promise<Workflow | null> {
    try {
      const restored = await this.prisma.workflow.update({
        where: { id },
        data: { isDeleted: false, updatedAt: new Date() },
      });
      return this.mapToWorkflow(restored);
    } catch {
      return null;
    }
  }

  async setDefaultWorkflow(id: string): Promise<Workflow | null> {
    // Only unset defaults of the SAME type — an i2v default and a fl2v default
    // can coexist (each type needs its own default for job routing).
    const current = await this.prisma.workflow.findUnique({ where: { id }, select: { workflowType: true } });
    if (!current) return null;
    await this.prisma.workflow.updateMany({
      where: { workflowType: current.workflowType },
      data: { isDefault: false },
    });
    try {
      const updated = await this.prisma.workflow.update({
        where: { id },
        data: { isDefault: true, updatedAt: new Date() },
      });
      return this.mapToWorkflow(updated);
    } catch {
      return null;
    }
  }

  private mapToWorkflow(workflow: any): Workflow {
    const rawTags = (workflow as any).tags;
    const rawAuto = (workflow as any).autoIncludeNewLoras;
    const rawGroup = (workflow as any).presetGroup;
    return {
      id: workflow.id,
      name: workflow.name,
      description: workflow.description || undefined,
      templatePath: workflow.templatePath,
      workflowType: (workflow.workflowType || 'i2v') as 'i2v' | 'fl2v',
      compatibleLoraIds: Array.isArray(workflow.compatibleLoraIds)
        ? workflow.compatibleLoraIds
        : (typeof workflow.compatibleLoraIds === 'string'
          ? JSON.parse(workflow.compatibleLoraIds)
          : []),
      quotaCost: typeof (workflow as any).quotaCost === 'number' ? (workflow as any).quotaCost : 1,
      quotaCostRules: normalizeQuotaCostRules((workflow as any).quotaCostRules),
      tags: Array.isArray(rawTags) ? rawTags : (typeof rawTags === 'string' ? JSON.parse(rawTags) : []),
      autoIncludeNewLoras: typeof rawAuto === 'boolean' ? rawAuto : true,
      presetGroup: typeof rawGroup === 'string' ? rawGroup : undefined,
      isDefault: workflow.isDefault,
      isDeleted: workflow.isDeleted,
      createdAt: workflow.createdAt.toISOString(),
      updatedAt: workflow.updatedAt.toISOString(),
    };
  }

  async disconnect() {
    await this.prisma.$disconnect();
  }
}
