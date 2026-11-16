-- OAuth identity binding for users (provider + provider-side stable subject).
--
-- DEPLOY ORDER: apply this migration BEFORE starting the new application code.
-- Prisma selects every User column, so the new code fails on `users` reads until
-- both columns exist. Both columns are nullable with no default, so the migration
-- is metadata-only and safe for the existing rows: legacy OAuth accounts
-- (role 'gmgard-user') keep NULL here and are bound on their next login.
-- Postgres treats NULLs as distinct, so the unique index only constrains bound rows.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "oauth_provider" VARCHAR(50);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "oauth_sub" VARCHAR(255);

CREATE UNIQUE INDEX IF NOT EXISTS "users_oauth_provider_oauth_sub_key" ON "users"("oauth_provider", "oauth_sub");
