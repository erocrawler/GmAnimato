-- Drop the old index first
DROP INDEX IF EXISTS "videos_user_id_completion_time_idx";

-- Drop the old column
ALTER TABLE "videos" DROP COLUMN IF EXISTS "completion_time";

-- Add the column as a stored generated column
ALTER TABLE "videos" ADD COLUMN "completion_time" BIGINT GENERATED ALWAYS AS (
  CASE 
    WHEN "processing_started_at" IS NOT NULL 
    THEN (EXTRACT(EPOCH FROM "processing_started_at") * 1000)::BIGINT + COALESCE("processing_time_ms", 0)
    ELSE (EXTRACT(EPOCH FROM "created_at") * 1000)::BIGINT
  END
) STORED;

-- Recreate the index
CREATE INDEX "videos_user_id_completion_time_idx" ON "videos"("user_id", "completion_time" DESC);
