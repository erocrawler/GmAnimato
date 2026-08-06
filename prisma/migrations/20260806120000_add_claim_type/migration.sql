-- Manual role grants reuse the sponsor_claim expiry mechanism.
-- claim_type: 'sponsor' (API-revalidated) or 'manual' (admin-granted, expiry-only).
ALTER TABLE "sponsor_claims" ADD COLUMN "claim_type" VARCHAR(20) NOT NULL DEFAULT 'sponsor';
