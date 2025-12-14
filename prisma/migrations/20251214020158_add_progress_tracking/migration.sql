-- AlterTable
ALTER TABLE "videos" ADD COLUMN     "progress_percentage" DOUBLE PRECISION,
ADD COLUMN     "progress_details" JSONB;
