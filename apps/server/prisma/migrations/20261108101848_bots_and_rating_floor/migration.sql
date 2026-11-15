-- AlterTable
ALTER TABLE "matches" ADD COLUMN     "rating_change2" INTEGER;

-- AlterTable
ALTER TABLE "ratings" ALTER COLUMN "rating" SET DEFAULT 0,
ALTER COLUMN "peak_rating" SET DEFAULT 0;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "bot_level" VARCHAR(8),
ADD COLUMN     "is_bot" BOOLEAN NOT NULL DEFAULT false;
