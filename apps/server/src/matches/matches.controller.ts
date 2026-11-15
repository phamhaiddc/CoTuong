import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser, type AuthUser } from '../auth/auth.types';
import { MatchesService } from './matches.service';

@Controller('matches')
@UseGuards(AuthGuard)
export class MatchesController {
  constructor(private readonly matches: MatchesService) {}

  /** Chi tiết ván đã kết thúc để xem lại nước đi */
  @Get(':id')
  detail(@Param('id') id: string) {
    return this.matches.detail(id);
  }

  /** Lưu kết quả ván đấu với máy */
  @Post('ai')
  async saveAi(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    return { match: await this.matches.saveAiMatch(user.id, body) };
  }
}
