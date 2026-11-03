-- AlterTable
ALTER TABLE "admin_settings" ADD COLUMN IF NOT EXISTS "lora_sets" JSONB,
ADD COLUMN IF NOT EXISTS "quota_rule_sets" JSONB;
