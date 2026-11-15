import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { GameType } from '@cotuong/game-core';
import {
  ERROR_CODES,
  JIEQI_CASUAL_TIME_CONTROL,
  RANKED_TIME_CONTROL,
  START_RATING,
  matchmakingRange,
  type GameVariant,
  type QueueStatusDto,
} from '@cotuong/shared';
import { AppConfig } from '../config';
import { BotsService } from '../bots/bots.service';
import { GameError } from '../common/errors';
import { PresenceService } from '../common/presence.service';
import { PrismaService } from '../common/prisma.service';
import { RealtimeService } from '../common/realtime.service';
import { RedisService } from '../common/redis.service';
import { RatingsService } from '../seasons/ratings.service';
import { GAMES, SeasonsService } from '../seasons/seasons.service';
import { LiveMatchService, type LiveMatchState, type LivePlayerState } from './live-match.service';

/**
 * Hàng chờ: mỗi game xếp hạng một hàng ('xiangqi', 'chess') + hàng cờ úp ('jieqi', ghép thường, không tính điểm).
 */
type QueueId = GameType | 'jieqi';
const QUEUES: readonly QueueId[] = [...GAMES, 'jieqi'];

interface QueueEntry {
  userId: string;
  username: string;
  avatarUrl: string | null;
  /** Khách (chưa đăng nhập): chỉ được vào hàng Cờ úp */
  isGuest?: boolean;
  /** Điểm hạng quý hiện tại (hàng cờ úp: chỉ để hiện cấp bậc cạnh tên, không dùng để ghép) */
  rating: number;
  seasonId: string;
  joinedAt: number;
  socketId: string;
}

const K = {
  queue: (q: QueueId) => `mm:q:${q}`,
  user: (userId: string) => `mm:u:${userId}`,
  lock: (q: QueueId) => `lock:mm:${q}`,
  userRoom: (userId: string) => `u:room:${userId}`,
};

/**
 * Lấy CẢ HAI người ra khỏi hàng chờ, hoặc không ai (nếu một người vừa huỷ / rời hàng trong lúc vòng ghép đang chạy).
 * KEYS: hàng chờ, mm:u:a, mm:u:b · ARGV: userId a, userId b
 */
const TAKE_PAIR = `
if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 1 and redis.call('HEXISTS', KEYS[1], ARGV[2]) == 1 then
  redis.call('HDEL', KEYS[1], ARGV[1], ARGV[2])
  redis.call('DEL', KEYS[2], KEYS[3])
  return 1
end
return 0
`;

/**
 * Xoá mục hàng chờ của người dùng NẾU nó vẫn thuộc socket `socketId` (so sánh + xoá trong một bước: người đó có thể
 * vừa vào lại hàng từ socket khác, vd tải lại trang). KEYS: hàng chờ, mm:u:<user> · ARGV: userId, socketId
 */
const REMOVE_IF_SOCKET = `
local raw = redis.call('HGET', KEYS[1], ARGV[1])
if not raw then return 0 end
local ok, e = pcall(cjson.decode, raw)
if not ok or type(e) ~= 'table' or e.socketId ~= ARGV[2] then return 0 end
redis.call('HDEL', KEYS[1], ARGV[1])
redis.call('DEL', KEYS[2])
return 1
`;

const queueOf = (game: GameType, variant: GameVariant): QueueId => (variant === 'jieqi' ? 'jieqi' : game);
const gameOf = (q: QueueId): GameType => (q === 'jieqi' ? 'xiangqi' : q);
const variantOf = (q: QueueId): GameVariant => (q === 'jieqi' ? 'jieqi' : 'standard');
const isQueueId = (v: unknown): v is QueueId => typeof v === 'string' && (QUEUES as readonly string[]).includes(v);

export interface QueueUser {
  id: string;
  username: string;
  avatarUrl: string | null;
  emailVerified: boolean;
  isGuest?: boolean;
}

