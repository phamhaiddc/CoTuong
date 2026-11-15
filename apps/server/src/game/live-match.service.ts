import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomInt, randomUUID } from 'crypto';
import {
  JieqiGame,
  otherColor,
  randomJieqiSetup,
  replayGame,
  replayJieqi,
  type Color,
  type EndReason,
  type GameEngine,
  type GameResult,
  type GameType,
  type JieqiReveal,
} from '@cotuong/game-core';
import {
  ERROR_CODES,
  FIRST_MOVE_TIMEOUT_MS,
  RECONNECT_GRACE_MS,
  formatTimeControl,
  getTier,
  type ClockDto,
  type EloScore,
  type GameVariant,
  type LiveMatchKind,
  type MatchStateDto,
  type RatingChangeDto,
  type TimeControl,
} from '@cotuong/shared';
import { AppConfig } from '../config';
import { GameError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { isBotSocket, PresenceService } from '../common/presence.service';
import { RealtimeService } from '../common/realtime.service';
import { RedisService } from '../common/redis.service';
import { LeaderboardService } from '../leaderboard/leaderboard.service';
import { RatingsService, type RankedOutcome } from '../seasons/ratings.service';
import { isUuid } from '../common/ids';

export interface LivePlayerState {
  userId: string;
  username: string;
  avatarUrl: string | null;
  /** Điểm hạng lúc bắt đầu (ván xếp hạng) */
  rating: number | null;
  /** Người chơi là khách (chưa đăng nhập) — chỉ có ở ván không xếp hạng */
  isGuest?: boolean;
}

interface Attachment {
  socketId: string;
  instanceId: string;
}

/** Trạng thái ván lưu ở Redis (không giữ trong bộ nhớ từng server) */
export interface LiveMatchState {
  id: string;
  game: GameType;
  kind: LiveMatchKind;
  ranked: boolean;
  seasonId: string | null;
  /** index = bên cầm quân: 0 = Đỏ/Trắng, 1 = Đen */
  players: [LivePlayerState, LivePlayerState];
  moves: string[];
  tc: TimeControl;
  /** Thời gian còn lại mỗi bên tại thời điểm turnStartedAt */
  remaining: [number, number];
  turnStartedAt: number;
  movesBy: [number, number];
  drawOfferBy: Color | null;
  disconnectedAt: [number | null, number | null];
  attached: [Attachment | null, Attachment | null];
  /**
   * Ghế bị gỡ vì instance giữ socket mất nhịp tim (instance treo / mất kết nối Redis một lúc) trong khi socket có thể vẫn
   * còn: socket đó sống lại thì tự gắn lại (checkAttachments). Thiếu = trạng thái cũ, coi như [null, null].
   */
  lost?: [Attachment | null, Attachment | null];
  status: 'playing' | 'ended';
  result: GameResult | null;
  ratingChanges: [RatingChangeDto, RatingChangeDto] | null;
  startedAt: number;
  endedAt: number | null;
  version: number;
  /** Biến thể (thiếu = 'standard' cho trạng thái cũ) */
  variant?: GameVariant;
  /** Cờ úp: chuỗi xếp quân BÍ MẬT — chỉ nằm ở server, không bao giờ gửi cho người chơi khi ván đang diễn ra */
  setup?: string | null;
  /** Cờ úp: thông tin lật quân công khai của từng nước */
  reveals?: Array<JieqiReveal | null>;
}

const K = {
  state: (id: string) => `m:${id}`,
  deadlines: 'm:deadlines',
  active: 'm:active',
  userMatch: (userId: string) => `u:match:${userId}`,
  lock: (id: string) => `lock:m:${id}`,
  /** Ván đã kết thúc nhưng ghi kết quả vào DB thất bại — thử lại trong sweep */
  pendingDb: 'm:pending-db',
};

/** Hạn của chỗ giữ "đang trong ván" lúc mới tạo (trước khi lưu trạng thái ván) và khi ván đang chạy (làm mới mỗi lần lưu) */
const CLAIM_CREATING_MS = 120_000;
const CLAIM_PLAYING_MS = 24 * 3_600_000;
/** Thử ghi lại kết quả vào DB tối đa mỗi 30 giây */
const PENDING_DB_RETRY_MS = 30_000;

/**
 * Gỡ chỗ giữ "đang trong ván" nếu đã cũ — kiểm tra và xoá trong MỘT bước (tránh xoá nhầm ván vừa tạo xong).
 * KEYS: u:match:<user>, m:<id> · ARGV: id, CLAIM_CREATING_MS. Trả về 1 nếu đã gỡ, 0 nếu chỗ giữ còn hiệu lực.
 */
const HEAL_CLAIM = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
local raw = redis.call('GET', KEYS[2])
if raw then
  local ok, s = pcall(cjson.decode, raw)
  if ok and type(s) == 'table' and s.status == 'playing' then return 0 end
else
  local ttl = redis.call('PTTL', KEYS[1])
  if ttl >= 0 and ttl <= tonumber(ARGV[2]) then return 0 end
end
redis.call('DEL', KEYS[1])
return 1
`;

/** Giữ trạng thái ván đã kết thúc thêm 10 phút để người chơi xem kết quả / vào lại */
const ENDED_TTL_SEC = 600;

/**
 * Lưu trạng thái ván có kiểm tra phiên bản (chống ghi đè bởi nơi giữ khoá cũ, vd tiến trình bị treo lâu hơn hạn khoá
 * rồi chạy tiếp): chỉ ghi khi trạng thái đang lưu vẫn đúng phiên bản đã đọc (ARGV[2]; rỗng = ván mới, ghi luôn).
 * KEYS: m:<id>, m:deadlines, m:active, u:match:<p1>, u:match:<p2>
 * ARGV: json, phiên bản đã đọc, 'playing' | 'ended', hạn kế tiếp, id, CLAIM_PLAYING_MS, ENDED_TTL_SEC
 * Trả về 1 nếu đã ghi, 0 nếu trạng thái đã bị nơi khác đổi.
 */
const SAVE_STATE = `
if ARGV[2] ~= '' then
  local raw = redis.call('GET', KEYS[1])
  if not raw then return 0 end
  local ok, cur = pcall(cjson.decode, raw)
  if not ok or type(cur) ~= 'table' or tostring(cur.version) ~= ARGV[2] then return 0 end
end
if ARGV[3] == 'playing' then
  redis.call('SET', KEYS[1], ARGV[1])
  redis.call('ZADD', KEYS[2], ARGV[4], ARGV[5])
  for i = 4, 5 do
    if redis.call('GET', KEYS[i]) == ARGV[5] then redis.call('PEXPIRE', KEYS[i], ARGV[6]) end
  end
else
  redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[7])
  redis.call('ZREM', KEYS[2], ARGV[5])
  redis.call('SREM', KEYS[3], ARGV[5])
