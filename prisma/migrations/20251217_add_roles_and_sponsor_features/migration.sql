-- Add roles configuration to admin_settings
ALTER TABLE "admin_settings" ADD COLUMN "roles" JSONB;

-- Add sponsor API configuration fields to admin_settings
ALTER TABLE "admin_settings" ADD COLUMN "sponsor_api_url" VARCHAR(500);
ALTER TABLE "admin_settings" ADD COLUMN "sponsor_api_token" VARCHAR(500);

-- CreateTable: sponsor_claims for tracking sponsor tier claims
CREATE TABLE "sponsor_claims" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "sponsor_username" VARCHAR(100) NOT NULL,
    "sponsor_nickname" VARCHAR(255),
    "sponsor_avatar" VARCHAR(500),
    "sponsor_tier" VARCHAR(50) NOT NULL,
    "applied_role" VARCHAR(50) NOT NULL,
    "claimed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sponsor_claims_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sponsor_claims_sponsor_username_key" ON "sponsor_claims"("sponsor_username");

-- CreateIndex
CREATE INDEX "sponsor_claims_user_id_idx" ON "sponsor_claims"("user_id");

-- CreateIndex
CREATE INDEX "sponsor_claims_sponsor_username_idx" ON "sponsor_claims"("sponsor_username");

-- AddForeignKey
ALTER TABLE "sponsor_claims" ADD CONSTRAINT "sponsor_claims_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
