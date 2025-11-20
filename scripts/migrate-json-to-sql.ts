/**
 * Migration script to transfer data from JSON file storage to SQL Server
 * 
 * Usage:
 *   1. Ensure SQL Server is running and DATABASE_URL is configured in .env
 *   2. Run: npx tsx scripts/migrate-json-to-sql.ts
 */

import { PrismaClient } from '@prisma/client';
import fs from 'fs/promises';
import path from 'path';

const prisma = new PrismaClient();
const JSON_FILE = path.resolve('data/videos.json');

async function migrate() {
  console.log('Starting migration from JSON to SQL Server...\n');

  // Read JSON file
  let jsonData: string;
  try {
    jsonData = await fs.readFile(JSON_FILE, 'utf-8');
  } catch (error) {
    console.error('Error reading JSON file:', error);
    console.log('Make sure data/videos.json exists');
    process.exit(1);
  }

  const videos = JSON.parse(jsonData);
  console.log(`Found ${videos.length} videos in JSON file\n`);

  if (videos.length === 0) {
    console.log('No videos to migrate');
    await prisma.$disconnect();
    return;
  }

  // Migrate each video
  let successCount = 0;
  let errorCount = 0;

  for (const video of videos) {
    try {
      await prisma.video.upsert({
        where: { id: video.id },
        update: {
          userId: video.user_id,
          originalImageUrl: video.original_image_url,
          prompt: video.prompt || null,
          tags: video.tags ? JSON.stringify(video.tags) : null,
          suggestedPrompts: video.suggested_prompts 
            ? JSON.stringify(video.suggested_prompts) 
            : null,
          status: video.status,
          jobId: video.job_id || null,
          finalVideoUrl: video.final_video_url || null,
          isPublished: video.is_published ?? false,
          likes: video.likes ? JSON.stringify(video.likes) : null,
          createdAt: new Date(video.created_at),
        },
        create: {
          id: video.id,
          userId: video.user_id,
          originalImageUrl: video.original_image_url,
          prompt: video.prompt || null,
          tags: video.tags ? JSON.stringify(video.tags) : null,
          suggestedPrompts: video.suggested_prompts 
            ? JSON.stringify(video.suggested_prompts) 
            : null,
          status: video.status,
          jobId: video.job_id || null,
          finalVideoUrl: video.final_video_url || null,
          isPublished: video.is_published ?? false,
          likes: video.likes ? JSON.stringify(video.likes) : null,
          createdAt: new Date(video.created_at),
        },
      });

      successCount++;
      console.log(`✓ Migrated video ${video.id} (${successCount}/${videos.length})`);
    } catch (error) {
      errorCount++;
      console.error(`✗ Error migrating video ${video.id}:`, error);
    }
  }

  console.log(`\nMigration complete!`);
  console.log(`Success: ${successCount}`);
  console.log(`Errors: ${errorCount}`);

  await prisma.$disconnect();
}

migrate().catch((error) => {
  console.error('Fatal error during migration:', error);
  prisma.$disconnect();
  process.exit(1);
});
