-- AlterTable
ALTER TABLE "videos" ADD COLUMN     "workflow_id" TEXT DEFAULT 'wan-2.2';

-- CreateTable
CREATE TABLE "workflows" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "description" VARCHAR(500),
    "templatePath" VARCHAR(255) NOT NULL,
    "compatible_lora_ids" JSONB NOT NULL DEFAULT '[]',
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workflows_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "videos_workflow_id_idx" ON "videos"("workflow_id");

-- AddForeignKey
ALTER TABLE "videos" ADD CONSTRAINT "videos_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "workflows"("id") ON DELETE SET DEFAULT ON UPDATE CASCADE;
