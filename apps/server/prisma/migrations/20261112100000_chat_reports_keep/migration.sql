-- Báo cáo chat không mất khi người báo cáo bị xoá (vd khách cũ được dọn sau SESSION_TTL_DAYS + 1 ngày):
-- reporter_id được phép NULL, xoá tài khoản thì đặt NULL thay vì xoá luôn báo cáo đang chờ admin xử lý.
ALTER TABLE "chat_reports" DROP CONSTRAINT "chat_reports_reporter_id_fkey";
ALTER TABLE "chat_reports" ALTER COLUMN "reporter_id" DROP NOT NULL;
ALTER TABLE "chat_reports" ADD CONSTRAINT "chat_reports_reporter_id_fkey" FOREIGN KEY ("reporter_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Chỉ mục cho các khoá ngoại tới users: xoá một tài khoản (ON DELETE CASCADE / SET NULL) không phải quét cả bảng.
-- Bảng còn nhỏ nên tạo chỉ mục thường; nếu đã rất lớn thì tạo trước bằng CREATE INDEX CONCURRENTLY (cùng tên) ngoài giao dịch.
CREATE INDEX IF NOT EXISTS "chat_messages_user_id_idx" ON "chat_messages"("user_id");
CREATE INDEX IF NOT EXISTS "chat_reports_reporter_id_idx" ON "chat_reports"("reporter_id");
