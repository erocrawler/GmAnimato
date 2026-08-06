-- Configurable per-workflow quota cost rules (multipliers applied to quota_cost).
ALTER TABLE "workflows" ADD COLUMN "quota_cost_rules" JSONB NOT NULL DEFAULT '[]';
