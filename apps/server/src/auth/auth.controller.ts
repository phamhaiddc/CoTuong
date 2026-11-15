import { Body, Controller, Get, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { MeDto, ResetPasswordResponse } from '@cotuong/shared';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { CurrentUser, type AuthUser } from './auth.types';

const ipOf = (req: Request) => req.ip ?? 'unknown';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** Người đang có phiên: thành viên, hoặc khách (isGuest: true); chưa có phiên nào (thành viên hay khách) → { user: null } */
  @Get('me')
  async me(@Req() req: Request): Promise<{ user: MeDto | null }> {
    const user = await this.auth.userFromRequest(req);
    return { user: user ? await this.auth.me(user) : null };
  }

  @Post('register')
  async register(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return { user: await this.auth.register(body, res, ipOf(req)) };
  }

  /**
   * Vào chơi với tư cách KHÁCH (phòng riêng, Cờ úp… — mọi thứ trừ xếp hạng). Đã có phiên thì trả lại người đó.
   * Trả { user: MeDto } với isGuest = true và đặt cookie phiên như đăng nhập.
   */
  @Post('guest')
  @HttpCode(200)
  async guest(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return { user: await this.auth.createGuest(req, res, ipOf(req)) };
  }

  /** Đăng ký 3 bước — bước 1: gửi mã 6 chữ số tới email (gọi lại để "Gửi lại mã") */
  @Post('register/start')
  @HttpCode(200)
  async registerStart(@Body() body: unknown, @Req() req: Request) {
    return this.auth.registerStart(body, ipOf(req));
  }

  /** Bước 2: kiểm tra mã → phiếu dùng một lần */
  @Post('register/verify')
  @HttpCode(200)
  async registerVerify(@Body() body: unknown, @Req() req: Request) {
    return this.auth.registerVerify(body, ipOf(req));
  }

  /** Bước 3: tên hiển thị + mật khẩu → tạo tài khoản (email đã xác thực) và đăng nhập */
  @Post('register/complete')
  async registerComplete(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return { user: await this.auth.registerComplete(body, req, res) };
  }

  @Post('login')
  @HttpCode(200)
  async login(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return { user: await this.auth.login(body, req, res, ipOf(req)) };
  }

  /**
   * Đăng xuất: thành viên hoặc KHÁCH ("Thoát chế độ khách") — huỷ phiên, xoá cookie, ngắt socket của phiên đó.
   * Không có phiên hợp lệ cũng trả { ok: true } (chỉ xoá cookie).
   */
  @Post('logout')
  @HttpCode(200)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(await this.auth.userFromRequest(req), res);
    return { ok: true };
  }

  @Post('verify-email')
  @HttpCode(200)
  async verifyEmail(@Body() body: { token?: unknown }, @Req() req: Request) {
    const current = await this.auth.memberFromRequest(req);
    await this.auth.verifyEmail(body?.token, current?.id ?? null);
    return { ok: true };
  }

  @Post('resend-verification')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  async resend(@CurrentUser() user: AuthUser) {
    await this.auth.resendVerification(user);
    return { ok: true };
  }

  @Post('forgot-password')
  @HttpCode(200)
  async forgot(@Body() body: unknown, @Req() req: Request) {
    await this.auth.forgotPassword(body, ipOf(req));
    return { ok: true };
  }

  @Post('reset-password')
  @HttpCode(200)
  async reset(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<ResetPasswordResponse> {
    const removedLinks = await this.auth.resetPassword(body, req, res);
    return { ok: true, removedLinks };
  }
}
