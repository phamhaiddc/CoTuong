import { Controller, Delete, Get, HttpCode, Param, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { OAuthLinksDto } from '@cotuong/shared';
import { AuthGuard } from './auth.guard';
import { CurrentUser, type AuthUser } from './auth.types';
import { OAuthService } from './oauth.service';

/** Đăng nhập Google / Facebook: /api/auth/oauth/:provider/start và /callback (trình duyệt điều hướng tới, không phải gọi fetch) */
@Controller('auth/oauth')
export class OAuthController {
  constructor(private readonly oauth: OAuthService) {}

  @Get(':provider/start')
  async start(
    @Param('provider') provider: string,
    @Query('from') from: string,
    @Query('mode') mode: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    await this.oauth.start(provider, from, req, res, mode);
  }

  /** Tài khoản đang đăng nhập đã liên kết Google / Facebook chưa (trang hồ sơ) */
  @Get('links')
  @UseGuards(AuthGuard)
  async links(@CurrentUser() user: AuthUser): Promise<OAuthLinksDto> {
    return { linked: await this.oauth.links(user.id), enabled: this.oauth.enabled() };
  }

  @Delete(':provider/link')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  async unlink(@Param('provider') provider: string, @CurrentUser() user: AuthUser) {
    await this.oauth.unlink(user.id, provider);
    return { ok: true };
  }

  @Get(':provider/callback')
  async callback(@Param('provider') provider: string, @Query() query: Record<string, unknown>, @Req() req: Request, @Res() res: Response) {
    await this.oauth.callback(provider, query, req, res);
  }
}
