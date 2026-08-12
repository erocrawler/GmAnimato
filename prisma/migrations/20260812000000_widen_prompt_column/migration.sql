-- Widen the prompt column: the ref2v structured prompt (H3 format with
-- subject_definitions / detailed_description / soundscape sections) routinely
-- exceeds the old 2000-char limit, which made Postgres reject submissions
-- (P2000) and caused the "empty prompt" bug.
ALTER TABLE "videos" ALTER COLUMN "prompt" TYPE VARCHAR(10000);
