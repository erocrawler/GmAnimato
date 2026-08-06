-- Per-workflow quota cost (credits per video). Default 1 preserves existing behavior.
ALTER TABLE "workflows" ADD COLUMN "quota_cost" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "videos" ADD COLUMN "quota_cost" INTEGER NOT NULL DEFAULT 1;
