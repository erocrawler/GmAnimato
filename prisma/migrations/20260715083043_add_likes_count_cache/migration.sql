-- AlterTable
ALTER TABLE "videos" ADD COLUMN     "likes_count_cache" INTEGER NOT NULL DEFAULT 0;

-- Backfill existing counts from video_likes table
UPDATE "videos" v SET "likes_count_cache" = COALESCE(lc.cnt, 0)
FROM (SELECT video_id, COUNT(*)::int as cnt FROM video_likes GROUP BY video_id) lc
WHERE v.id = lc.video_id;

-- CreateIndex
CREATE INDEX "videos_is_published_likes_count_cache_processing_started_at_idx" ON "videos"("is_published", "likes_count_cache" DESC, "processing_started_at" DESC);
