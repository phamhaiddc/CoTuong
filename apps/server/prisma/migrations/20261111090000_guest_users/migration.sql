-- Tài khoản khách (chơi không cần đăng nhập, trừ xếp hạng)
ALTER TABLE "users" ADD COLUMN "is_guest" BOOLEAN NOT NULL DEFAULT false;

-- Dọn khách cũ theo thời điểm tạo
CREATE INDEX "users_is_guest_created_at_idx" ON "users"("is_guest", "created_at");
