import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { AuthGuard } from '../auth/auth.guard';
import { AuthService } from '../auth/auth.service';

/**
 * Bắt buộc đăng nhập cho các API cờ thế — y hệt AuthGuard (cùng thông báo "Bạn cần đăng nhập").
 *
 * Vì sao không dùng thẳng @UseGuards(AuthGuard): AuthService (và Prisma/Redis) được khai báo trong AppModule, mà
 * PuzzlesModule là module con nên không nhìn thấy các provider đó. Ở đây lấy đúng thể hiện dùng chung của AppModule
 * qua ModuleRef (strict: false) lúc có request, rồi giao cho AuthGuard xử lý — không tạo bản sao dịch vụ nào.
 */
@Injectable()
export class PuzzlesAuthGuard implements CanActivate {
  private inner: AuthGuard | null = null;

  constructor(private readonly moduleRef: ModuleRef) {}

  canActivate(ctx: ExecutionContext): Promise<boolean> {
    this.inner ??= new AuthGuard(this.moduleRef.get(AuthService, { strict: false }));
    return this.inner.canActivate(ctx);
  }
}
