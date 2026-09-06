-- Engine (node-stack family) + runOn (runner routing) + capability allowlists.
ALTER TABLE "workflows" ADD COLUMN "engine" VARCHAR(20) NOT NULL DEFAULT 'wan';
ALTER TABLE "workflows" ADD COLUMN "run_on" VARCHAR(20) NOT NULL DEFAULT 'auto';
ALTER TABLE "workflows" ADD COLUMN "capabilities" JSONB NOT NULL DEFAULT '{}';

-- Backfill engine from the template filename for existing MiniMax workflows
-- (legacy heuristic; new rows set it explicitly).
UPDATE "workflows" SET "engine" = 'minimax' WHERE LOWER("templatePath") LIKE '%minimax%';
