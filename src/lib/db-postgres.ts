import { PrismaClient } from '@prisma/client';
import type { IDatabase, VideoEntry, User, AdminSettings, UserPublic } from './IDatabase';
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
        finalVideoUrl: entry.final_video_url,
        isPublished: entry.is_published ?? false,
      },
    });

    return this.mapToVideoEntry(video);
  }

  async getVideosByUser(user_id: string): Promise<VideoEntry[]> {
    const videos = await this.prisma.video.findMany({
      where: { userId: user_id },
      orderBy: { createdAt: 'desc' },
    });

    return videos.map(this.mapToVideoEntry);
  }

  async getActiveJobsByUser(user_id: string): Promise<VideoEntry[]> {
    const videos = await this.prisma.video.findMany({
      where: {
        userId: user_id,
        status: {
          in: ['in_queue', 'processing'],
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return videos.map(this.mapToVideoEntry);
  }

  async getPublishedVideos(): Promise<VideoEntry[]> {
    const videos = await this.prisma.video.findMany({
      where: { isPublished: true },
      orderBy: { createdAt: 'desc' },
    });

    return videos.map(this.mapToVideoEntry);
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
      if (patch.final_video_url !== undefined) data.finalVideoUrl = patch.final_video_url;
      if (patch.is_published !== undefined) data.isPublished = patch.is_published;
      if (patch.processing_time_ms !== undefined) data.processingTimeMs = patch.processing_time_ms;
      if (patch.processing_started_at !== undefined) data.processingStartedAt = patch.processing_started_at ? new Date(patch.processing_started_at) : null;
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

  async toggleLike(videoId: string, userId: string): Promise<VideoEntry | null> {
    const video = await this.prisma.video.findUnique({
      where: { id: videoId },
    });

    if (!video) return null;

    // Check if like exists
    const existingLike = await this.prisma.videoLike.findUnique({
      where: {
        videoId_userId: {
          videoId,
          userId,
        },
      },
    });

    if (existingLike) {
      // Unlike - delete the like
      await this.prisma.videoLike.delete({
        where: {
          id: existingLike.id,
        },
      });
    } else {
      // Like - create the like
      await this.prisma.videoLike.create({
        data: {
          videoId,
          userId,
        },
      });
    }

    // Return updated video with like count
    return this.getVideoById(videoId) as Promise<VideoEntry>;
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
          freeUserQuotaPerDay: 5,
          paidUserQuotaPerDay: 50,
          maxConcurrentJobs: 5,
          maxQueueThreshold: 5000,
        },
      });
    }

    return this.mapToAdminSettings(settings);
  }

  async updateAdminSettings(patch: Partial<Omit<AdminSettings, 'id'>>): Promise<AdminSettings> {
    const data: any = {};
    
    if (patch.registrationEnabled !== undefined) data.registrationEnabled = patch.registrationEnabled;
    if (patch.freeUserQuotaPerDay !== undefined) data.freeUserQuotaPerDay = patch.freeUserQuotaPerDay;
    if (patch.paidUserQuotaPerDay !== undefined) data.paidUserQuotaPerDay = patch.paidUserQuotaPerDay;
    if (patch.maxConcurrentJobs !== undefined) data.maxConcurrentJobs = patch.maxConcurrentJobs;
    if (patch.maxQueueThreshold !== undefined) data.maxQueueThreshold = patch.maxQueueThreshold;

    const settings = await this.prisma.adminSettings.upsert({
      where: { id: 'default' },
      update: data,
      create: {
        id: 'default',
        registrationEnabled: patch.registrationEnabled ?? true,
        freeUserQuotaPerDay: patch.freeUserQuotaPerDay ?? 5,
        paidUserQuotaPerDay: patch.paidUserQuotaPerDay ?? 50,
        maxConcurrentJobs: patch.maxConcurrentJobs ?? 5,
        maxQueueThreshold: patch.maxQueueThreshold ?? 5000,
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
      final_video_url: video.finalVideoUrl || undefined,
      is_published: video.isPublished || undefined,
      processing_time_ms: video.processingTimeMs ?? undefined,
      processing_started_at: video.processingStartedAt ? video.processingStartedAt.toISOString() : undefined,
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
    return {
      id: settings.id,
      registrationEnabled: settings.registrationEnabled,
      freeUserQuotaPerDay: settings.freeUserQuotaPerDay,
      paidUserQuotaPerDay: settings.paidUserQuotaPerDay,
      maxConcurrentJobs: settings.maxConcurrentJobs,
      maxQueueThreshold: settings.maxQueueThreshold,
      updatedAt: settings.updatedAt.toISOString(),
    };
  }

  async disconnect() {
    await this.prisma.$disconnect();
  }
}
