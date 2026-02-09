-- AlterTable
ALTER TABLE "videos" ADD COLUMN "completion_time" BIGINT GENERATED ALWAYS AS (
  CASE 
    WHEN "processing_started_at" IS NOT NULL 
    THEN (EXTRACT(EPOCH FROM "processing_started_at") * 1000)::BIGINT + COALESCE("processing_time_ms", 0)
    ELSE (EXTRACT(EPOCH FROM "created_at") * 1000)::BIGINT
  END
) STORED;

-- CreateIndex
CREATE INDEX "videos_user_id_completion_time_idx" ON "videos"("user_id", "completion_time" DESC);
