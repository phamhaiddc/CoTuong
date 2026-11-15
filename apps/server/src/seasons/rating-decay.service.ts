import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { RANKED_RULES, decayedRating } from '@cotuong/shared';
import { AppConfig } from '../config';
import { PrismaService } from '../common/prisma.service';
import { RealtimeService } from '../common/realtime.service';
import { RedisService } from '../common/redis.service';
import { LeaderboardService } from '../leaderboard/leaderboard.service';
import { vnDate, vnDayStart } from '../analytics/analytics.service';
import { GAMES, SeasonsService } from './seasons.service';

const DAY_MS = 86_400_000;

/**
 * Luật "không chơi thì tụt điểm" (RANKED_RULES): người có từ 350 điểm trở lên mà 7 ngày không chơi ván xếp hạng nào
 * của mùa hiện tại → mỗi ngày −5 điểm, không xuống dưới mốc cấp bậc đang có (decayedRating).
 * Kiểm tra mỗi 30 phút. Mỗi dòng điểm chỉ bị trừ MỘT lần mỗi ngày (giờ Việt Nam): lần trừ đặt rating_updated_at = lúc
 * trừ, và chỉ dòng có rating_updated_at trước 00:00 hôm nay mới được xét — nên khởi động lại server, chạy nhiều
 * instance hay chạy lại sau lỗi giữa chừng cũng không trừ hai lần. Khoá Redis theo (mùa, ngày) chỉ được đặt khi đã xét
 * xong cả mùa (lỗi giữa chừng thì lần kiểm tra sau làm tiếp phần còn lại).
 */
@Injectable()
export class RatingDecayService {
  private readonly logger = new Logger('RatingDecay');

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly seasons: SeasonsService,
    private readonly leaderboard: LeaderboardService,
    private readonly realtime: RealtimeService,
    private readonly cfg: AppConfig,
  ) {}

  @Interval(30 * 60_000)
  async tick(): Promise<void> {
    try {
      await this.run();
    } catch (e) {
      this.logger.warn(`Trừ điểm do không chơi thất bại: ${(e as Error).message}`);
    }
  }

  /** Trả về số người bị trừ điểm (theo từng game; game bị lỗi lần này thì không có trong kết quả) */
  async run(now = Date.now()): Promise<Record<string, number>> {
    const day = vnDate(now);
    const dayStart = new Date(vnDayStart(now));
    const result: Record<string, number> = {};
    for (const game of GAMES) {
      try {
        const n = await this.runGame(game, day, dayStart, now);
        if (n !== null) result[game] = n;
      } catch (e) {
        this.logger.warn(`${game}: trừ điểm do không chơi thất bại, sẽ thử lại ở lần kiểm tra sau: ${(e as Error).message}`);
      }
    }
    return result;
  }

  /** null = hôm nay mùa này đã xét xong (hoặc instance khác đang xét) */
  private async runGame(game: (typeof GAMES)[number], day: string, dayStart: Date, now: number): Promise<number | null> {
    const season = await this.seasons.current(game);
    const doneKey = `decay:done:${season.id}:${day}`;
    if ((await this.redis.client.exists(doneKey)) === 1) return null;
    const lockKey = `lock:decay:${season.id}`;
    const token = await this.redis.tryLock(lockKey, 10 * 60_000);
    if (!token) return null;
    let changed = 0;
    try {
      if ((await this.redis.client.exists(doneKey)) === 1) return null;
      const before = new Date(now - RANKED_RULES.decayAfterDays * DAY_MS);
      const rows = await this.prisma.rating.findMany({
        where: {
          seasonId: season.id,
          rating: { gte: RANKED_RULES.decayMinRating },
          // Chưa bị trừ hôm nay (lần trừ đặt rating_updated_at = lúc trừ; ván xếp hạng mới cũng đổi mốc này)
          ratingUpdatedAt: { lt: dayStart },
          // Lần chơi gần nhất cũ hơn 7 ngày (dòng cũ chưa có last_ranked_at thì dùng lúc điểm đổi gần nhất)
          OR: [{ lastRankedAt: { lt: before } }, { lastRankedAt: null, ratingUpdatedAt: { lt: before } }],
        },
        select: { userId: true, rating: true, lastRankedAt: true, ratingUpdatedAt: true },
      });
      for (const r of rows) {
        const next = decayedRating(r.rating, this.cfg.tiers);
        if (next === r.rating) continue;
        // Chỉ trừ khi dòng vẫn như lúc đọc (người đó vừa chơi xong một ván thì bỏ qua lần này).
        // Dòng cũ chưa có last_ranked_at: ghi mốc "lần chơi gần nhất" = lúc điểm đổi gần nhất trước lần trừ này, để
        // những ngày sau vẫn được xét theo last_ranked_at (không bị rating_updated_at = lúc trừ làm lỡ 7 ngày).
        const upd = await this.prisma.rating.updateMany({
          where: {
            userId: r.userId,
            seasonId: season.id,
            rating: r.rating,
            ratingUpdatedAt: r.ratingUpdatedAt,
            lastRankedAt: r.lastRankedAt,
          },
          data: { rating: next, ratingUpdatedAt: new Date(now), lastRankedAt: r.lastRankedAt ?? r.ratingUpdatedAt },
        });
        changed += upd.count;
      }
      await this.redis.client.set(doneKey, '1', 'EX', 3 * 86_400);
      return changed;
    } finally {
      // Cả khi lỗi giữa chừng: những người đã bị trừ phải hiện đúng trên bảng xếp hạng
      if (changed) {
        await this.leaderboard.invalidate(season.id).catch(() => undefined);
        this.realtime.broadcast('leaderboard:changed', { game });
        this.logger.log(`${game}: trừ ${RANKED_RULES.decayPerDay} điểm cho ${changed} người 7 ngày không chơi xếp hạng`);
      }
      await this.redis.unlock(lockKey, token).catch(() => undefined);
    }
  }
}
