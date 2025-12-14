-- AlterTable
ALTER TABLE "admin_settings" ADD COLUMN     "local_queue_threshold" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "videos" ADD COLUMN     "is_local_job" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "iteration_steps" INTEGER,
ADD COLUMN     "lora_weights" JSONB,
ADD COLUMN     "seed" INTEGER,
ADD COLUMN     "video_duration" INTEGER,
ADD COLUMN     "video_resolution" VARCHAR(10);
