import { Injectable } from '@nestjs/common';
import { CHAT_LIMITS, ERROR_CODES, type ChatMessageDto } from '@cotuong/shared';
import { GameError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { RealtimeService } from '../common/realtime.service';
import { RedisService } from '../common/redis.service';
import { LiveMatchService } from './live-match.service';

import { isUuid } from '../common/ids';

const ch = (code: number) => String.fromCharCode(code);
/**
 * Ký tự điều khiển hướng chữ U+202A–U+202E (LRE/RLE/PDF/LRO/RLO) và U+2066–U+2069 (LRI/RLI/FSI/PDI): đảo thứ tự hiển
 * thị, dùng để giả mạo nội dung. Dựng từ mã ký tự để mã nguồn không chứa ký tự vô hình.
 */
const BIDI_CONTROLS = new RegExp(`[${ch(0x202a)}-${ch(0x202e)}${ch(0x2066)}-${ch(0x2069)}]`, 'g');
/** Xuống dòng / tab / ký tự điều khiển khác (\p{Cc}) + ký tự ngắt dòng / ngắt đoạn Unicode U+2028, U+2029 */
const LINE_BREAKS_AND_CONTROLS = new RegExp(`[\\p{Cc}${ch(0x2028)}${ch(0x2029)}]+`, 'gu');

/**
 * Chuẩn hoá tin nhắn chat: ô nhập trên giao diện chỉ có một dòng, nhưng client tự viết gửi được "x\n\n\n…y" làm bong
 * bóng chat cao hàng nghìn pixel → đổi mọi xuống dòng / ký tự điều khiển thành một khoảng trắng, bỏ ký tự đảo hướng chữ.
 */
export function normalizeChatText(raw: string): string {
  return raw.replace(BIDI_CONTROLS, '').replace(LINE_BREAKS_AND_CONTROLS, ' ').trim();
}

/**
 * Chat tự do trong ván: tối đa 1 tin mỗi 2 giây, 200 ký tự mỗi tin; có báo cáo tin nhắn để admin xử lý.
 * Không lọc từ, không có nút tắt chat (đã chốt).
 */
@Injectable()
export class ChatService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly realtime: RealtimeService,
    private readonly live: LiveMatchService,
  ) {}

  async send(user: { id: string; username: string }, matchId: string, content: unknown): Promise<ChatMessageDto> {
    const text = typeof content === 'string' ? normalizeChatText(content) : '';
    if (!text) throw new GameError('Tin nhắn trống');
    if (text.length > CHAT_LIMITS.maxLength) throw new GameError(`Tin nhắn tối đa ${CHAT_LIMITS.maxLength} ký tự`);
    const s = await this.live.load(matchId);
    if (!s || this.live.colorOf(s, user.id) === null) throw new GameError('Bạn không ở trong ván này');
    if (!(await this.redis.rateLimitOnce(`chat:rl:${user.id}`, CHAT_LIMITS.minIntervalMs))) {
      throw new GameError('Gửi chậm lại một chút: tối đa 1 tin mỗi 2 giây', ERROR_CODES.RATE_LIMITED);
    }
    const msg = await this.prisma.chatMessage.create({ data: { matchId: s.id, userId: user.id, content: text } });
    const dto: ChatMessageDto = {
      id: msg.id,
      matchId: msg.matchId,
      userId: user.id,
      username: user.username,
      content: msg.content,
      createdAt: msg.createdAt.toISOString(),
    };
    this.realtime.toMatch(s.id, 'chat:message', dto);
    return dto;
  }

  async history(matchId: string): Promise<ChatMessageDto[]> {
    if (!isUuid(matchId)) return [];
    const rows = await this.prisma.chatMessage.findMany({
      where: { matchId, isDeleted: false },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { user: { select: { username: true } } },
    });
    return rows.reverse().map((m) => ({
      id: m.id,
      matchId: m.matchId,
      userId: m.userId,
      username: m.user.username,
      // Tin cũ (gửi trước khi có chuẩn hoá) cũng hiển thị trên một dòng
      content: normalizeChatText(m.content),
      createdAt: m.createdAt.toISOString(),
    }));
  }

  async report(reporterId: string, messageId: unknown): Promise<void> {
    if (!isUuid(messageId)) throw new GameError('Tin nhắn không hợp lệ');
    const msg = await this.prisma.chatMessage.findUnique({
      where: { id: messageId },
      include: { match: { select: { player1Id: true, player2Id: true } } },
    });
    if (!msg || msg.isDeleted) throw new GameError('Tin nhắn không tồn tại');
    if (msg.userId === reporterId) throw new GameError('Không thể báo cáo tin nhắn của chính bạn');
    if (msg.match.player1Id !== reporterId && msg.match.player2Id !== reporterId) {
      throw new GameError('Bạn không ở trong ván này');
    }
    await this.prisma.chatReport.upsert({
      where: { messageId_reporterId: { messageId, reporterId } },
      create: { messageId, reporterId },
      update: {},
    });
  }

  /** Admin xoá tin nhắn: ẩn khỏi ván và đóng các báo cáo liên quan */
  async deleteMessage(messageId: string): Promise<void> {
    if (!isUuid(messageId)) throw new GameError('Tin nhắn không hợp lệ');
    const msg = await this.prisma.chatMessage.update({ where: { id: messageId }, data: { isDeleted: true } });
    await this.prisma.chatReport.updateMany({ where: { messageId, status: 'open' }, data: { status: 'resolved' } });
    this.realtime.toMatch(msg.matchId, 'chat:deleted', { matchId: msg.matchId, messageId });
  }
}
