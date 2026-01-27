/*
  Warnings:

  - You are about to drop the column `sponsor_api_token` on the `admin_settings` table. All the data in the column will be lost.
  - You are about to drop the column `sponsor_api_url` on the `admin_settings` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "admin_settings" DROP COLUMN "sponsor_api_token",
DROP COLUMN "sponsor_api_url",
ADD COLUMN     "sponsor_config" JSONB;
