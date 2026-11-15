import { Controller, Delete, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import type { ReportStatus } from '@cotuong/shared';
import { AdminGuard, AuthGuard } from '../auth/auth.guard';
import { CurrentUser, type AuthUser } from '../auth/auth.types';
import { AdminService } from './admin.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { pageParam, stringParam } from '../common/ids';

/** Trang quản trị cơ bản: khoá/mở khoá tài khoản, xoá avatar, xử lý tin nhắn chat bị báo cáo */
@Controller('admin')
@UseGuards(AuthGuard, AdminGuard)
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly analytics: AnalyticsService,
  ) {}

  /** Bảng theo dõi: số tài khoản, người online, lượt truy cập, ván đấu (30 ngày gần nhất) */
  @Get('stats')
  stats() {
    return this.analytics.stats();
  }

  @Get('users')
  users(@Query('q') q: string | undefined, @Query('page') page: string | undefined) {
    return this.admin.listUsers(stringParam(q), pageParam(page));
  }

  @Post('users/:id/ban')
  @HttpCode(200)
  async ban(@CurrentUser() admin: AuthUser, @Param('id') id: string) {
    await this.admin.setBanned(admin.id, id, true);
    return { ok: true };
  }

  @Post('users/:id/unban')
  @HttpCode(200)
  async unban(@CurrentUser() admin: AuthUser, @Param('id') id: string) {
    await this.admin.setBanned(admin.id, id, false);
    return { ok: true };
  }

  @Delete('users/:id/avatar')
  async clearAvatar(@Param('id') id: string) {
    await this.admin.clearAvatar(id);
    return { ok: true };
  }

  @Get('reports')
  reports(@Query('status') status: string | undefined, @Query('page') page: string | undefined) {
    const s: ReportStatus = status === 'resolved' || status === 'dismissed' ? status : 'open';
    return this.admin.listReports(s, pageParam(page));
  }

  @Post('messages/:id/delete')
  @HttpCode(200)
  async deleteMessage(@Param('id') id: string) {
    await this.admin.deleteMessage(id);
    return { ok: true };
  }

  @Post('reports/:id/dismiss')
  @HttpCode(200)
  async dismiss(@Param('id') id: string) {
    await this.admin.dismissReport(id);
    return { ok: true };
  }
}
