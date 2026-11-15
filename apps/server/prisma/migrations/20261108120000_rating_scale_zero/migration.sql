-- Đổi thang điểm: mỗi mùa bắt đầu từ 0 (trước đây 1200) và không xuống dưới 0.
-- Đưa mọi điểm đã lưu về thang mới (trừ 1200, sàn 0) để cấp bậc, ghép trận và Top 10 nhất quán với mốc mới.
UPDATE "ratings"
SET "rating" = GREATEST(0, "rating" - 1200),
    "peak_rating" = GREATEST(0, "peak_rating" - 1200);

UPDATE "season_results"
SET "rating" = GREATEST(0, "rating" - 1200);
