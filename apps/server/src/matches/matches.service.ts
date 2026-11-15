import { BadRequestException, HttpException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { isGameType, replayGame, replayJieqi, validateJieqiSetup, type EndReason, type GameEngine } from '@cotuong/game-core';
import {
  AI_LEVELS,
  formatTimeControl,
  validateCustomTimeControl,
  type AiLevel,
  type MatchDetailDto,
  type MatchSummaryDto,
} from '@cotuong/shared';
import { PrismaService } from '../common/prisma.service';
import { RedisService } from '../common/redis.service';
import { matchSummary, publicUser } from '../users/users.service';
import { isUuid } from '../common/ids';

const VALID_REASONS: EndReason[] = [
  'checkmate',
  'stalemate',
  'perpetual_check',
  'repetition',
  'insufficient_material',
  'fifty_moves',
  'resign',
  'timeout',
];

/** Ván với máy: tối đa 600 nửa nước (300 nước mỗi bên — dài hơn mọi ván thực tế), 30 lần lưu / giờ / tài khoản */
const AI_SAVE_MAX_PLIES = 600;
const AI_SAVE_PER_HOUR = 30;

@Injectable()
export class MatchesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async detail(id: string): Promise<MatchDetailDto> {
    if (!isUuid(id)) throw new NotFoundException('Không tìm thấy ván đấu');
    const m = await this.prisma.match.findUnique({
      where: { id },
      include: {
        player1: { select: { id: true, username: true, avatarUrl: true, isGuest: true } },
        player2: { select: { id: true, username: true, avatarUrl: true, isGuest: true } },
      },
    });
    // Ván đang diễn ra không cho xem lại
    if (!m || !m.endedAt) throw new NotFoundException('Không tìm thấy ván đấu hoặc ván chưa kết thúc');
    return {
      id: m.id,
      game: m.game,
      mode: m.mode,
      ranked: m.ranked,
      aiLevel: (m.aiLevel as AiLevel) ?? null,
      timeControl: m.timeControl,
      players: [m.player1 ? publicUser(m.player1) : null, m.player2 ? publicUser(m.player2) : null],
      result: m.result,
      endReason: m.endReason,
      ratingChange: m.ratingChange,
      ratingChange2: m.ratingChange2,
      moves: m.moves,
      startedAt: m.startedAt.toISOString(),
      endedAt: m.endedAt.toISOString(),
      variant: m.variant === 'jieqi' ? 'jieqi' : 'standard',
      // Cờ úp: chỉ ván ĐÃ kết thúc mới tới được đây, nên trả chuỗi xếp quân để xem lại an toàn
      setup: m.variant === 'jieqi' ? m.setup : null,
    };
  }

  /**
   * Lưu ván đấu với máy vào lịch sử (tách khỏi thống kê xếp hạng, không tính điểm).
   * Server dựng lại ván bằng game-core để kiểm tra nước đi và kết quả.
   */
  async saveAiMatch(userId: string, body: unknown): Promise<MatchSummaryDto> {
    const b = (body ?? {}) as Record<string, unknown>;
    if (!isGameType(b.game)) throw new BadRequestException('Không rõ loại cờ (cờ tướng hay cờ vua). Bạn tải lại trang rồi thử lại.');
    if (!AI_LEVELS.includes(b.aiLevel as AiLevel)) throw new BadRequestException('Mức độ của máy không hợp lệ. Bạn tải lại trang rồi thử lại.');
    if (b.humanColor !== 0 && b.humanColor !== 1) throw new BadRequestException('Bên cầm quân không hợp lệ');
    if (!Array.isArray(b.moves) || b.moves.length > AI_SAVE_MAX_PLIES || !b.moves.every((m) => typeof m === 'string' && m.length <= 6)) {
      throw new BadRequestException('Danh sách nước đi không hợp lệ');
    }
    // Đi lại cả ván để kiểm tra tốn CPU: giới hạn số lần lưu mỗi giờ của mỗi tài khoản
    if ((await this.redis.hit(`rl:ai-save:${userId}`, 3600)) > AI_SAVE_PER_HOUR) {
      throw new HttpException('Bạn đã lưu quá nhiều ván với máy trong giờ qua, hãy thử lại sau', HttpStatus.TOO_MANY_REQUESTS);
    }
    const result = b.result as { winner?: unknown; reason?: unknown } | undefined;
    if (!result || !VALID_REASONS.includes(result.reason as EndReason)) throw new BadRequestException('Kết quả không hợp lệ');
    if (result.winner !== null && result.winner !== 0 && result.winner !== 1) throw new BadRequestException('Kết quả không hợp lệ');
    let tcString: string | null = null;
    if (b.timeControl !== null && b.timeControl !== undefined) {
      const tc = b.timeControl as { initialMs?: unknown; incrementMs?: unknown };
      const minutes = Number(tc.initialMs) / 60_000;
      const inc = Number(tc.incrementMs) / 1000;
      const err = validateCustomTimeControl(minutes, inc);
      if (err) throw new BadRequestException(err);
      tcString = formatTimeControl({ initialMs: Number(tc.initialMs), incrementMs: Number(tc.incrementMs) });
    }
    const moves = b.moves as string[];
    const variant = b.variant === undefined || b.variant === 'standard' ? 'standard' : b.variant === 'jieqi' ? 'jieqi' : null;
    if (!variant) throw new BadRequestException('Không rõ kiểu ván (cờ thường hay cờ úp). Bạn tải lại trang rồi thử lại.');
    let setup: string | null = null;
    if (variant === 'jieqi') {
      if (b.game !== 'xiangqi') throw new BadRequestException('Cờ úp chỉ dùng bàn cờ tướng');
      const err = validateJieqiSetup(b.setup);
      if (err) throw new BadRequestException(err);
      setup = b.setup as string;
    }
    let engine: GameEngine;
    try {
      engine = setup ? replayJieqi(setup, moves) : replayGame(b.game, moves);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
    const st = engine.status();
    const reason = result.reason as EndReason;
    const winner = result.winner as 0 | 1 | null;
    if (st.over) {
      if (st.result.reason !== reason || st.result.winner !== winner) {
        throw new BadRequestException('Kết quả không khớp với thế cờ');
      }
    } else if (reason === 'resign') {
      // Chỉ người chơi được đầu hàng (máy không đầu hàng)
      if (winner === b.humanColor || winner === null) throw new BadRequestException('Kết quả không hợp lệ');
    } else if (reason === 'timeout') {
      // Hết giờ: bên thua phải là bên đang tới lượt đi
      if (!tcString || winner === null || winner === engine.turn()) throw new BadRequestException('Kết quả không hợp lệ');
    } else {
      throw new BadRequestException('Kết quả không khớp với thế cờ');
    }
    const now = Date.now();
    const started = Date.parse(String(b.startedAt));
    const startedAt = Number.isFinite(started) && started <= now && started > now - 86_400_000 ? new Date(started) : new Date(now);
    const m = await this.prisma.match.create({
      data: {
        game: b.game,
        mode: 'ai',
        ranked: false,
        aiLevel: b.aiLevel as string,
        timeControl: tcString,
        player1Id: b.humanColor === 0 ? userId : null,
        player2Id: b.humanColor === 1 ? userId : null,
        result: winner === null ? 'draw' : winner === 0 ? 'p1' : 'p2',
        endReason: reason,
        moves,
        startedAt,
        endedAt: new Date(now),
        variant,
        setup,
      },
      include: {
        player1: { select: { id: true, username: true, avatarUrl: true, isGuest: true } },
        player2: { select: { id: true, username: true, avatarUrl: true, isGuest: true } },
      },
    });
    return matchSummary(m, userId);
  }
}
