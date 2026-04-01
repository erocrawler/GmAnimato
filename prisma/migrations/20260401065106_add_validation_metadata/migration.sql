-- AlterTable
ALTER TABLE "videos" ALTER COLUMN "completion_time" DROP EXPRESSION;
ALTER TABLE "videos" ADD COLUMN "validation_metadata" JSONB;
