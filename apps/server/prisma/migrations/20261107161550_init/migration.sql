-- CreateEnum
CREATE TYPE "Role" AS ENUM ('player', 'admin');

-- CreateEnum
CREATE TYPE "GameType" AS ENUM ('xiangqi', 'chess');

-- CreateEnum
CREATE TYPE "GameMode" AS ENUM ('pvp', 'ai');

-- CreateEnum
CREATE TYPE "SeasonStatus" AS ENUM ('active', 'finalizing', 'closed');

-- CreateEnum
CREATE TYPE "MatchResult" AS ENUM ('p1', 'p2', 'draw', 'aborted');

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('open', 'resolved', 'dismissed');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "username" VARCHAR(40) NOT NULL,
    "username_key" VARCHAR(80) NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "password_hash" TEXT NOT NULL,
    "avatar_url" TEXT,
    "role" "Role" NOT NULL DEFAULT 'player',
    "is_banned" BOOLEAN NOT NULL DEFAULT false,
    "email_verified_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seasons" (
    "id" UUID NOT NULL,
    "game" "GameType" NOT NULL,
    "year" INTEGER NOT NULL,
    "quarter" INTEGER NOT NULL,
    "start_at" TIMESTAMPTZ(3) NOT NULL,
    "end_at" TIMESTAMPTZ(3) NOT NULL,
    "status" "SeasonStatus" NOT NULL DEFAULT 'active',

    CONSTRAINT "seasons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ratings" (
    "user_id" UUID NOT NULL,
    "season_id" UUID NOT NULL,
    "rating" INTEGER NOT NULL DEFAULT 1200,
    "peak_rating" INTEGER NOT NULL DEFAULT 1200,
    "wins" INTEGER NOT NULL DEFAULT 0,
    "losses" INTEGER NOT NULL DEFAULT 0,
    "draws" INTEGER NOT NULL DEFAULT 0,
    "games_played" INTEGER NOT NULL DEFAULT 0,
    "rating_updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "final_rank" INTEGER,

    CONSTRAINT "ratings_pkey" PRIMARY KEY ("user_id","season_id")
);

-- CreateTable
CREATE TABLE "matches" (
    "id" UUID NOT NULL,
    "game" "GameType" NOT NULL,
    "mode" "GameMode" NOT NULL,
    "ranked" BOOLEAN NOT NULL DEFAULT false,
    "ai_level" VARCHAR(16),
    "time_control" VARCHAR(16),
    "player1_id" UUID,
    "player2_id" UUID,
    "season_id" UUID,
    "result" "MatchResult",
    "end_reason" VARCHAR(32),
    "rating_change" INTEGER,
    "moves" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMPTZ(3),

    CONSTRAINT "matches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "season_results" (
    "season_id" UUID NOT NULL,
    "rank" INTEGER NOT NULL,
    "user_id" UUID NOT NULL,
    "rating" INTEGER NOT NULL,

    CONSTRAINT "season_results_pkey" PRIMARY KEY ("season_id","rank")
);

-- CreateTable
CREATE TABLE "chat_messages" (
    "id" UUID NOT NULL,
    "match_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "content" VARCHAR(200) NOT NULL,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_reports" (
    "id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "reporter_id" UUID NOT NULL,
    "status" "ReportStatus" NOT NULL DEFAULT 'open',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key_key" ON "users"("username_key");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "seasons_status_idx" ON "seasons"("status");

-- CreateIndex
CREATE UNIQUE INDEX "seasons_game_year_quarter_key" ON "seasons"("game", "year", "quarter");

-- CreateIndex
CREATE INDEX "ratings_season_id_rating_idx" ON "ratings"("season_id", "rating" DESC);

-- CreateIndex
CREATE INDEX "matches_player1_id_game_started_at_idx" ON "matches"("player1_id", "game", "started_at" DESC);

-- CreateIndex
CREATE INDEX "matches_player2_id_game_started_at_idx" ON "matches"("player2_id", "game", "started_at" DESC);

-- CreateIndex
CREATE INDEX "matches_season_id_ended_at_idx" ON "matches"("season_id", "ended_at");

-- CreateIndex
CREATE INDEX "season_results_user_id_idx" ON "season_results"("user_id");

-- CreateIndex
CREATE INDEX "chat_messages_match_id_created_at_idx" ON "chat_messages"("match_id", "created_at");

-- CreateIndex
CREATE INDEX "chat_reports_status_created_at_idx" ON "chat_reports"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "chat_reports_message_id_reporter_id_key" ON "chat_reports"("message_id", "reporter_id");

-- AddForeignKey
ALTER TABLE "ratings" ADD CONSTRAINT "ratings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ratings" ADD CONSTRAINT "ratings_season_id_fkey" FOREIGN KEY ("season_id") REFERENCES "seasons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matches" ADD CONSTRAINT "matches_player1_id_fkey" FOREIGN KEY ("player1_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matches" ADD CONSTRAINT "matches_player2_id_fkey" FOREIGN KEY ("player2_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matches" ADD CONSTRAINT "matches_season_id_fkey" FOREIGN KEY ("season_id") REFERENCES "seasons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "season_results" ADD CONSTRAINT "season_results_season_id_fkey" FOREIGN KEY ("season_id") REFERENCES "seasons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "season_results" ADD CONSTRAINT "season_results_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "matches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_reports" ADD CONSTRAINT "chat_reports_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "chat_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_reports" ADD CONSTRAINT "chat_reports_reporter_id_fkey" FOREIGN KEY ("reporter_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
