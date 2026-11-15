import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { User } from '@prisma/client';

export type AuthUser = User & { sid: string };

/**
 * Cột users.email_verified_via — email được xác thực bằng cách nào:
 *  - 'email': chủ hộp thư chứng minh (nhập mã đăng ký, bấm liên kết xác thực, đặt lại mật khẩu qua thư);
 *  - 'google': Google xác nhận email_verified;
 *  - 'facebook': chỉ vì Facebook trả email về (tin cho tài khoản MỚI theo quyết định chủ sản phẩm 11/11/2026) — CHƯA
 *    chứng minh hộp thư: đặt lại mật khẩu sẽ gỡ mọi liên kết Google/Facebook, Google không tự liên kết vào.
 * null: chưa xác thực, hoặc tài khoản xác thực trước khi có cột này (xem AuthService.emailProven).
 */
export type EmailVerifiedVia = 'email' | 'google' | 'facebook';

export type AuthedRequest = import('express').Request & { user?: AuthUser };

/** Lấy người dùng đã đăng nhập (do AuthGuard gắn vào request) */
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthUser => {
  return ctx.switchToHttp().getRequest<AuthedRequest>().user!;
});
