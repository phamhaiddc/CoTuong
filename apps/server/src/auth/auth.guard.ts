import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import type { AuthedRequest } from './auth.types';

/**
 * Bắt buộc đăng nhập bằng tài khoản thật. Phiên KHÁCH (chơi không cần tài khoản) không dùng được các API này
 * (hồ sơ, ảnh đại diện, lưu ván với máy, lịch sử, liên kết Google/Facebook, quản trị, tiến độ cờ thế…).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const user = await this.auth.userFromRequest(req);
    if (!user || user.isGuest) throw new UnauthorizedException('Bạn cần đăng nhập');
    req.user = user;
    return true;
  }
}

/** Chỉ tài khoản có vai trò admin (dùng sau AuthGuard) */
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const user = ctx.switchToHttp().getRequest<AuthedRequest>().user;
    if (!user || user.role !== 'admin') throw new ForbiddenException('Trang này chỉ dành cho người quản trị.');
    return true;
  }
}
