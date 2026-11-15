import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { AnalyticsService } from './analytics.service';

/** Ghi nhận lượt xem trang (không cần đăng nhập). Luôn trả 204 — kể cả khi bị bỏ qua (bot, quá giới hạn, dữ liệu sai) */
@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Post('visit')
  @HttpCode(204)
  async visit(@Body() body: unknown, @Req() req: Request): Promise<void> {
    await this.analytics.recordVisit(req, body);
  }
}
