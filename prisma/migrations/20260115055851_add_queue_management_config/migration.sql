-- AlterTable
ALTER TABLE "admin_settings" ADD COLUMN     "free_user_queue_limit" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "free_user_wait_threshold_minutes" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "local_queue_migration_threshold" INTEGER NOT NULL DEFAULT 5,
ADD COLUMN     "paid_user_queue_limit" INTEGER NOT NULL DEFAULT 5;

-- CreateIndex
CREATE INDEX "videos_is_local_job_status_processing_started_at_idx" ON "videos"("is_local_job", "status", "processing_started_at");