/**
 * Ghép trận xếp hạng: đối thủ chênh lệch tối đa ±100 điểm; mỗi 10 giây chờ nới thêm 50, tối đa ±400.
 * Hai người được ghép khi chênh lệch nằm trong khoảng chấp nhận của CẢ HAI bên.
 * Chờ quá BOT_FALLBACK_SEC (mặc định 30 giây) vẫn chưa có ai: ghép với một tài khoản máy đang rảnh (xem BotsService).
 * Cờ úp: ghép theo thứ tự vào hàng (không xét điểm), không tính điểm hạng, không ghép với máy.
 * Hàng chờ ở Redis; mỗi giây một instance (giữ khoá) chạy vòng ghép.
 */
@Injectable()
export class MatchmakingService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Matchmaking');
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly redis: RedisService,
    private readonly seasons: SeasonsService,
    private readonly ratings: RatingsService,
    private readonly live: LiveMatchService,
    private readonly realtime: RealtimeService,
    private readonly bots: BotsService,
    private readonly presence: PresenceService,
    private readonly prisma: PrismaService,
    private readonly cfg: AppConfig,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.tick(), 1_000);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private status(e: QueueEntry | null, q: QueueId | null): QueueStatusDto {
    if (!e || !q) return { searching: false, game: null, range: null, waitedMs: 0, rating: null };
    const waited = Date.now() - e.joinedAt;
    if (q === 'jieqi') {
      return { searching: true, game: 'xiangqi', range: null, waitedMs: waited, rating: null, variant: 'jieqi' };
    }
    return { searching: true, game: q, range: matchmakingRange(waited), waitedMs: waited, rating: e.rating, variant: 'standard' };
  }

  async join(user: QueueUser, game: GameType, socketId: string, variant: GameVariant = 'standard'): Promise<QueueStatusDto> {
    if (variant === 'jieqi' && game !== 'xiangqi') throw new GameError('Cờ úp chỉ dùng bàn cờ tướng');
    const q = queueOf(game, variant);
    // Chỉ ván xếp hạng mới cần tài khoản (khách chơi được Cờ úp) và email đã xác thực (cờ úp không tính điểm)
    if (q !== 'jieqi' && user.isGuest) {
      throw new GameError('Bạn cần đăng nhập để chơi xếp hạng', 'login_required');
    }
    if (q !== 'jieqi' && !user.emailVerified) {
      throw new GameError('Ván xếp hạng cần email đã xác thực. Bạn hãy mở thư xác thực trong hộp thư rồi thử lại.', ERROR_CODES.EMAIL_NOT_VERIFIED);
    }
    if (await this.live.activeMatchOf(user.id)) {
      throw new GameError('Bạn đang có một ván chưa kết thúc. Hãy vào lại ván đó trước.', ERROR_CODES.IN_MATCH);
    }
    if ((await this.redis.client.exists(K.userRoom(user.id))) === 1) {
      throw new GameError('Bạn đang có phòng riêng chờ bạn bè vào. Hãy huỷ phòng đó trước khi tìm đối thủ.', ERROR_CODES.HAS_ROOM);
    }
    const current = await this.redis.client.get(K.user(user.id));
    let previous: QueueEntry | null = null;
    if (isQueueId(current)) {
      const raw = await this.redis.client.hget(K.queue(current), user.id);
      previous = raw ? (JSON.parse(raw) as QueueEntry) : null;
      if (current !== q) {
        await this.leave(user.id);
        previous = null;
      }
    }
    const season = await this.seasons.current(gameOf(q));
    const rating =
      q === 'jieqi'
        ? ((await this.ratings.find(user.id, season.id))?.rating ?? START_RATING)
        : (await this.ratings.getOrCreate(user.id, season.id)).rating;
    const entry: QueueEntry = {
      userId: user.id,
      username: user.username,
      avatarUrl: user.avatarUrl,
      ...(user.isGuest ? { isGuest: true } : {}),
      rating,
      seasonId: season.id,
      joinedAt: previous?.joinedAt ?? Date.now(),
      socketId,
    };
    await this.redis.client.multi().hset(K.queue(q), user.id, JSON.stringify(entry)).set(K.user(user.id), q, 'EX', 3600).exec();
    return this.status(entry, q);
  }

  /**
   * Rời hàng chờ: xoá khỏi MỌI hàng (không dựa vào con trỏ mm:u — nó có thể đã hết hạn) và báo cho mọi tab của người đó.
   */
  async leave(userId: string): Promise<void> {
    const multi = this.redis.client.multi();
    for (const q of QUEUES) multi.hdel(K.queue(q), userId);
    await multi.del(K.user(userId)).exec();
    this.realtime.toUser(userId, 'queue:status', this.status(null, null));
  }

  /** Socket tìm trận bị ngắt: rời hàng chờ (tìm ở mọi hàng, không dựa vào con trỏ mm:u) */
  async onSocketGone(userId: string, socketId: string): Promise<void> {
    for (const q of QUEUES) {
      if (await this.removeIfSocket(q, userId, socketId)) {
        this.realtime.toUser(userId, 'queue:status', this.status(null, null));
        return;
      }
    }
  }

  private async removeIfSocket(q: QueueId, userId: string, socketId: string): Promise<boolean> {
    return Number(await this.redis.client.eval(REMOVE_IF_SOCKET, 2, K.queue(q), K.user(userId), userId, socketId)) === 1;
  }

  /**
   * Bỏ các mục hàng chờ mà socket đã chết (server khởi động lại / sập không kịp dọn, socket đóng giữa lúc đang vào hàng)
   * — không thì người đã rời đi vẫn bị ghép (kể cả với máy) và bị trừ điểm. Làm mới hạn con trỏ mm:u của người còn chờ.
   */
  private async dropDead(q: QueueId, entries: QueueEntry[]): Promise<QueueEntry[]> {
    const alive: QueueEntry[] = [];
    for (const e of entries) {
      if (await this.presence.isSocketAlive(e.userId, e.socketId)) {
        alive.push(e);
        continue;
      }
      // Chỉ xoá nếu mục vẫn là của socket đã chết (người đó có thể vừa vào lại hàng từ socket khác)
      if (await this.removeIfSocket(q, e.userId, e.socketId)) {
        this.realtime.toUser(e.userId, 'queue:status', this.status(null, null));
        this.logger.log(`Bỏ khỏi hàng chờ ${q}: ${e.username} (mất kết nối)`);
      }
    }
    if (alive.length) {
      const multi = this.redis.client.multi();
      for (const e of alive) multi.expire(K.user(e.userId), 3600);
      await multi.exec();
    }
    return alive;
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const q of QUEUES) {
        const token = await this.redis.tryLock(K.lock(q), 5_000);
        if (!token) continue;
        try {
          await this.matchQueue(q);
        } finally {
          await this.redis.unlock(K.lock(q), token);
        }
      }
    } catch (e) {
      this.logger.warn(`tick: ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /** Chọn các cặp: xếp hạng theo điểm (khoảng chấp nhận của cả hai), cờ úp theo thứ tự vào hàng */
  private pairUp(q: QueueId, entries: QueueEntry[], now: number): Array<[QueueEntry, QueueEntry]> {
    entries.sort((a, b) => a.joinedAt - b.joinedAt);
    const pairs: Array<[QueueEntry, QueueEntry]> = [];
    if (q === 'jieqi') {
      for (let i = 0; i + 1 < entries.length; i += 2) pairs.push([entries[i], entries[i + 1]]);
      return pairs;
    }
    const used = new Set<string>();
    for (const a of entries) {
      if (used.has(a.userId)) continue;
      const wa = matchmakingRange(now - a.joinedAt);
      let best: QueueEntry | null = null;
      let bestDiff = Infinity;
      for (const b of entries) {
        if (b.userId === a.userId || used.has(b.userId)) continue;
        const diff = Math.abs(a.rating - b.rating);
        const allowed = Math.min(wa, matchmakingRange(now - b.joinedAt));
        if (diff <= allowed && diff < bestDiff) {
          best = b;
          bestDiff = diff;
        }
      }
      if (best) {
        used.add(a.userId);
        used.add(best.userId);
        pairs.push([a, best]);
      }
    }
    // Theo yêu cầu chủ sản phẩm (12/11/2026): có từ 2 người thật đang tìm trận thì LUÔN ghép họ với nhau, kể cả khi chênh
    // điểm vượt khoảng chấp nhận — người thật được ưu tiên hơn máy. Những người còn lại xếp theo điểm rồi ghép từng cặp
    // liền kề (cặp gần điểm nhất); chỉ người còn lẻ một mình mới chờ tiếp / được ghép với máy (botFallback).
    const rest = entries.filter((e) => !used.has(e.userId)).sort((a, b) => a.rating - b.rating || a.joinedAt - b.joinedAt);
    for (let i = 0; i + 1 < rest.length; i += 2) pairs.push([rest[i], rest[i + 1]]);
    return pairs;
  }

  private async matchQueue(q: QueueId): Promise<void> {
    const all = await this.redis.client.hgetall(K.queue(q));
    const entries = await this.dropDead(
      q,
      Object.values(all).map((v) => JSON.parse(v) as QueueEntry),
    );
    // Một người ở hàng chờ xếp hạng vẫn cần xét ghép với tài khoản máy
    const botFallback = q !== 'jieqi' && this.cfg.botFallbackMs !== null;
    if (entries.length < (botFallback ? 1 : 2)) return;
    const game = gameOf(q);
    const variant = variantOf(q);
    // Sang quý mới trong lúc chờ: dùng điểm của mùa mới (START_RATING = 0)
    const season = await this.seasons.current(game);
    for (const e of entries) {
      if (e.seasonId !== season.id) {
        e.seasonId = season.id;
        e.rating =
          q === 'jieqi'
            ? ((await this.ratings.find(e.userId, season.id))?.rating ?? START_RATING)
            : (await this.ratings.getOrCreate(e.userId, season.id)).rating;
      }
    }
    const pairs = this.pairUp(q, entries, Date.now());
    for (const [a, b] of pairs) {
      // Một trong hai vừa huỷ tìm trận / rời hàng trong lúc vòng ghép chạy → không ghép cặp này
      const taken = await this.redis.client.eval(TAKE_PAIR, 3, K.queue(q), K.user(a.userId), K.user(b.userId), a.userId, b.userId);
      if (Number(taken) !== 1) continue;
      try {
        const match = await this.createMatch(q, season.id, [playerOf(a), playerOf(b)]);
        for (const p of [a, b]) {
          this.realtime.toUser(p.userId, 'queue:status', this.status(null, null));
          this.realtime.toUser(p.userId, 'match:found', { matchId: match.id, game, variant });
        }
        this.logger.log(`Ghép trận ${q}: ${a.username} (${a.rating}) vs ${b.username} (${b.rating})`);
      } catch (e) {
        this.logger.warn(`Không tạo được ván: ${(e as Error).message}`);
        // Đưa người không bận trở lại hàng chờ — trừ tài khoản không còn dùng được (vd khách cũ vừa bị dọn khi socket vẫn
        // mở): đưa lại thì lần ghép sau lại hỏng và chặn người thật đang chờ
        const usable = await this.usableUsers([a.userId, b.userId]);
        for (const p of [a, b]) await this.requeue(q, p, usable);
      }
    }
    // Hàng chờ xếp hạng: ai chờ quá lâu mà vẫn chưa có đối thủ thì ghép với tài khoản máy
    if (q !== 'jieqi' && this.cfg.botFallbackMs !== null) {
      const paired = new Set(pairs.flatMap(([a, b]) => [a.userId, b.userId]));
      await this.botFallback(q, season.id, entries.filter((e) => !paired.has(e.userId)), this.cfg.botFallbackMs);
    }
  }

  /** Tạo ván từ hàng chờ (người với người, hoặc người với tài khoản máy — cùng một cách) */
  private createMatch(q: QueueId, seasonId: string, players: [LivePlayerState, LivePlayerState]): Promise<LiveMatchState> {
    return this.live.create({
      game: gameOf(q),
      kind: q === 'jieqi' ? 'casual' : 'ranked',
      variant: variantOf(q),
      players,
      timeControl: q === 'jieqi' ? { ...JIEQI_CASUAL_TIME_CONTROL } : { ...RANKED_TIME_CONTROL },
      seasonId: q === 'jieqi' ? null : seasonId,
    });
  }

  /**
   * Trong các tài khoản này, những ai vẫn còn và chưa bị khoá. Không tra được (DB lỗi) → null = coi như đều dùng được (lỗi
   * tạm thời không được làm mất chỗ trong hàng chờ của người thật).
   */
  private async usableUsers(ids: string[]): Promise<Set<string> | null> {
    try {
      const rows = await this.prisma.user.findMany({ where: { id: { in: ids }, isBanned: false }, select: { id: true } });
      return new Set(rows.map((r) => r.id));
    } catch {
      return null;
    }
  }

  /**
   * Đưa người chơi trở lại hàng chờ (giữ thời điểm vào hàng) nếu không bận ván khác. `usable` (nếu có): tài khoản không
   * nằm trong đó (đã bị xoá / bị khoá) thì bỏ khỏi hàng chờ.
   */
  private async requeue(q: QueueId, p: QueueEntry, usable: Set<string> | null = null): Promise<void> {
    if (usable && !usable.has(p.userId)) {
      this.logger.warn(`Bỏ ${p.userId} khỏi hàng chờ ${q}: tài khoản không còn dùng được`);
      this.realtime.toUser(p.userId, 'queue:status', this.status(null, null));
      return;
    }
    if (!(await this.live.activeMatchOf(p.userId))) {
      await this.redis.client.multi().hset(K.queue(q), p.userId, JSON.stringify(p)).set(K.user(p.userId), q, 'EX', 3600).exec();
    } else {
      this.realtime.toUser(p.userId, 'queue:status', this.status(null, null));
    }
  }

  /**
   * Người chờ ở hàng chờ xếp hạng quá `afterMs` mà chưa ghép được với người: ghép với một tài khoản máy đang rảnh
   * (điểm mùa này gần nhất). Ván tạo ra là ván xếp hạng bình thường; người chơi nhận `match:found` như mọi khi.
   */
  private async botFallback(q: QueueId, seasonId: string, waiting: QueueEntry[], afterMs: number): Promise<void> {
    const now = Date.now();
    const due = waiting.filter((h) => now - h.joinedAt >= afterMs);
    if (!due.length) return;
    // Đông người (hơn BOT_MAX_ONLINE_HUMANS thành viên đang online) thì không ghép máy — người chơi chờ người.
    // Chỉ đếm thành viên: khách không chơi xếp hạng được, đếm cả khách thì vài chục phiên khách là tắt được việc ghép máy
    const online = await this.presence.onlineMembers();
    if (online > this.cfg.botMaxOnlineHumans) return;
    const used = new Set<string>();
    for (const h of due) {
      const bot = await this.bots.pickOpponent(gameOf(q), seasonId, h.rating, used);
      if (!bot) return;
      used.add(bot.userId);
      // Người chơi vừa rời hàng chờ (hoặc đã được ghép) thì thôi
      if ((await this.redis.client.hdel(K.queue(q), h.userId)) !== 1) continue;
      await this.redis.client.del(K.user(h.userId));
      let match: LiveMatchState;
      try {
        match = await this.createMatch(q, seasonId, [playerOf(h), bot]);
      } catch (e) {
        this.logger.warn(`Không tạo được ván với máy: ${(e as Error).message}`);
        await this.requeue(q, h, await this.usableUsers([h.userId]));
        continue;
      }
      this.realtime.toUser(h.userId, 'queue:status', this.status(null, null));
      this.realtime.toUser(h.userId, 'match:found', { matchId: match.id, game: match.game, variant: variantOf(q) });
      this.logger.log(`Ghép trận ${q} với máy: ${h.username} (${h.rating}) vs ${bot.username} (${bot.rating})`);
      await this.bots.adopt(match).catch((e: Error) => this.logger.warn(`Không khởi động được máy cho ván ${match.id}: ${e.message}`));
    }
  }
}

const playerOf = (e: QueueEntry): LivePlayerState => ({
  userId: e.userId,
  username: e.username,
  avatarUrl: e.avatarUrl,
  // Khách không có điểm / cấp bậc
  rating: e.isGuest ? null : e.rating,
  ...(e.isGuest ? { isGuest: true } : {}),
});
