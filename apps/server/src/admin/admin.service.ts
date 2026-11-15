import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { AI_LEVELS, type AdminReportDto, type AdminUserDto, type Paginated, type ReportStatus } from '@cotuong/shared';
import { PrismaService } from '../common/prisma.service';
import { RealtimeService } from '../common/realtime.service';
import { SessionService } from '../auth/session.service';
import { ChatService } from '../game/chat.service';
import { MatchmakingService } from '../game/matchmaking.service';
import { LeaderboardService } from '../leaderboard/leaderboard.service';
import { UsersService, publicUser } from '../users/users.service';
import { isUuid } from '../common/ids';
import { botGameOfEmail } from '../bots/bot-accounts';

const PAGE_SIZE = 25;
/** Hiển thị thay cho người báo cáo không còn tài khoản (trang admin ghi "… (khách)", không có liên kết hồ sơ) */
const DELETED_REPORTER = { id: '', username: 'Tài khoản đã xoá', avatarUrl: null, isGuest: true } as const;

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly realtime: RealtimeService,
    private readonly matchmaking: MatchmakingService,
    private readonly leaderboard: LeaderboardService,
    private readonly chat: ChatService,
    private readonly users: UsersService,
  ) {}

  async listUsers(q: string | undefined, page: number): Promise<Paginated<AdminUserDto>> {
    const p = Math.max(1, Math.floor(page) || 1);
    const query = (q ?? '').trim();
    // Không liệt kê tài khoản khách (danh tính tạm, tự xoá)
    const where: Prisma.UserWhereInput = query
      ? {
          isGuest: false,
          OR: [
            { username: { contains: query, mode: 'insensitive' } },
            { email: { contains: query, mode: 'insensitive' } },
          ],
        }
      : { isGuest: false };
    const [total, rows] = await Promise.all([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (p - 1) * PAGE_SIZE, take: PAGE_SIZE }),
    ]);
    return {
      items: rows.map((u) => ({
        id: u.id,
        username: u.username,
        email: u.email,
        role: u.role,
        isBanned: u.isBanned,
        emailVerified: u.emailVerifiedAt !== null,
        avatarUrl: u.avatarUrl,
        createdAt: u.createdAt.toISOString(),
        // Chỉ admin thấy: tài khoản máy chơi
        botLevel: u.isBot ? (AI_LEVELS.find((l) => l === u.botLevel) ?? 'medium') : null,
        botGame: u.isBot ? botGameOfEmail(u.email) : null,
      })),
      total,
      page: p,
      pageSize: PAGE_SIZE,
    };
  }

  async setBanned(adminId: string, userId: string, banned: boolean): Promise<void> {
    if (!isUuid(userId)) throw new NotFoundException('Không tìm thấy tài khoản');
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('Không tìm thấy tài khoản');
    if (banned && (user.id === adminId || user.role === 'admin')) {
      throw new BadRequestException('Không thể khoá tài khoản admin');
    }
    await this.prisma.user.update({ where: { id: userId }, data: { isBanned: banned } });
    if (banned) {
      // Huỷ mọi phiên, ngắt kết nối realtime, rời hàng chờ. Nếu đang trong ván: mất kết nối quá 60 giây sẽ bị xử thua.
      const sids = await this.sessions.revokeAll(userId);
      await this.matchmaking.leave(userId);
      for (const sid of sids) this.realtime.disconnectSession(sid);
      this.realtime.disconnectUser(userId);
    }
    await this.leaderboard.refreshUser(userId);
  }

  async clearAvatar(userId: string): Promise<void> {
    if (!isUuid(userId)) throw new NotFoundException('Không tìm thấy tài khoản');
    await this.users.clearAvatar(userId);
  }

  async listReports(status: ReportStatus, page: number): Promise<Paginated<AdminReportDto>> {
    const p = Math.max(1, Math.floor(page) || 1);
    const where: Prisma.ChatReportWhereInput = { status };
    const [total, rows] = await Promise.all([
      this.prisma.chatReport.count({ where }),
      this.prisma.chatReport.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (p - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        include: {
          reporter: { select: { id: true, username: true, avatarUrl: true, isGuest: true } },
          message: { include: { user: { select: { id: true, username: true, avatarUrl: true, isGuest: true } } } },
        },
      }),
    ]);
    return {
      items: rows.map((r) => ({
        id: r.id,
        status: r.status,
        createdAt: r.createdAt.toISOString(),
        // Người báo cáo đã bị xoá (vd khách cũ được dọn): báo cáo vẫn giữ, hiện như khách (không có trang hồ sơ)
        reporter: r.reporter ? publicUser(r.reporter) : DELETED_REPORTER,
        message: {
          id: r.message.id,
          content: r.message.content,
          isDeleted: r.message.isDeleted,
          createdAt: r.message.createdAt.toISOString(),
          matchId: r.message.matchId,
          author: publicUser(r.message.user),
        },
      })),
      total,
      page: p,
      pageSize: PAGE_SIZE,
    };
  }

  async deleteMessage(messageId: string): Promise<void> {
    const exists = isUuid(messageId)
      ? await this.prisma.chatMessage.findUnique({ where: { id: messageId } })
      : null;
    if (!exists) throw new NotFoundException('Không tìm thấy tin nhắn');
    await this.chat.deleteMessage(messageId);
  }

  async dismissReport(reportId: string): Promise<void> {
    if (!isUuid(reportId)) throw new NotFoundException('Không tìm thấy báo cáo');
    const r = await this.prisma.chatReport.updateMany({ where: { id: reportId, status: 'open' }, data: { status: 'dismissed' } });
    if (r.count === 0) throw new NotFoundException('Không tìm thấy báo cáo đang mở');
  }
}
