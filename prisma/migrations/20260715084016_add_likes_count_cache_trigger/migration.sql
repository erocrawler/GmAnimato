-- Trigger that keeps videos.likes_count_cache in sync by counting video_likes
-- Simpler and safer than +1/-1: always accurate even after bulk deletes or manual edits

CREATE OR REPLACE FUNCTION update_video_likes_count_cache()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE "videos"
  SET "likes_count_cache" = (SELECT COUNT(*)::int FROM "video_likes" WHERE video_id = COALESCE(NEW.video_id, OLD.video_id))
  WHERE id = COALESCE(NEW.video_id, OLD.video_id);
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_video_likes_insert ON "video_likes";
CREATE TRIGGER trg_video_likes_insert
AFTER INSERT ON "video_likes"
FOR EACH ROW EXECUTE FUNCTION update_video_likes_count_cache();

DROP TRIGGER IF EXISTS trg_video_likes_delete ON "video_likes";
CREATE TRIGGER trg_video_likes_delete
AFTER DELETE ON "video_likes"
FOR EACH ROW EXECUTE FUNCTION update_video_likes_count_cache();

-- Optional: also handle UPDATE if video_id ever changes (unlikely but safe)
DROP TRIGGER IF EXISTS trg_video_likes_update ON "video_likes";
CREATE TRIGGER trg_video_likes_update
AFTER UPDATE OF video_id ON "video_likes"
FOR EACH ROW EXECUTE FUNCTION update_video_likes_count_cache();