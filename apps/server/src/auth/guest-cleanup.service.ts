import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { AppConfig } from '../config';
import { PresenceService } from '../common/presence.service';
import { PrismaService } from '../common/prisma.service';
import { RealtimeService } from '../common/realtime.service';
import { RedisService } from '../common/redis.service';

/** Chạy mỗi giờ; nhiều instance thì chỉ một instance làm (khoá Redis) */
const EVERY_MS = 3_600_000;
const LOCK_KEY = 'lock:guest-cleanup';
const BATCH = 500;

/**
 * Khách còn đang dùng thứ gì trong Redis thì chưa xoá: giữ chỗ trong một ván (u:match — LiveMatchService), đang ở hàng
 * chờ ghép trận (mm:u — MatchmakingService), đang có phòng riêng (u:room — RoomsService). Cùng tên khoá với các dịch vụ đó.
 */
const busyKeys = (userId: string) => [`u:match:${userId}`, `mm:u:${userId}`, `u:room:${userId}`];

/**
 * Dọn tài khoản KHÁCH cũ. Phiên đăng nhập có hạn cố định (SESSION_TTL_DAYS, không tự gia hạn) nên khách tạo trước
 * (hạn phiên + 1 ngày) không còn ai dùng được nữa → xoá. Ván đã lưu của khách giữ lại (người chơi → NULL), tin nhắn
 * chat của khách bị xoá theo; báo cáo do khách gửi vẫn giữ (người báo cáo → NULL); khách có tin nhắn đang bị báo cáo mà
 * admin chưa xử lý thì để tới khi xử lý xong. Khách còn đang chơi / chờ ghép / có phòng (busyKeys) hoặc còn socket đang kết nối (một
 * socket mở từ trước khi phiên hết hạn vẫn dùng được danh tính đó) thì để lần sau — xoá lúc đó sẽ để lại "bóng ma" trong
 * hàng chờ chặn người thật. Sau khi xoá vẫn ngắt mọi socket còn sót của các khách đó.
 */
@Injectable()
export class GuestCleanupService {
  private readonly logger = new Logger('GuestCleanup');

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly presence: PresenceService,
    private readonly realtime: RealtimeService,
    private readonly cfg: AppConfig,
  ) {}

  @Interval(EVERY_MS)
  async tick(): Promise<void> {
    try {
      await this.run();
    } catch (e) {
      this.logger.warn(`Dọn khách cũ thất bại: ${(e as Error).message}`);
    }
  }

  /** Khách còn đang được dùng (ván, hàng chờ, phòng, hoặc socket còn kết nối) */
  private async inUse(userId: string): Promise<boolean> {
    if ((await this.redis.client.exists(...busyKeys(userId))) > 0) return true;
    return this.presence.isUserOnline(userId);
  }

  /** Trả về số tài khoản khách đã xoá */
  async run(now = Date.now()): Promise<number> {
    const token = await this.redis.tryLock(LOCK_KEY, 10 * 60_000);
    if (!token) return 0;
    try {
      const before = new Date(now - (this.cfg.sessionTtlSec + 86_400) * 1000);
      let total = 0;
      // Duyệt theo (createdAt, id) tăng dần — khách đang được dùng bị bỏ qua mà không chặn các khách cũ phía sau
      let after: { createdAt: Date; id: string } | null = null;
      for (;;) {
        const rows: { id: string; createdAt: Date }[] = await this.prisma.user.findMany({
          where: {
            isGuest: true,
            createdAt: { lt: before },
            // Tin nhắn của khách đang bị báo cáo (admin chưa xử lý): giữ khách lại tới khi báo cáo được xử lý — xoá khách
            // thì tin nhắn và báo cáo bị xoá theo, admin không còn thấy để xem xét
            chatMessages: { none: { reports: { some: { status: 'open' } } } },
            ...(after ? { OR: [{ createdAt: { gt: after.createdAt } }, { createdAt: after.createdAt, id: { gt: after.id } }] } : {}),
          },
          select: { id: true, createdAt: true },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: BATCH,
        });
        if (!rows.length) break;
        after = rows[rows.length - 1];
        const ids: string[] = [];
        for (const r of rows) if (!(await this.inUse(r.id))) ids.push(r.id);
        if (ids.length) {
          const { count } = await this.prisma.user.deleteMany({ where: { id: { in: ids }, isGuest: true } });
          total += count;
          for (const id of ids) this.realtime.disconnectUser(id);
        }
        if (rows.length < BATCH) break;
      }
      if (total) this.logger.log(`Đã xoá ${total} tài khoản khách cũ`);
      return total;
    } finally {
      await this.redis.unlock(LOCK_KEY, token);
    }
  }
}