end
return 1
`;

/**
 * Khoá ván được gia hạn trong lúc thao tác còn chạy (vd ghi kết quả vào DB đang bị chậm), tối đa chừng này — không thì
 * khoá 10 giây hết hạn giữa chừng, thao tác khác chen vào kết thúc ván lần nữa với kết quả khác.
 */
const LOCK_KEEP_ALIVE_MS = 60_000;
/** Mỗi câu lệnh SQL khi ghi kết quả ván bị huỷ sau chừng này (dòng bị khoá / DB treo) → chuyển sang ghi lại sau */
const PERSIST_STATEMENT_TIMEOUT_MS = 4_000;

/** Ghế (socket) của người đang thao tác — để kiểm tra luật "một nơi chơi" ở mọi thao tác, không chỉ lúc vào bàn */
export interface SeatActor {
  socketId: string;
}

/** Kết quả ghi DB: đã ghi (kèm thay đổi điểm nếu ván xếp hạng), hoặc DB đã có kết quả từ trước (đọc lại từ DB) */
type PersistResult = { written: true; outcome: RankedOutcome | null } | { written: false; stored: GameResult | null };

const SESSION_CONFLICT_MESSAGE = 'Ván đấu đang được mở ở một tab hoặc thiết bị khác. Hãy đóng nơi đó để tiếp tục tại đây.';
/**
 * Khi vào bàn mà ghế đang do socket khác của cùng người giữ (presence vẫn coi là còn kết nối): hỏi socket đó ("conn:probe"),
 * chờ tối đa chừng này. Không trả lời → kết nối đó đã mất mà máy chủ chưa biết (vd đổi Wi-Fi sang 4G: kết nối cũ treo
 * tới khi hết hạn ping, ~45 giây) → socket mới nhận ghế ngay, khỏi phải chờ trong lúc đồng hồ vẫn chạy.
 */
const SEAT_PROBE_MS = 2_500;

/** Ghế đang do socket khác giữ (kèm id socket đó) — attach() hỏi socket đó còn sống không rồi thử lại */
class SeatHeldError extends GameError {
  constructor(readonly holderSocketId: string) {
    super(SESSION_CONFLICT_MESSAGE, ERROR_CODES.SESSION_CONFLICT);
  }
}

const sameResult = (a: GameResult | null, b: GameResult | null): boolean =>
  a === b || (a !== null && b !== null && a.winner === b.winner && a.reason === b.reason);

const turnOf = (s: LiveMatchState): Color => (s.moves.length % 2) as Color;

@Injectable()
export class LiveMatchService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('LiveMatch');
  /** Cache engine theo số nước đã đi để khỏi dựng lại ván mỗi nước (nước đi chỉ nối thêm, không đổi) */
  private readonly engines = new Map<string, { ply: number; engine: GameEngine }>();
  /** Phiên bản của trạng thái lúc đọc từ Redis (theo đối tượng) — để save() chỉ ghi khi chưa ai đổi trạng thái */
  private readonly loadedVersion = new WeakMap<LiveMatchState, number>();
  private sweepTimer: NodeJS.Timeout | null = null;
  private attachTimer: NodeJS.Timeout | null = null;
  private sweeping = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly realtime: RealtimeService,
    private readonly ratings: RatingsService,
    private readonly leaderboard: LeaderboardService,
    private readonly presence: PresenceService,
    private readonly cfg: AppConfig,
  ) {}

  onModuleInit(): void {
    this.sweepTimer = setInterval(() => void this.sweep(), 500);
    this.attachTimer = setInterval(() => void this.checkAttachments(), 5_000);
  }

  onModuleDestroy(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    if (this.attachTimer) clearInterval(this.attachTimer);
  }

  // ------------------------------------------------------------------ tạo / tải

  /**
   * Tạo ván mới giữa hai người chơi; bên cầm quân chia ngẫu nhiên.
   * Ném lỗi nếu một trong hai người đang ở ván khác.
   */
  async create(opts: {
    game: GameType;
    kind: LiveMatchKind;
    players: [LivePlayerState, LivePlayerState];
    timeControl: TimeControl;
    seasonId: string | null;
    variant?: GameVariant;
  }): Promise<LiveMatchState> {
    const variant: GameVariant = opts.variant ?? 'standard';
    if (variant === 'jieqi' && (opts.game !== 'xiangqi' || opts.kind === 'ranked')) {
      throw new GameError('Cờ úp chỉ dùng bàn cờ tướng và không tính điểm hạng');
    }
    const setup = variant === 'jieqi' ? randomJieqiSetup() : null;
    const id = randomUUID();
    const [a, b] = opts.players;
    if (a.userId === b.userId) throw new GameError('Không thể tự đấu với chính mình');
    // Giữ chỗ: mỗi người chỉ ở trong một ván tại một thời điểm
    const claimed: string[] = [];
    for (const p of opts.players) {
      // Có hạn ngắn lúc đang tạo (lỡ tiến trình chết giữa chừng thì tự hết), gia hạn dài khi lưu trạng thái ván
      const ok = await this.redis.client.set(K.userMatch(p.userId), id, 'PX', CLAIM_CREATING_MS, 'NX');
      if (ok !== 'OK') {
        for (const uid of claimed) await this.redis.delIfEquals(K.userMatch(uid), id);
        throw new GameError(`${p.username} đang ở trong một ván khác`, ERROR_CODES.IN_MATCH);
      }
      claimed.push(p.userId);
    }
    const flip = randomInt(2) === 1;
    const players: [LivePlayerState, LivePlayerState] = flip ? [b, a] : [a, b];
    const now = Date.now();
    try {
      await this.prisma.match.create({
        data: {
          id,
          game: opts.game,
          mode: 'pvp',
          ranked: opts.kind === 'ranked',
          timeControl: formatTimeControl(opts.timeControl),
          player1Id: players[0].userId,
          player2Id: players[1].userId,
          seasonId: opts.seasonId,
          startedAt: new Date(now),
          variant,
          setup,
        },
      });
    } catch (e) {
      for (const uid of claimed) await this.redis.delIfEquals(K.userMatch(uid), id);
      throw e;
    }
    const s: LiveMatchState = {
      id,
      game: opts.game,
      kind: opts.kind,
      ranked: opts.kind === 'ranked',
      seasonId: opts.seasonId,
      players,
      moves: [],
      tc: opts.timeControl,
      remaining: [opts.timeControl.initialMs, opts.timeControl.initialMs],
      turnStartedAt: now,
      movesBy: [0, 0],
      drawOfferBy: null,
      // Chưa vào bàn thì coi như đang mất kết nối: có 60 giây để vào
      disconnectedAt: [now, now],
      attached: [null, null],
      status: 'playing',
      result: null,
      ratingChanges: null,
      startedAt: now,
      endedAt: null,
      version: 1,
      variant,
      setup,
      reveals: [],
    };
    try {
      await this.redis.client.sadd(K.active, id);
      await this.save(s);
    } catch (e) {
      // Không lưu được trạng thái ván: trả chỗ giữ để hai người không bị kẹt "đang trong ván"
      for (const uid of claimed) await this.redis.delIfEquals(K.userMatch(uid), id).catch(() => undefined);
      throw e;
    }
    return s;
  }

  async load(id: string): Promise<LiveMatchState | null> {
    if (!isUuid(id)) return null;
    const s = await this.redis.getJson<LiveMatchState>(K.state(id));
    if (s) this.loadedVersion.set(s, s.version);
    return s;
  }

  /**
   * Lưu trạng thái ván (kèm hạn giờ kế tiếp, chỗ giữ "đang trong ván"). Trạng thái đọc bằng load() chỉ được ghi khi
   * trạng thái đang lưu vẫn đúng phiên bản đã đọc; nếu nơi khác đã đổi (khoá ván bị mất giữa chừng) thì ném lỗi 'busy'
   * và KHÔNG ghi đè — người gọi không được phát sự kiện cho trạng thái chưa lưu được.
   */
  private async save(s: LiveMatchState): Promise<void> {
    const expected = this.loadedVersion.get(s);
    const playing = s.status === 'playing';
    const ok = await this.redis.client.eval(
      SAVE_STATE,
      5,
      K.state(s.id),
      K.deadlines,
      K.active,
      K.userMatch(s.players[0].userId),
      K.userMatch(s.players[1].userId),
      JSON.stringify(s),
      expected === undefined ? '' : String(expected),
      playing ? 'playing' : 'ended',
      String(playing ? this.nextDeadline(s) : 0),
      s.id,
      String(CLAIM_PLAYING_MS),
      String(ENDED_TTL_SEC),
    );
    if (Number(ok) !== 1) {
      this.engines.delete(s.id);
      this.logger.warn(`Ván ${s.id}: trạng thái đã bị nơi khác thay đổi (phiên bản ${expected}), bỏ lần lưu này`);
      throw new GameError('Ván đấu vừa thay đổi, vui lòng thử lại', 'busy');
    }
    this.loadedVersion.set(s, s.version);
  }

  /**
   * Ván đang chơi của người dùng. Tự gỡ chỗ giữ cũ khi ván không còn (đã kết thúc / mất trạng thái do tiến trình chết
   * giữa lúc tạo hoặc kết thúc ván) — không thì người đó bị báo "đang trong ván" mãi.
   */
  async activeMatchOf(userId: string): Promise<string | null> {
    const key = K.userMatch(userId);
    const id = await this.redis.client.get(key);
    if (!id || !isUuid(id)) return id ?? null;
    // Kiểm tra + gỡ nguyên tử: ván đang chơi, hoặc chưa có trạng thái mà chỗ giữ còn hạn "đang tạo" → vẫn đang trong ván
    const healed = await this.redis.client.eval(HEAL_CLAIM, 2, key, K.state(id), id, String(CLAIM_CREATING_MS));
    return Number(healed) === 1 ? null : id;
  }

  /** Mã các ván đang diễn ra (mọi instance) */
  async activeMatchIds(): Promise<string[]> {
    return this.redis.client.smembers(K.active);
  }

  colorOf(s: LiveMatchState, userId: string): Color | null {
    if (s.players[0].userId === userId) return 0;
    if (s.players[1].userId === userId) return 1;
    return null;
  }

  private engineFor(s: LiveMatchState): GameEngine {
    const c = this.engines.get(s.id);
    if (c && c.ply === s.moves.length) return c.engine;
    const engine = s.variant === 'jieqi' && s.setup ? replayJieqi(s.setup, s.moves) : replayGame(s.game, s.moves);
    this.engines.set(s.id, { ply: s.moves.length, engine });
    if (this.engines.size > 5_000) {
      const first = this.engines.keys().next().value;
      if (first) this.engines.delete(first);
    }
    return engine;
  }

  /**
   * Kiểm tra nhanh KHÔNG giữ khoá (đọc trạng thái hiện tại) để loại sớm các thao tác chắc chắn không hợp lệ —
   * spam thao tác sai không được chiếm khoá ván làm nước đi thật của đối thủ bị chờ. Kiểm tra đầy đủ vẫn chạy trong khoá.
   */
  private async precheck(matchId: string, userId: string): Promise<{ s: LiveMatchState; color: Color }> {
    const s = await this.load(matchId);
    if (!s) throw new GameError('Ván đấu không tồn tại hoặc đã kết thúc từ lâu');
    return { s, color: this.requirePlaying(s, userId) };
  }

  private withMatch<T>(id: string, fn: (s: LiveMatchState) => Promise<T>): Promise<T> {
    return this.redis.withLock(
      K.lock(id),
      async () => {
        const s = await this.load(id);
        if (!s) throw new GameError('Ván đấu không tồn tại hoặc đã kết thúc từ lâu');
        return fn(s);
      },
      { keepAliveMs: LOCK_KEEP_ALIVE_MS },
    );
  }

  // ------------------------------------------------------------------ thời gian

  private firstMoveDeadline(s: LiveMatchState): number | null {
    // Chỉ ván xếp hạng; áp dụng cho nước đầu của mỗi bên
    if (!s.ranked || s.status !== 'playing') return null;
    const turn = turnOf(s);
    return s.movesBy[turn] === 0 ? s.turnStartedAt + FIRST_MOVE_TIMEOUT_MS : null;
  }

  private nextDeadline(s: LiveMatchState): number {
    const turn = turnOf(s);
    let d = s.turnStartedAt + s.remaining[turn];
    const fm = this.firstMoveDeadline(s);
    if (fm !== null) d = Math.min(d, fm);
    for (const c of [0, 1] as const) {
      const at = s.disconnectedAt[c];
      if (at !== null) d = Math.min(d, at + RECONNECT_GRACE_MS);
    }
    return d;
  }

  /** Kết quả do hết giờ / không đi nước đầu / mất kết nối quá hạn (lấy hạn đến sớm nhất) */
  private checkTimeouts(s: LiveMatchState, now: number): GameResult | null {
    const turn = turnOf(s);
    const candidates: Array<{ at: number; result: GameResult }> = [];
    const clock = s.turnStartedAt + s.remaining[turn];
    if (now >= clock) candidates.push({ at: clock, result: { winner: otherColor(turn), reason: 'timeout' } });
    const fm = this.firstMoveDeadline(s);
    if (fm !== null && now >= fm) candidates.push({ at: fm, result: { winner: otherColor(turn), reason: 'no_first_move' } });
    for (const c of [0, 1] as const) {
      const at = s.disconnectedAt[c];
      if (at !== null && now >= at + RECONNECT_GRACE_MS) {
        candidates.push({ at: at + RECONNECT_GRACE_MS, result: { winner: otherColor(c), reason: 'disconnect' } });
      }
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => a.at - b.at);
    return candidates[0].result;
  }

  private clockDto(s: LiveMatchState): ClockDto {
    return {
      remaining: [s.remaining[0], s.remaining[1]],
      turnStartedAt: s.turnStartedAt,
      serverNow: Date.now(),
      running: s.status === 'playing',
      initialMs: s.tc.initialMs,
      incrementMs: s.tc.incrementMs,
    };
  }

  toDto(s: LiveMatchState, viewerId: string | null): MatchStateDto {
    const player = (p: LivePlayerState) => {
      const tier = p.rating !== null ? getTier(p.rating, this.cfg.tiers) : null;
      return {
        userId: p.userId,
        username: p.username,
        avatarUrl: p.avatarUrl,
        rating: p.rating,
        tier: tier?.name ?? null,
        tierLevel: tier?.level ?? null,
        ...(p.isGuest ? { isGuest: true } : {}),
      };
    };
    let warnings: MatchStateDto['warnings'] = [];
    if (s.status === 'playing') {
      try {
        warnings = this.engineFor(s).warnings();
      } catch {
        warnings = [];
      }
    }
    return {
      id: s.id,
      game: s.game,
      kind: s.kind,
      ranked: s.ranked,
      players: [player(s.players[0]), player(s.players[1])],
      myColor: viewerId ? this.colorOf(s, viewerId) : null,
      moves: s.moves.slice(),
      clock: this.clockDto(s),
      firstMoveDeadline: this.firstMoveDeadline(s),
      drawOfferBy: s.drawOfferBy,
      disconnectedUntil: [
        s.disconnectedAt[0] !== null && s.status === 'playing' ? s.disconnectedAt[0] + RECONNECT_GRACE_MS : null,
        s.disconnectedAt[1] !== null && s.status === 'playing' ? s.disconnectedAt[1] + RECONNECT_GRACE_MS : null,
      ],
      status: s.status,
      result: s.result,
      ratingChanges: s.ratingChanges,
      warnings,
      startedAt: s.startedAt,
      timeControl: s.tc,
      variant: s.variant ?? 'standard',
      ...(s.variant === 'jieqi' ? { reveals: (s.reveals ?? []).map((r) => (r ? { ...r } : null)) } : {}),
    };
  }

  // ------------------------------------------------------------------ kết nối

  /**
   * Người chơi mở bàn cờ (lần đầu hoặc vào lại sau khi mất kết nối).
   * Nếu ván đang được mở ở tab/thiết bị khác còn kết nối thì từ chối. "Còn kết nối" được hỏi thẳng socket đó (ngoài khoá
   * ván, xem SEAT_PROBE_MS): không trả lời thì socket mới nhận ghế và socket cũ bị ngắt.
   */
  async attach(matchId: string, userId: string, socketId: string): Promise<MatchStateDto> {
    try {
      return await this.attachOnce(matchId, userId, socketId, null);
    } catch (e) {
      if (!(e instanceof SeatHeldError)) throw e;
      // Socket ảo của tài khoản máy (bot~…, BotsService) không trả lời "conn:probe": giữ luật cũ, không hỏi
      const virtual = isBotSocket(e.holderSocketId) || isBotSocket(socketId);
      if (virtual || (await this.realtime.socketResponds(e.holderSocketId, SEAT_PROBE_MS))) {
        throw new GameError(SESSION_CONFLICT_MESSAGE, ERROR_CODES.SESSION_CONFLICT);
      }
      this.logger.log(`Ván ${matchId}: socket giữ ghế không trả lời — chuyển ghế sang kết nối mới`);
      const state = await this.attachOnce(matchId, userId, socketId, e.holderSocketId);
      // Ngắt kết nối treo (nếu nó còn ở đâu đó): sống lại thì nó tự kết nối lại và thấy ván đang mở ở nơi khác
      this.realtime.disconnectSocket(e.holderSocketId);
      return state;
    }
  }

  /** `staleSocketId`: socket giữ ghế đã được xác nhận không trả lời — được thay (nếu vẫn là nó giữ ghế) */
  private async attachOnce(matchId: string, userId: string, socketId: string, staleSocketId: string | null): Promise<MatchStateDto> {
    return this.withMatch(matchId, async (s) => {
      const color = this.colorOf(s, userId);
      if (color === null) throw new GameError('Bạn không phải người chơi của ván này');
      if (s.status === 'playing') {
        // Đã quá hạn (hết giờ / quá 60 giây mất kết nối) trước khi vào lại: xử lý trước, không xoá dấu mất kết nối
        const late = this.checkTimeouts(s, Date.now());
        if (late) {
          await this.end(s, late);
          return this.toDto(s, userId);
        }
        const current = s.attached[color];
        // Luật một nơi chơi: kể cả cùng trình duyệt (cùng phiên) cũng không cho tab thứ hai vào khi tab đầu còn kết nối.
        // Tab tự kết nối lại sau khi đổi mạng (socket cũ chưa hết hạn ping): attach() hỏi socket cũ, không trả lời thì
        // gọi lại với staleSocketId = socket cũ; trình duyệt cũng tự thử lại (PlayPage).
        if (
          current &&
          current.socketId !== socketId &&
          current.socketId !== staleSocketId &&
          (await this.presence.isSocketAlive(userId, current.socketId))
        ) {
          throw new SeatHeldError(current.socketId);
        }
        s.attached[color] = { socketId, instanceId: this.presence.instanceId };
        const wasDisconnected = s.disconnectedAt[color] !== null;
        s.disconnectedAt[color] = null;
        if (s.lost) s.lost[color] = null;
        // Hết giờ trong lúc mất kết nối thì xử lý ngay
        const timeout = this.checkTimeouts(s, Date.now());
        if (timeout) {
          await this.end(s, timeout);
        } else {
          s.version++;
          await this.save(s);
          if (wasDisconnected) {
            this.realtime.toMatch(s.id, 'match:connection', { matchId: s.id, color, disconnectedUntil: null });
          }
        }
      }
      return this.toDto(s, userId);
    });
  }

  /** Socket rời đi: nếu đó là socket đang chơi thì bắt đầu đếm 60 giây vào lại */
  async onSocketGone(userId: string, socketId: string): Promise<void> {
    const matchId = await this.activeMatchOf(userId);
    if (!matchId) return;
    try {
      await this.withMatch(matchId, async (s) => this.detach(s, userId, socketId));
    } catch (e) {
      this.logger.warn(`Không xử lý được mất kết nối ván ${matchId}: ${(e as Error).message}`);
    }
  }

  /**
   * Gỡ ghế của socket. `mayReturn`: gỡ vì instance giữ socket mất nhịp tim (socket có thể vẫn còn) → nhớ lại để gắn lại
   * khi socket sống lại; socket đóng thật (onSocketGone) thì không.
   */
  private async detach(s: LiveMatchState, userId: string, socketId: string, mayReturn = false): Promise<void> {
    if (s.status !== 'playing') return;
    const color = this.colorOf(s, userId);
    if (color === null) return;
    const att = s.attached[color];
    if (!att || att.socketId !== socketId) {
      // Socket đã bị gỡ trước đó (instance treo) nay đóng hẳn: thôi chờ nó quay lại
      if (!att && s.lost?.[color]?.socketId === socketId && !mayReturn) {
        s.lost[color] = null;
        s.version++;
        await this.save(s);
      }
      return;
    }
    const now = Date.now();
    s.attached[color] = null;
    s.disconnectedAt[color] = now;
    (s.lost ??= [null, null])[color] = mayReturn ? att : null;
    s.version++;
    await this.save(s);
    this.realtime.toMatch(s.id, 'match:connection', {
      matchId: s.id,
      color,
      disconnectedUntil: now + RECONNECT_GRACE_MS,
    });
  }

  /** Socket bị gỡ ghế vì instance của nó mất nhịp tim nay đã sống lại (vẫn kết nối): gắn lại, thôi đếm 60 giây */
  private async reattachLost(s: LiveMatchState, color: Color, socketId: string): Promise<void> {
    if (s.status !== 'playing' || s.attached[color] || s.disconnectedAt[color] === null) return;
    const lost = s.lost?.[color];
    if (!lost || lost.socketId !== socketId) return;
    // Đã quá hạn thì để sweep xử lý như thường
    if (this.checkTimeouts(s, Date.now())) return;
    s.attached[color] = lost;
    s.lost![color] = null;
    s.disconnectedAt[color] = null;
    s.version++;
    await this.save(s);
    this.realtime.toMatch(s.id, 'match:connection', { matchId: s.id, color, disconnectedUntil: null });
  }

  /**
   * Phát hiện socket "chết" do instance server dừng đột ngột; gắn lại socket đã bị gỡ như vậy nếu nó sống lại
   * (instance chỉ bị treo / mất kết nối Redis một lúc — socket của người chơi vẫn còn và họ vẫn đang chơi).
   */
  async checkAttachments(): Promise<void> {
    try {
      const ids = await this.redis.client.smembers(K.active);
      for (const id of ids) {
        const s = await this.load(id);
        if (!s) {
          await this.redis.client.srem(K.active, id);
          continue;
        }
        if (s.status !== 'playing') continue;
        for (const c of [0, 1] as const) {
          const uid = s.players[c].userId;
          const att = s.attached[c];
          if (att) {
            if (!(await this.presence.isSocketAlive(uid, att.socketId))) {
              await this.withMatch(id, async (fresh) => this.detach(fresh, uid, att.socketId, true)).catch(() => undefined);
            }
            continue;
          }
          const lost = s.lost?.[c];
          if (lost && s.disconnectedAt[c] !== null && (await this.presence.isSocketAlive(uid, lost.socketId))) {
            await this.withMatch(id, async (fresh) => this.reattachLost(fresh, c, lost.socketId)).catch(() => undefined);
          }
        }
      }
    } catch (e) {
      this.logger.warn(`checkAttachments: ${(e as Error).message}`);
    }
  }

  /**
   * Luật một nơi chơi cho mọi thao tác (không chỉ lúc vào bàn): thao tác phải đến từ socket đang giữ ghế. Ghế trống
   * (vd bị gỡ nhầm khi instance treo, socket vẫn còn) hoặc socket giữ ghế đã chết thì socket đang thao tác nhận ghế.
   * Trả về true nếu bên này vừa hết trạng thái mất kết nối (người gọi phát match:connection SAU khi lưu).
   * `actor` không có = thao tác nội bộ (tài khoản máy) → bỏ qua.
   */
  private async claimSeat(s: LiveMatchState, color: Color, actor: SeatActor | undefined): Promise<boolean> {
    if (!actor) return false;
    const att = s.attached[color];
    if (att && att.socketId === actor.socketId) return false;
    if (att && (await this.presence.isSocketAlive(s.players[color].userId, att.socketId))) {
      throw new GameError(SESSION_CONFLICT_MESSAGE, ERROR_CODES.SESSION_CONFLICT);
    }
    // Đã quá hạn (vd quá 60 giây mất kết nối) thì kết thúc như sweep sẽ làm, không cho nhận ghế để xoá dấu mất kết nối
    const late = this.checkTimeouts(s, Date.now());
    if (late) {
      await this.end(s, late);
      throw new GameError('Ván đấu đã kết thúc');
    }
    s.attached[color] = { socketId: actor.socketId, instanceId: this.presence.instanceId };
    if (s.lost) s.lost[color] = null;
    const wasDisconnected = s.disconnectedAt[color] !== null;
    s.disconnectedAt[color] = null;
    return wasDisconnected;
  }

  private announceReconnected(s: LiveMatchState, color: Color): void {
    this.realtime.toMatch(s.id, 'match:connection', { matchId: s.id, color, disconnectedUntil: null });
  }

  // ------------------------------------------------------------------ hành động trong ván

  private requirePlaying(s: LiveMatchState, userId: string): Color {
    const color = this.colorOf(s, userId);
    if (color === null) throw new GameError('Bạn không phải người chơi của ván này');
    if (s.status !== 'playing') throw new GameError('Ván đấu đã kết thúc');
    return color;
  }

  /**
   * Đi một nước. `expectedPly` (tuỳ chọn, dùng cho tài khoản máy): chỉ đi khi ván đang đúng ở số nước này,
   * tránh nước tính cho thế cờ cũ bị đi nhầm vào thế cờ mới. `actor`: socket gửi thao tác (xem claimSeat).
   */
  async move(
    userId: string,
    matchId: string,
    move: string,
    confirmPerpetual: boolean,
    expectedPly?: number,
    actor?: SeatActor,
  ): Promise<void> {
    if (typeof move !== 'string' || move.length > 6) throw new GameError('Nước đi không hợp lệ');
    const pre = await this.precheck(matchId, userId);
    if (turnOf(pre.s) !== pre.color) throw new GameError('Chưa tới lượt bạn');
    await this.withMatch(matchId, async (s) => {
      const color = this.requirePlaying(s, userId);
      if (turnOf(s) !== color) throw new GameError('Chưa tới lượt bạn');
      if (expectedPly !== undefined && s.moves.length !== expectedPly) throw new GameError('Thế cờ đã thay đổi');
      const now = Date.now();
      const timeout = this.checkTimeouts(s, now);
      if (timeout) {
        await this.end(s, timeout);
        throw new GameError('Ván đấu đã kết thúc');
      }
      const reconnected = await this.claimSeat(s, color, actor);
      const engine = this.engineFor(s);
      if (!engine.isLegal(move)) throw new GameError('Nước đi không hợp lệ');
      if (s.game === 'xiangqi' && !confirmPerpetual && engine.isPerpetualCheckLoss(move)) {
        throw new GameError('Nước này khiến bạn bị xử thua vì chiếu dai', ERROR_CODES.CONFIRM_PERPETUAL);
      }
      if (!engine.play(move)) throw new GameError('Nước đi không hợp lệ');
      // Lưu và gửi đi đúng dạng chuẩn của bộ luật ("E2E4", " e2e4", "h2-e2"… → "e2e4", "h2e2"), không phải chuỗi client
      // gửi: mọi nơi đọc lại ván (AI của máy, xem lại, thống kê) đều nhận cùng một dạng
      const played = engine.history().at(-1) ?? move;
      // Cờ úp: engine biết đủ tự lật quân; chỉ phần đã lật (công khai) được gửi đi
      const reveal = engine instanceof JieqiGame ? engine.lastReveal() : null;
      if (s.variant === 'jieqi') (s.reveals ??= []).push(reveal ? { ...reveal } : null);
      const elapsed = now - s.turnStartedAt;
      s.remaining[color] = s.remaining[color] - elapsed + s.tc.incrementMs;
      s.turnStartedAt = now;
      s.moves.push(played);
      s.movesBy[color]++;
      // Đi nước thay vì trả lời lời mời hoà = từ chối
      s.drawOfferBy = null;
      s.version++;
      this.engines.set(s.id, { ply: s.moves.length, engine });
      const status = engine.status();
      const event = {
        matchId: s.id,
        move: played,
        ply: s.moves.length,
        clock: this.clockDto(s),
        firstMoveDeadline: this.firstMoveDeadline(s),
        warnings: status.over ? [] : engine.warnings(),
        ...(s.variant === 'jieqi' ? { reveal } : {}),
      };
      if (status.over) {
        // Gửi nước cuối trước rồi mới gửi kết quả
        this.realtime.toMatch(s.id, 'match:move', event);
        await this.end(s, status.result);
      } else {
        try {
          await this.save(s);
        } catch (e) {
          // Không lưu được (trạng thái đã bị nơi khác đổi): engine trong bộ nhớ đã đi nước này → bỏ cache
          this.engines.delete(s.id);
          throw e;
        }
        if (reconnected) this.announceReconnected(s, color);
        this.realtime.toMatch(s.id, 'match:move', event);
      }
    });
  }

  async resign(userId: string, matchId: string, actor?: SeatActor): Promise<void> {
    await this.withMatch(matchId, async (s) => {
      const color = this.requirePlaying(s, userId);
      await this.claimSeat(s, color, actor);
      await this.end(s, { winner: otherColor(color), reason: 'resign' });
    });
  }

  async offerDraw(userId: string, matchId: string, actor?: SeatActor): Promise<void> {
    const pre = await this.precheck(matchId, userId);
    if (pre.s.drawOfferBy === pre.color) throw new GameError('Bạn đã gửi lời mời hoà, hãy chờ đối thủ trả lời');
    await this.withMatch(matchId, async (s) => {
      const color = this.requirePlaying(s, userId);
      const reconnected = await this.claimSeat(s, color, actor);
      if (s.drawOfferBy === otherColor(color)) {
        // Đối thủ đã mời hoà trước: coi như đồng ý
        await this.end(s, { winner: null, reason: 'agreement' });
        return;
      }
      if (s.drawOfferBy === color) throw new GameError('Bạn đã gửi lời mời hoà, hãy chờ đối thủ trả lời');
      s.drawOfferBy = color;
      s.version++;
      await this.save(s);
      if (reconnected) this.announceReconnected(s, color);
      this.realtime.toMatch(s.id, 'match:drawOffer', { matchId: s.id, by: color });
    });
  }

  async respondDraw(userId: string, matchId: string, accept: boolean, actor?: SeatActor): Promise<void> {
    const pre = await this.precheck(matchId, userId);
    if (pre.s.drawOfferBy !== otherColor(pre.color)) throw new GameError('Không có lời mời hoà nào');
    await this.withMatch(matchId, async (s) => {
      const color = this.requirePlaying(s, userId);
      if (s.drawOfferBy !== otherColor(color)) throw new GameError('Không có lời mời hoà nào');
      const reconnected = await this.claimSeat(s, color, actor);
      if (accept) {
        await this.end(s, { winner: null, reason: 'agreement' });
        return;
      }
      s.drawOfferBy = null;
      s.version++;
      await this.save(s);
      if (reconnected) this.announceReconnected(s, color);
      this.realtime.toMatch(s.id, 'match:drawDeclined', { matchId: s.id, by: color });
    });
  }

  // ------------------------------------------------------------------ kết thúc

  /**
   * Kết thúc ván (gọi khi đang giữ khoá ván): ghi kết quả, cập nhật điểm hạng và Top 10.
   * Kết quả trong DB (ghi đúng một lần) là kết quả cuối: nếu DB đã có kết quả từ trước thì dùng kết quả đó cho trạng
   * thái ván và sự kiện match:ended — người chơi không bao giờ thấy kết quả khác với kết quả tính điểm.
   */
  private async end(s: LiveMatchState, result: GameResult): Promise<void> {
    if (s.status !== 'playing') return;
    const now = Date.now();
    const turn = turnOf(s);
    s.remaining[turn] = result.reason === 'timeout' ? 0 : Math.max(0, s.remaining[turn] - (now - s.turnStartedAt));
    s.turnStartedAt = now;
    s.status = 'ended';
    s.result = result;
    s.endedAt = now;
    s.drawOfferBy = null;
    s.disconnectedAt = [null, null];
    s.version++;
    let outcome: RankedOutcome | null = null;
    let pending = false;
    try {
      const r = await this.persistResult(s);
      if (r.written) outcome = r.outcome;
      else if (r.stored) {
        // Ván đã được kết thúc ở nơi khác (vd lần ghi trước vào DB xong nhưng chưa kịp lưu Redis): theo kết quả trong DB
        if (!sameResult(r.stored, result)) {
          this.logger.warn(
            `Ván ${s.id}: DB đã có kết quả ${JSON.stringify(r.stored)} (khác ${JSON.stringify(result)}) — dùng kết quả trong DB`,
          );
        }
        s.result = r.stored;
      }
    } catch (e) {
      // Không nuốt lỗi: ghi nhận để sweep thử lại (updateMany endedAt:null bảo đảm không ghi / cộng điểm hai lần)
      pending = true;
      this.logger.error(`Ghi kết quả ván ${s.id} thất bại, sẽ thử lại: ${(e as Error).message}`);
      await this.redis.client.sadd(K.pendingDb, s.id).catch(() => undefined);
    }
    if (outcome) s.ratingChanges = outcome.changes;
    try {
      await this.save(s);
    } catch (e) {
      // Trạng thái đã bị nơi khác đổi: không phát kết quả chưa lưu được (DB vẫn là nguồn đúng, xem retryPendingDb)
      this.engines.delete(s.id);
      if (outcome && s.seasonId) void this.refreshLeaderboard(s.seasonId, s.game, outcome);
      throw e;
    }
    // Giữ trạng thái ván lâu hơn để còn dữ liệu mà thử ghi lại
    if (pending) await this.redis.client.expire(K.state(s.id), 86_400).catch(() => undefined);
    for (const p of s.players) await this.redis.delIfEquals(K.userMatch(p.userId), s.id);
    this.engines.delete(s.id);
    this.realtime.toMatchAndPlayers(s.id, s.players.map((p) => p.userId), 'match:ended', {
      matchId: s.id,
      result: s.result!,
      clock: this.clockDto(s),
      ratingChanges: s.ratingChanges,
    });
    // Cập nhật Top 10 SAU khi xong phần chính, không giữ khoá ván trong lúc chờ (nạp cache có thể mất vài giây)
    if (outcome && s.seasonId) void this.refreshLeaderboard(s.seasonId, s.game, outcome);
  }

  /**
   * Ghi kết quả ván + điểm hạng vào DB trong một giao dịch. `written: false` = dòng ván đã có kết quả từ trước (không ghi
   * gì, trả về kết quả đang có trong DB). Mỗi câu lệnh bị giới hạn thời gian: dòng bị khoá / DB treo thì giao dịch lỗi
   * (→ ghi lại sau) thay vì giữ khoá ván không biết bao lâu.
   */
  private async persistResult(s: LiveMatchState): Promise<PersistResult> {
    const result = s.result!;
    const stored = result.winner === null ? 'draw' : result.winner === 0 ? 'p1' : 'p2';
    return this.prisma.$transaction(async (tx): Promise<PersistResult> => {
      await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${PERSIST_STATEMENT_TIMEOUT_MS}`);
      const upd = await tx.match.updateMany({
        where: { id: s.id, endedAt: null },
        data: { result: stored, endReason: result.reason, moves: s.moves, endedAt: new Date(s.endedAt ?? Date.now()) },
      });
      if (upd.count !== 1) {
        const row = await tx.match.findUnique({ where: { id: s.id }, select: { result: true, endReason: true } });
        const winner = row?.result === 'p1' ? 0 : row?.result === 'p2' ? 1 : row?.result === 'draw' ? null : undefined;
        return {
          written: false,
          stored: winner !== undefined && row?.endReason ? { winner, reason: row.endReason as EndReason } : null,
        };
      }
      if (!s.ranked || !s.seasonId) return { written: true, outcome: null };
      const score1: EloScore = result.winner === null ? 0.5 : result.winner === 0 ? 1 : 0;
      const r = await this.ratings.applyRankedResult(tx, s.seasonId, s.players[0].userId, s.players[1].userId, score1);
      await tx.match.update({ where: { id: s.id }, data: { ratingChange: r.delta, ratingChange2: r.delta2 } });
      return { written: true, outcome: r };
    });
  }

  private async refreshLeaderboard(seasonId: string, game: GameType, outcome: RankedOutcome): Promise<void> {
    try {
      const ids = outcome.rows.map((r) => r.userId);
      // Thời điểm đọc tên / trạng thái khoá: bản đọc sau (vd admin vừa khoá) không bị bản này ghi đè
      const readAt = Date.now();
      const users = await this.prisma.user.findMany({
        where: { id: { in: ids } },
        select: { id: true, isBanned: true, username: true, avatarUrl: true },
      });
      await this.leaderboard.upsert(
        seasonId,
        outcome.rows.map((row) => {
          const u = users.find((x) => x.id === row.userId);
          return {
            userId: row.userId,
            username: u?.username ?? '',
            avatarUrl: u?.avatarUrl ?? null,
            rating: row.rating,
            wins: row.wins,
            gamesPlayed: row.gamesPlayed,
            ratingUpdatedAt: row.ratingUpdatedAt,
            isBanned: u?.isBanned ?? false,
            readAt,
          };
        }),
      );
      this.realtime.broadcast('leaderboard:changed', { game });
    } catch (e) {
      this.logger.warn(`Cập nhật Top 10 sau ván thất bại: ${(e as Error).message}`);
    }
  }

  /**
   * Thử ghi lại kết quả các ván đã kết thúc mà lần ghi DB trước bị lỗi. Nếu DB đã có kết quả (vd lần ghi trước thực ra
   * đã xong) mà khác kết quả đang lưu ở Redis thì chỉnh trạng thái ván theo DB và phát lại match:ended.
   */
  private async retryPendingDb(): Promise<void> {
    const ids = await this.redis.client.srandmember(K.pendingDb, 20);
    for (const id of ids) {
      const token = await this.redis.tryLock(K.lock(id), 10_000);
      if (!token) continue;
      const stop = this.redis.keepLock(K.lock(id), token, 10_000, LOCK_KEEP_ALIVE_MS);
      let outcome: RankedOutcome | null = null;
      let s: LiveMatchState | null = null;
      try {
        s = await this.load(id);
        if (!s || s.status !== 'ended' || !s.result) {
          await this.redis.client.srem(K.pendingDb, id);
          this.logger.error(`Ván ${id}: không còn trạng thái để ghi lại kết quả vào DB`);
          continue;
        }
        const r = await this.persistResult(s);
        await this.redis.client.srem(K.pendingDb, id);
        if (r.written) {
          outcome = r.outcome;
          if (outcome) {
            s.ratingChanges = outcome.changes;
            s.version++;
            await this.save(s);
          }
          this.logger.log(`Đã ghi lại kết quả ván ${id} vào DB`);
        } else if (r.stored && !sameResult(r.stored, s.result)) {
          this.logger.warn(
            `Ván ${id}: DB đã có kết quả ${JSON.stringify(r.stored)}, khác kết quả đã báo ${JSON.stringify(s.result)} — chỉnh theo DB`,
          );
          s.result = r.stored;
          s.ratingChanges = null;
          s.version++;
          await this.save(s);
          this.realtime.toMatchAndPlayers(s.id, s.players.map((p) => p.userId), 'match:ended', {
            matchId: s.id,
            result: s.result,
            clock: this.clockDto(s),
            ratingChanges: null,
          });
        } else {
          this.logger.log(`Ván ${id}: DB đã có đúng kết quả từ trước, không cần ghi lại`);
        }
      } catch (e) {
        this.logger.warn(`Ghi lại kết quả ván ${id} vẫn lỗi: ${(e as Error).message}`);
      } finally {
        stop();
        await this.redis.unlock(K.lock(id), token);
      }
      if (outcome && s?.seasonId) await this.refreshLeaderboard(s.seasonId, s.game, outcome);
    }
  }

  /** Quét hạn giờ (mọi instance cùng chạy; khoá ván đảm bảo chỉ một nơi xử lý) */
  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const ids = await this.redis.client.zrangebyscore(K.deadlines, '-inf', Date.now(), 'LIMIT', 0, 50);
      for (const id of ids) {
        const token = await this.redis.tryLock(K.lock(id), 10_000);
        if (!token) continue;
        const stop = this.redis.keepLock(K.lock(id), token, 10_000, LOCK_KEEP_ALIVE_MS);
        try {
          const s = await this.load(id);
          if (!s || s.status !== 'playing') {
            await this.redis.client.zrem(K.deadlines, id);
            continue;
          }
          const res = this.checkTimeouts(s, Date.now());
          if (res) await this.end(s, res);
          else await this.redis.client.zadd(K.deadlines, this.nextDeadline(s), id);
        } catch (e) {
          this.logger.error(`sweep ${id}: ${(e as Error).message}`);
        } finally {
          stop();
          await this.redis.unlock(K.lock(id), token);
        }
      }
      if (Date.now() - this.lastPendingRetry >= PENDING_DB_RETRY_MS) {
        this.lastPendingRetry = Date.now();
        await this.retryPendingDb();
      }
    } catch (e) {
      this.logger.warn(`sweep: ${(e as Error).message}`);
    } finally {
      this.sweeping = false;
    }
  }

  private lastPendingRetry = 0;
}
