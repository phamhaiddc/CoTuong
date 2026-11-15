import { Injectable } from '@nestjs/common';
import { Prisma, type Season } from '@prisma/client';
import type { GameType } from '@cotuong/game-core';
import { daysLeft, quarterBounds, quarterOf, type SeasonDto } from '@cotuong/shared';
import { PrismaService } from '../common/prisma.service';

export const GAMES: GameType[] = ['xiangqi', 'chess'];

@Injectable()
export class SeasonsService {
  private readonly cache = new Map<GameType, { season: Season; until: number }>();

  constructor(private readonly prisma: PrismaService) {}

  /** Mùa hiện tại của game (tạo nếu chưa có). Mỗi game có bảng điểm riêng. */
  async current(game: GameType): Promise<Season> {
    const now = Date.now();
    const cached = this.cache.get(game);
    if (cached && now < cached.until && now < cached.season.endAt.getTime()) return cached.season;
    const q = quarterOf(now);
    const { startAt, endAt } = quarterBounds(q);
    let season: Season;
    try {
      season = await this.prisma.season.upsert({
        where: { game_year_quarter: { game, year: q.year, quarter: q.quarter } },
        create: { game, year: q.year, quarter: q.quarter, startAt, endAt, status: 'active' },
        update: {},
      });
    } catch (e) {
      // Hai instance cùng tạo một lúc
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        season = await this.prisma.season.findUniqueOrThrow({
          where: { game_year_quarter: { game, year: q.year, quarter: q.quarter } },
        });
      } else throw e;
    }
    this.cache.set(game, { season, until: now + 60_000 });
    return season;
  }

  /** Tạo mùa của quý hiện tại; chuyển các mùa đã hết hạn sang trạng thái chờ chốt */
  async rollOver(): Promise<void> {
    for (const g of GAMES) await this.current(g);
    await this.prisma.season.updateMany({
      where: { status: 'active', endAt: { lte: new Date() } },
      data: { status: 'finalizing' },
    });
  }

  toDto(s: Season): SeasonDto {
    return {
      id: s.id,
      game: s.game,
      year: s.year,
      quarter: s.quarter as 1 | 2 | 3 | 4,
      startAt: s.startAt.toISOString(),
      endAt: s.endAt.toISOString(),
      status: s.status,
      daysLeft: s.status === 'active' ? daysLeft(s.endAt) : 0,
    };
  }
}
