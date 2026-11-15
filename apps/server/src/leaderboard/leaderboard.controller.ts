import { BadRequestException, Controller, Get, Param, Req } from '@nestjs/common';
import type { Request } from 'express';
import { isGameType } from '@cotuong/game-core';
import {
  CHAT_LIMITS,
  AVATAR_LIMITS,
  FIRST_MOVE_TIMEOUT_MS,
  LEADERBOARD_MIN_GAMES,
  MATCHMAKING,
  RANKED_TIME_CONTROL,
  RECONNECT_GRACE_MS,
  serializeTiers,
  type AppConfigDto,
} from '@cotuong/shared';
import { AppConfig } from '../config';
import { AuthService } from '../auth/auth.service';
import { LeaderboardService } from './leaderboard.service';

@Controller()
export class LeaderboardController {
  constructor(
    private readonly leaderboard: LeaderboardService,
    private readonly auth: AuthService,
    private readonly cfg: AppConfig,
  ) {}

  /** Top 10 quý hiện tại (khách xem được); kèm vị trí của bạn nếu đã đăng nhập */
  @Get('leaderboard/:game')
  async current(@Param('game') game: string, @Req() req: Request) {
    if (!isGameType(game)) throw new BadRequestException('Không rõ loại cờ (cờ tướng hay cờ vua). Bạn tải lại trang rồi thử lại.');
    const user = await this.auth.memberFromRequest(req);
    return this.leaderboard.response(game, user?.id ?? null);
  }

  /** Bảng Top 10 đã chốt của các quý trước */
  @Get('leaderboard/:game/archive')
  archive(@Param('game') game: string) {
    if (!isGameType(game)) throw new BadRequestException('Không rõ loại cờ (cờ tướng hay cờ vua). Bạn tải lại trang rồi thử lại.');
    return this.leaderboard.archive(game);
  }

  @Get('config')
  config(): AppConfigDto {
    return {
      oauth: { google: !!this.cfg.oauth.google, facebook: !!this.cfg.oauth.facebook },
      tiers: serializeTiers(this.cfg.tiers),
      minGames: LEADERBOARD_MIN_GAMES,
      rankedTimeControl: { ...RANKED_TIME_CONTROL },
      chat: { ...CHAT_LIMITS },
      avatar: { maxBytes: AVATAR_LIMITS.maxBytes, mimeTypes: AVATAR_LIMITS.mimeTypes },
      matchmaking: { ...MATCHMAKING },
      firstMoveTimeoutMs: FIRST_MOVE_TIMEOUT_MS,
      reconnectGraceMs: RECONNECT_GRACE_MS,
    };
  }

  @Get('health')
  health() {
    return { ok: true, time: new Date().toISOString() };
  }
}
