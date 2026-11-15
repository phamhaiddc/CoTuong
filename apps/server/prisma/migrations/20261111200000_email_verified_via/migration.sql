-- Cách email được xác thực ("email" | "google" | "facebook"): đặt lại mật khẩu gỡ liên kết Google/Facebook khi email
-- chỉ được tin vì Facebook trả về lúc tạo tài khoản (chưa chứng minh sở hữu hộp thư). Cột mới, có thể NULL: không đổi dữ liệu cũ.
ALTER TABLE "users" ADD COLUMN "email_verified_via" VARCHAR(16);
