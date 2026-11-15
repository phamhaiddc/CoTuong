-- Luật xếp hạng mới: thưởng chuỗi thắng, "không chơi thì tụt điểm"
ALTER TABLE "ratings" ADD COLUMN "win_streak" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ratings" ADD COLUMN "last_ranked_at" TIMESTAMPTZ(3);
