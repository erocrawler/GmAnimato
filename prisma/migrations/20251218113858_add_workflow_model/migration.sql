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

-- Seed default workflow BEFORE adding foreign key constraint
INSERT INTO "workflows" ("id", "name", "description", "templatePath", "compatible_lora_ids", "is_default", "created_at", "updated_at")
VALUES (
  'wan-2.2',
  'WAN 2.2',
  '原生 WAN 2.2 工作流+定制lora',
  'data/api_template.json.tmpl',
  '["wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors", "wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors", "wan22-video10-arcshot-16-sel-7-high.safetensors", "DR34ML4Y_I2V_14B_HIGH.safetensors", "NSFW-22-H-e8.safetensors", "DR34ML4Y_I2V_14B_LOW.safetensors", "NSFW-22-L-e8.safetensors"]'::jsonb,
  true,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT (id) DO NOTHING;

-- CreateIndex
CREATE INDEX "videos_workflow_id_idx" ON "videos"("workflow_id");

-- AddForeignKey
ALTER TABLE "videos" ADD CONSTRAINT "videos_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "workflows"("id") ON DELETE SET DEFAULT ON UPDATE CASCADE;
