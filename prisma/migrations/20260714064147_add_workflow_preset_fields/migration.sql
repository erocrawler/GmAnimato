-- AlterTable
ALTER TABLE "workflows" ADD COLUMN     "auto_include_new_loras" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "preset_group" VARCHAR(100),
ADD COLUMN     "tags" JSONB NOT NULL DEFAULT '[]';
