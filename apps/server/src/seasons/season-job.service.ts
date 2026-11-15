import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron, Interval } from '@nestjs/schedule';
import type { Season } from '@prisma/client';
import { LEADERBOARD_MIN_GAMES, LEADERBOARD_SIZE, compareStandings } from '@cotuong/shared';
import { PrismaService } from '../common/prisma.service';
import { RedisService } from '../common/redis.service';
import { LeaderboardService } from '../leaderboard/leaderboard.service';
import { SeasonsService } from './seasons.service';

/**
 * Job chốt quý.
 * - 00:00 GMT+7 ngày đầu quý mới: tạo mùa mới, ghép trận quý mới mở ngay (điểm mọi người về 0
 *   vì mỗi mùa có bảng điểm riêng — reset cứng).
 * - Mùa cũ chuyển sang "finalizing": chờ các ván bắt đầu trước 00:00 kết thúc (cộng điểm vào quý cũ),
 *   rồi mới chốt Top 10, ghi thứ hạng cuối quý và đóng mùa.
 * Chạy theo cron hằng ngày lúc 00:00 GMT+7 và kiểm tra lại mỗi 30 giây (tự phục hồi nếu server tắt lúc chuyển quý).
 * Có khoá Redis nên chỉ một instance chạy tại một thời điểm.
 */
@Injectable()
export class SeasonJobService implements OnApplicationBootstrap {
  private readonly logger = new Logger('SeasonJob');

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly seasons: SeasonsService,
    private readonly leaderboard: LeaderboardService,
  ) {}

  onApplicationBootstrap(): void {
    // Lỗi lúc khởi động (vd Redis chưa sẵn sàng) không được làm sập tiến trình — job chạy lại mỗi 30 giây
    this.tick().catch((e: Error) => this.logger.error(`Lỗi job chốt quý lúc khởi động: ${e.message}`));
  }

  @Cron('0 0 0 * * *', { timeZone: 'Asia/Ho_Chi_Minh' })
  async atMidnight(): Promise<void> {
    await this.tick();
  }

  @Interval(30_000)
  async periodic(): Promise<void> {
    await this.tick();
  }

  async tick(): Promise<void> {
    const token = await this.redis.tryLock('lock:season-job', 120_000);
    if (!token) return;
    try {
      await this.seasons.rollOver();
      const pending = await this.prisma.season.findMany({ where: { status: 'finalizing' } });
      for (const s of pending) await this.tryFinalize(s);
    } catch (e) {
      this.logger.error(`Lỗi job chốt quý: ${(e as Error).message}`);
    } finally {
      await this.redis.unlock('lock:season-job', token);
    }
  }

  private async tryFinalize(season: Season): Promise<void> {
    // Vòng ghép trận bắt đầu ngay trước 00:00 có thể tạo ván mang mã mùa cũ vài chục ms SAU mốc chuyển quý.
    // Chờ 1 phút sau khi mùa hết hạn rồi mới xét chốt, để mọi ván như vậy đã có trong DB (và được chờ kết thúc).
    if (Date.now() < season.endAt.getTime() + 60_000) return;
    const live = await this.prisma.match.findMany({
      where: { seasonId: season.id, endedAt: null },
      select: { id: true, startedAt: true },
    });
    let waiting = 0;
    for (const m of live) {
      if ((await this.redis.client.exists(`m:${m.id}`)) === 1) {
        waiting++;
        continue;
      }
      // Ván vừa được tạo: dòng DB có trước, trạng thái realtime được lưu ngay sau → chờ, đừng huỷ nhầm
      if (Date.now() - m.startedAt.getTime() < 60_000) {
        waiting++;
        continue;
      }
      // Ván không còn trạng thái realtime (server dừng đột ngột): huỷ, không tính điểm
      await this.prisma.match.updateMany({
        where: { id: m.id, endedAt: null },
        data: { result: 'aborted', endReason: 'aborted', endedAt: new Date() },
      });
    }
    if (waiting > 0) {
      this.logger.log(`Mùa Q${season.quarter}/${season.year} (${season.game}) chờ ${waiting} ván kết thúc trước khi chốt`);
      return;
    }

    const rows = await this.prisma.rating.findMany({
      where: { seasonId: season.id, gamesPlayed: { gte: LEADERBOARD_MIN_GAMES }, user: { isBanned: false } },
    });
    rows.sort((a, b) =>
      compareStandings(
        { rating: a.rating, wins: a.wins, gamesPlayed: a.gamesPlayed, ratingUpdatedAt: a.ratingUpdatedAt.getTime() },
        { rating: b.rating, wins: b.wins, gamesPlayed: b.gamesPlayed, ratingUpdatedAt: b.ratingUpdatedAt.getTime() },
      ),
    );

    await this.prisma.$transaction(
      async (tx) => {
        for (let i = 0; i < rows.length; i++) {
          await tx.rating.update({
            where: { userId_seasonId: { userId: rows[i].userId, seasonId: season.id } },
            data: { finalRank: i + 1 },
          });
        }
        await tx.seasonResult.deleteMany({ where: { seasonId: season.id } });
        await tx.seasonResult.createMany({
          data: rows.slice(0, LEADERBOARD_SIZE).map((r, i) => ({
            seasonId: season.id,
            rank: i + 1,
            userId: r.userId,
            rating: r.rating,
          })),
        });
        await tx.season.update({ where: { id: season.id }, data: { status: 'closed' } });
      },
      { timeout: 120_000 },
    );
    // Mùa đã chốt: bỏ hẳn cache bảng đang diễn ra của mùa đó (Top 10 đã chốt đọc từ DB qua archive)
    await this.leaderboard.drop(season.id);
    await this.leaderboard.invalidateArchive(season.game);
    this.logger.log(
      `Đã chốt mùa Q${season.quarter}/${season.year} (${season.game}): ${rows.length} người chơi được xếp hạng`,
    );
  }
}
