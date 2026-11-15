-- AlterTable
ALTER TABLE "matches" ADD COLUMN     "setup" TEXT,
ADD COLUMN     "variant" VARCHAR(16) NOT NULL DEFAULT 'standard';

-- CreateTable
CREATE TABLE "puzzle_progress" (
    "user_id" UUID NOT NULL,
    "puzzle_id" INTEGER NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "solved_at" TIMESTAMPTZ(3),
    "best_moves" INTEGER,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "puzzle_progress_pkey" PRIMARY KEY ("user_id","puzzle_id")
);

-- AddForeignKey
ALTER TABLE "puzzle_progress" ADD CONSTRAINT "puzzle_progress_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
