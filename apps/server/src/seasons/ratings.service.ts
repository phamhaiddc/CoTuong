import { Injectable } from '@nestjs/common';
import type { Prisma, Rating } from '@prisma/client';
import {
  START_RATING,
  getTier,
  nextWinStreak,
  rankedDelta,
  ratingAfter,
  tierChange,
  type EloScore,
  type RankedDelta,
  type RatingChangeDto,
} from '@cotuong/shared';
import { AppConfig } from '../config';
import { PrismaService } from '../common/prisma.service';

type Tx = Prisma.TransactionClient;

export interface RankedOutcome {
  /** Điểm thay đổi thực của player1 */
  delta: number;
  /** Điểm thay đổi thực của player2 (khác -delta khi một bên chạm sàn 0) */
  delta2: number;
  changes: [RatingChangeDto, RatingChangeDto];
  rows: [Rating, Rating];
}

@Injectable()
export class RatingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cfg: AppConfig,
  ) {}

  async getOrCreate(userId: string, seasonId: string, tx: Tx = this.prisma): Promise<Rating> {
    return tx.rating.upsert({
      where: { userId_seasonId: { userId, seasonId } },
      create: { userId, seasonId, rating: START_RATING, peakRating: START_RATING },
      update: {},
    });
  }

  async find(userId: string, seasonId: string): Promise<Rating | null> {
    return this.prisma.rating.findUnique({ where: { userId_seasonId: { userId, seasonId } } });
  }

  /**
   * Cập nhật điểm sau ván xếp hạng. score1: 1 = player1 thắng, 0.5 = hoà, 0 = thua.
   * Mỗi bên tính riêng: Elo (K = 32) + luật xếp hạng (RANKED_RULES: 5 ván đầu mùa ×1,5 điểm cộng; thua bị nhân hệ số
   * theo cấp bậc; thưởng chuỗi thắng) rồi qua sàn 0 — nên điểm hai bên không còn luôn đối nhau.
   */
  async applyRankedResult(tx: Tx, seasonId: string, p1: string, p2: string, score1: EloScore): Promise<RankedOutcome> {
    await this.getOrCreate(p1, seasonId, tx);
    await this.getOrCreate(p2, seasonId, tx);
    // Khoá hai dòng điểm (theo thứ tự cố định để không khoá chéo) rồi mới đọc: hai ván kết thúc cùng lúc của cùng một
    // người (vd ghi lại kết quả lỗi + ván mới) không ghi đè điểm của nhau
    await tx.$queryRaw`SELECT 1 FROM ratings WHERE season_id = ${seasonId}::uuid AND user_id IN (${p1}::uuid, ${p2}::uuid) ORDER BY user_id FOR UPDATE`;
    const [r1, r2] = await Promise.all([
      tx.rating.findUniqueOrThrow({ where: { userId_seasonId: { userId: p1, seasonId } } }),
      tx.rating.findUniqueOrThrow({ where: { userId_seasonId: { userId: p2, seasonId } } }),
    ]);
    const score2: EloScore = score1 === 1 ? 0 : score1 === 0 ? 1 : 0.5;
    const calc = (r: Rating, opp: Rating, score: EloScore) =>
      rankedDelta({ rating: r.rating, opponent: opp.rating, score, gamesPlayed: r.gamesPlayed, winStreak: r.winStreak, tiers: this.cfg.tiers });
    const c1 = calc(r1, r2, score1);
    const c2 = calc(r2, r1, score2);
    // Điểm thực nhận của từng bên (qua sàn 0): người thua ở 0 điểm giữ 0, người thắng vẫn nhận đủ
    const delta = ratingAfter(r1.rating, c1.delta) - r1.rating;
    const delta2 = ratingAfter(r2.rating, c2.delta) - r2.rating;
    const now = new Date();
    const update = (r: Rating, d: number, score: EloScore) =>
      tx.rating.update({
        where: { userId_seasonId: { userId: r.userId, seasonId } },
        data: {
          rating: r.rating + d,
          peakRating: Math.max(r.peakRating, r.rating + d),
          wins: { increment: score === 1 ? 1 : 0 },
          losses: { increment: score === 0 ? 1 : 0 },
          draws: { increment: score === 0.5 ? 1 : 0 },
          gamesPlayed: { increment: 1 },
          winStreak: nextWinStreak(r.winStreak, score),
          lastRankedAt: now,
          // Chỉ cập nhật khi điểm thay đổi: dùng để xếp "đạt mức điểm đó sớm hơn"
          ...(d !== 0 ? { ratingUpdatedAt: now } : {}),
        },
      });
    const n1 = await update(r1, delta, score1);
    const n2 = await update(r2, delta2, score2);
    return {
      delta,
      delta2,
      rows: [n1, n2],
      changes: [this.change(r1, n1, c1), this.change(r2, n2, c2)],
    };
  }

  private change(before: Rating, after: Rating, calc?: RankedDelta): RatingChangeDto {
    const tb = getTier(before.rating, this.cfg.tiers);
    const ta = getTier(after.rating, this.cfg.tiers);
    return {
      userId: after.userId,
      before: before.rating,
      after: after.rating,
      delta: after.rating - before.rating,
      tierBefore: tb.name,
      tierAfter: ta.name,
      tierLevelBefore: tb.level,
      tierLevelAfter: ta.level,
      change: tierChange(before.rating, after.rating, this.cfg.tiers),
      ...(calc
        ? { rules: { placement: calc.placement, lossMultiplier: calc.lossMultiplier, streakBonus: calc.streakBonus, winStreak: after.winStreak } }
        : {}),
    };
  }
}
