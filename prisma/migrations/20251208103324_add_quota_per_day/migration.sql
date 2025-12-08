/*
  Warnings:

  - You are about to drop the column `free_user_quota_per_day` on the `admin_settings` table. All the data in the column will be lost.
  - You are about to drop the column `paid_user_quota_per_day` on the `admin_settings` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "admin_settings" DROP COLUMN "free_user_quota_per_day",
DROP COLUMN "paid_user_quota_per_day",
ADD COLUMN     "quota_per_day" JSONB NOT NULL DEFAULT '{"free": 10, "gmgard-user": 50, "paid": 100, "premium": 100}';
