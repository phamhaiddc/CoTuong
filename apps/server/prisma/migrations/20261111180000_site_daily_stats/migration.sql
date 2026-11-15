-- Số liệu truy cập theo ngày cho bảng theo dõi của admin
CREATE TABLE "site_daily_stats" (
    "date" VARCHAR(10) NOT NULL,
    "page_views" INTEGER NOT NULL DEFAULT 0,
    "visitors" INTEGER NOT NULL DEFAULT 0,
    "members" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "site_daily_stats_pkey" PRIMARY KEY ("date")
);
