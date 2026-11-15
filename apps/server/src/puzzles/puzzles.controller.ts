import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import type { PuzzleAttemptResultDto, PuzzleProgressResponse } from '@cotuong/shared';
import { CurrentUser, type AuthUser } from '../auth/auth.types';
import { PuzzlesAuthGuard } from './puzzles-auth.guard';
import { PuzzlesService } from './puzzles.service';

/**
 * Cờ thế. Danh sách thế cờ là dữ liệu tĩnh trong @cotuong/shared (PUZZLES) nên không có API riêng;
 * ở đây chỉ có tiến độ của người chơi.
 */
@Controller('puzzles')
@UseGuards(PuzzlesAuthGuard)
export class PuzzlesController {
  constructor(private readonly puzzles: PuzzlesService) {}

  /** Tiến độ của người đang đăng nhập: chỉ gồm các thế đã gửi ít nhất một lần */
  @Get('progress')
  progress(@CurrentUser() user: AuthUser): Promise<PuzzleProgressResponse> {
    return this.puzzles.progress(user.id);
  }

  /** Gửi một lần giải: { moves: ["h2e2", ...] } — các nước từ thế ban đầu, Đỏ đi trước, xen kẽ hai bên */
  @Post(':id/attempt')
  @HttpCode(200)
  attempt(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown): Promise<PuzzleAttemptResultDto> {
    return this.puzzles.attempt(user.id, id, body);
  }
}
