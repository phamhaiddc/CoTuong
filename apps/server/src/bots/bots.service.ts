import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { cpus } from 'os';
import { join } from 'path';
import { findBestMove } from '@cotuong/ai';
import { otherColor, replayGame, type Color, type GameEngine, type GameType } from '@cotuong/game-core';
import { AI_LEVELS, ERROR_CODES, FIRST_MOVE_TIMEOUT_MS, START_RATING, type AiLevel } from '@cotuong/shared';
import { AppConfig } from '../config';
import { GameError } from '../common/errors';
import { PresenceService } from '../common/presence.service';
import { PrismaService } from '../common/prisma.service';
import { RedisService } from '../common/redis.service';
import { LiveMatchService, type LiveMatchState, type LivePlayerState } from '../game/live-match.service';
import { RatingsService } from '../seasons/ratings.service';
import { botGameOfEmail } from './bot-accounts';
import { BotAiPool } from './bot-ai.pool';

interface BotInfo {
  id: string;
  username: string;
  avatarUrl: string | null;
  level: AiLevel;
  /** Game duy nhất máy này được ghép (theo BOT_ROSTER); null = không có trong danh sách → không ghép */
  game: GameType | null;
  isBanned: boolean;
}

const K = {
  /** Các ván đang diễn ra có tài khoản máy */
  matches: 'bot:m',
  /** Instance đang tính nước cho máy ở nước thứ `ply` của ván (giá trị = instanceId) */
  think: (matchId: string, ply: number) => `bot:think:${matchId}:${ply}`,
  /** Instance đang trả lời lời mời hoà (theo version của trạng thái ván) */
  draw: (matchId: string, version: number) => `bot:draw:${matchId}:${version}`,
};

const SCAN_MS = 1_000;
const REFRESH_MS = 60_000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);

/**
 * Tài khoản máy chơi (users.is_bot): được ghép với người chơi chờ lâu ở hàng chờ xếp hạng (xem MatchmakingService)
 * và tự đi nước ở phía server.
 *
 * - Tính nước bằng @cotuong/ai trong luồng phụ (worker_threads), không chặn vòng lặp sự kiện; luồng lỗi/treo thì
 *   đi nước dự phòng (tìm nông độ sâu 2 ngay tại chỗ, cuối cùng là một nước hợp lệ ngẫu nhiên) chứ không đứng im.
 * - Đi nước qua đúng LiveMatchService.move như người chơi (khoá ván + kiểm tra số nước để không đi nhầm thế cũ).
 * - Thời gian mỗi nước ngẫu nhiên khoảng 1,5–8 giây (nhanh hơn khi sắp hết giờ); nước đầu luôn trong hạn 30 giây.
 * - Luôn "đang kết nối": gắn một socket ảo (ghi presence trên instance này) để không bị xử thua vì mất kết nối.
 * - Từ chối mọi lời mời hoà, không mời hoà, không chat, không đầu hàng.
 *
 * Nhiều instance: mọi instance cùng quét tập `bot:m` mỗi giây; khoá `bot:think:<ván>:<nước>` (NX + TTL) bảo đảm chỉ
 * một nơi tính một nước; instance giữ khoá chết (hết nhịp tim) thì nơi khác lấy lại ngay. Khởi động lại server:
 * trạng thái ván nằm ở Redis nên chỉ cần dựng lại tập `bot:m` từ các ván đang diễn ra rồi điều khiển tiếp.
 */
@Injectable()
export class BotsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Bots');
  private bots = new Map<string, BotInfo>();
  private loadedAt = 0;
  private readonly busy = new Set<string>();
  private scanTimer: NodeJS.Timeout | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private adoptTimer: NodeJS.Timeout | null = null;
  private scanning = false;
  private closed = false;
  private pool: BotAiPool | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly live: LiveMatchService,
    private readonly ratings: RatingsService,
    private readonly presence: PresenceService,
    private readonly cfg: AppConfig,
  ) {}

  onModuleInit(): void {
    this.pool = new BotAiPool(Math.max(1, Math.min(4, cpus().length - 1)), join(__dirname, 'bot-ai.worker.js'), this.logger);
    void this.resume();
    this.scanTimer = setInterval(() => void this.scan(), SCAN_MS);
    this.refreshTimer = setInterval(() => void this.refresh().catch(() => undefined), REFRESH_MS);
    // Lưới an toàn: ván có máy mà vì lỗi nào đó không nằm trong tập bot:m (vd SADD lỗi lúc ghép) thì máy sẽ không bao
    // giờ đi → định kỳ dò lại từ danh sách ván đang diễn ra
    this.adoptTimer = setInterval(() => void this.adoptMissing().catch(() => undefined), 15_000);
  }

  async onModuleDestroy(): Promise<void> {
    this.closed = true;
    if (this.scanTimer) clearInterval(this.scanTimer);
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.adoptTimer) clearInterval(this.adoptTimer);
    await this.pool?.close();
  }

  // ------------------------------------------------------------------ danh sách tài khoản máy

  async refresh(): Promise<void> {
    const rows = await this.prisma.user.findMany({
      where: { isBot: true },
      select: { id: true, email: true, username: true, avatarUrl: true, botLevel: true, isBanned: true },
    });
    const next = new Map<string, BotInfo>();
    for (const r of rows) {
      const level: AiLevel = (AI_LEVELS as readonly string[]).includes(r.botLevel ?? '') ? (r.botLevel as AiLevel) : 'medium';
      next.set(r.id, { id: r.id, username: r.username, avatarUrl: r.avatarUrl, level, game: botGameOfEmail(r.email), isBanned: r.isBanned });
    }
    this.bots = next;
    this.loadedAt = Date.now();
  }

  private async fresh(maxAgeMs: number): Promise<void> {
    if (Date.now() - this.loadedAt > maxAgeMs) await this.refresh();
  }

  /**
   * Chọn một tài khoản máy đang rảnh (không ở ván nào, không bị khoá) cho người chơi có điểm `rating` ở mùa `seasonId`:
   * ưu tiên điểm mùa này gần nhất, bằng nhau thì chọn ngẫu nhiên. Trả về null nếu không có máy rảnh.
   */
  async pickOpponent(game: GameType, seasonId: string, rating: number, exclude: ReadonlySet<string>): Promise<LivePlayerState | null> {
    await this.fresh(30_000);
    const idle: BotInfo[] = [];
    for (const b of this.bots.values()) {
      // Mỗi máy chỉ chơi đúng một game (7 máy cờ tướng, 7 máy cờ vua)
      if (b.isBanned || b.game !== game || exclude.has(b.id)) continue;
      if (!(await this.live.activeMatchOf(b.id))) idle.push(b);
    }
    if (!idle.length) return null;
    const rows = await this.prisma.rating.findMany({
      where: { seasonId, userId: { in: idle.map((b) => b.id) } },
      select: { userId: true, rating: true },
    });
    const ratingOf = new Map(rows.map((r) => [r.userId, r.rating]));
    const dist = (b: BotInfo) => Math.abs((ratingOf.get(b.id) ?? START_RATING) - rating);
    // Xáo trộn trước rồi sắp xếp ổn định theo độ chênh: bằng nhau thì thứ tự ngẫu nhiên
    const order = idle
      .map((b) => ({ b, k: Math.random() }))
      .sort((x, y) => x.k - y.k)
      .map((x) => x.b)
      .sort((x, y) => dist(x) - dist(y));
    const bot = order[0];
    const r = await this.ratings.getOrCreate(bot.id, seasonId);
    return { userId: bot.id, username: bot.username, avatarUrl: bot.avatarUrl, rating: r.rating };
  }

  /** Ván vừa tạo có tài khoản máy: bắt đầu điều khiển ngay (gắn kết nối, đi nước nếu tới lượt) */
  async adopt(s: LiveMatchState): Promise<void> {
    await this.redis.client.sadd(K.matches, s.id);
    void this.handle(s.id);
  }

  // ------------------------------------------------------------------ vòng điều khiển

  /** Thêm vào tập bot:m các ván đang diễn ra có tài khoản máy mà chưa có trong tập */
  private async adoptMissing(): Promise<void> {
    if (this.closed || !this.bots.size) return;
    for (const id of await this.live.activeMatchIds()) {
      if ((await this.redis.client.sismember(K.matches, id)) === 1) continue;
      const s = await this.live.load(id);
      if (s && s.status === 'playing' && s.players.some((p) => this.bots.has(p.userId))) {
        await this.redis.client.sadd(K.matches, id);
        this.logger.warn(`Ván ${id} có máy nhưng chưa được điều khiển — nhận lại`);
      }
    }
  }

  /** Khởi động: tiếp tục điều khiển các ván đang diễn ra có tài khoản máy (trạng thái nằm ở Redis) */
  private async resume(): Promise<void> {
    try {
      await this.refresh();
      // Dọn socket ảo của các instance đã chết
      for (const b of this.bots.values()) {
        const fields = await this.redis.client.hgetall(`pres:${b.id}`);
        for (const [sid, inst] of Object.entries(fields)) {
          if (sid.startsWith('bot~') && !(await this.presence.isInstanceAlive(inst))) await this.presence.remove(b.id, sid);
        }
      }
      let n = 0;
      for (const id of await this.live.activeMatchIds()) {
        const s = await this.live.load(id);
        if (s && s.status === 'playing' && s.players.some((p) => this.bots.has(p.userId))) {
          await this.redis.client.sadd(K.matches, id);
          n++;
        }
      }
      if (n) this.logger.log(`Tiếp tục điều khiển ${n} ván có tài khoản máy`);
    } catch (e) {
      this.logger.warn(`resume: ${(e as Error).message}`);
    }
  }

  private async scan(): Promise<void> {
    if (this.scanning || this.closed) return;
    this.scanning = true;
    try {
      const ids = await this.redis.client.smembers(K.matches);
      for (const id of ids) if (!this.busy.has(id)) void this.handle(id);
    } catch (e) {
      this.logger.warn(`scan: ${(e as Error).message}`);
    } finally {
      this.scanning = false;
    }
  }

  private async handle(id: string): Promise<void> {
    if (this.busy.has(id) || this.closed) return;
    this.busy.add(id);
    try {
      const s = await this.live.load(id);
      if (!s || s.status !== 'playing') {
        await this.redis.client.srem(K.matches, id);
        return;
      }
      let botColors = ([0, 1] as const).filter((c) => this.bots.has(s.players[c].userId));
      if (!botColors.length) {
        await this.fresh(5_000);
        botColors = ([0, 1] as const).filter((c) => this.bots.has(s.players[c].userId));
        if (!botColors.length) {
          await this.redis.client.srem(K.matches, id);
          return;
        }
      }
      for (const c of botColors) await this.ensureAttached(s, c);
      const turn = (s.moves.length % 2) as Color;
      // Lời mời hoà gửi tới máy khi chưa tới lượt máy: từ chối sau vài giây.
      // (Tới lượt máy thì từ chối ngay trước khi đi nước — mời hoà liên tục cũng không làm máy đứng đồng hồ.)
      const offerTo = s.drawOfferBy !== null ? otherColor(s.drawOfferBy) : null;
      if (offerTo !== null && offerTo !== turn && botColors.includes(offerTo)) {
        await this.declineDraw(s, offerTo);
        return;
      }
      if (!botColors.includes(turn)) return;
      if ((s.variant ?? 'standard') !== 'standard') return; // máy chỉ chơi cờ thường (xếp hạng)
      await this.playTurn(s, turn);
    } catch (e) {
      this.logger.warn(`Điều khiển ván ${id}: ${(e as Error).message}`);
    } finally {
      this.busy.delete(id);
    }
  }

  /** Máy luôn "đang kết nối": gắn socket ảo do instance này giữ (instance chết thì instance khác gắn lại) */
  private async ensureAttached(s: LiveMatchState, c: Color): Promise<void> {
    const botId = s.players[c].userId;
    const att = s.attached[c];
    if (att && (await this.presence.isSocketAlive(botId, att.socketId))) return;
    const sid = `bot~${this.cfg.instanceId}`;
    await this.presence.add(botId, sid);
    try {
      await this.live.attach(s.id, botId, sid);
    } catch (e) {
      if (!(e instanceof GameError && e.code === ERROR_CODES.SESSION_CONFLICT)) {
        this.logger.warn(`Gắn kết nối máy vào ván ${s.id}: ${(e as Error).message}`);
      }
    }
  }

  /** Giữ quyền xử lý một việc (NX + TTL); instance đang giữ đã chết thì lấy lại */
  private async claim(key: string, ttlMs: number): Promise<boolean> {
    const me = this.cfg.instanceId;
    const ttl = Math.max(1_000, Math.round(ttlMs));
    if ((await this.redis.client.set(key, me, 'PX', ttl, 'NX')) === 'OK') return true;
    const holder = await this.redis.client.get(key);
    if (!holder || holder === me || (await this.presence.isInstanceAlive(holder))) return false;
    if (!(await this.redis.delIfEquals(key, holder))) return false;
    return (await this.redis.client.set(key, me, 'PX', ttl, 'NX')) === 'OK';
  }

  private async declineDraw(s: LiveMatchState, color: Color): Promise<void> {
    await sleep(rand(1_500, 3_500));
    if (this.closed) return;
    const key = K.draw(s.id, s.version);
    if (!(await this.claim(key, 30_000))) return;
    try {
      await this.live.respondDraw(s.players[color].userId, s.id, false);
    } catch (e) {
      // Lời mời đã hết hiệu lực (đối thủ đã đi nước khác, ván đã kết thúc...)
      if (!(e instanceof GameError)) throw e;
    }
  }

  // ------------------------------------------------------------------ đi nước

  /** Tổng thời gian (ms, tính từ lúc tới lượt) máy dùng cho nước này: ngẫu nhiên như người, nhanh hơn khi ít giờ */
  private planDelay(s: LiveMatchState, color: Color, level: AiLevel): number {
    const rem = s.remaining[color];
    const mine = s.movesBy[color];
    let lo = 2_000;
    let hi = 8_000;
    if (mine === 0) {
      lo = 1_500;
      hi = 4_000;
    } else if (mine < 5) {
      lo = 1_500;
      hi = 4_500;
    } else if (level === 'hard') {
      lo = 3_000; // mức Khó tìm tới ~3 giây
    } else if (level === 'easy') {
      hi = 6_000;
    }
    if (rem < 120_000) hi = Math.min(hi, 4_000);
    if (rem < 45_000) {
      lo = Math.min(lo, 800);
      hi = Math.min(hi, 2_000);
    }
    if (rem < 15_000) {
      lo = 300;
      hi = 800;
    }
    lo = Math.min(lo, hi);
    const r = Math.random();
    let d = lo + (hi - lo) * r * r; // nghiêng về phía nhanh
    d = Math.min(d, Math.max(0, rem - 3_000));
    if (s.ranked && mine === 0) d = Math.min(d, FIRST_MOVE_TIMEOUT_MS - 15_000);
    return Math.round(d);
  }

  private async playTurn(s: LiveMatchState, color: Color): Promise<void> {
    const bot = this.bots.get(s.players[color].userId);
    if (!bot) return;
    const ply = s.moves.length;
    const now = Date.now();
    // Hạn đi nước (tuyệt đối): theo kế hoạch, nhưng không sát giờ của máy
    const clockEnd = s.turnStartedAt + s.remaining[color];
    const due = Math.min(Math.max(now, s.turnStartedAt + this.planDelay(s, color, bot.level)), Math.max(now, clockEnd - 2_000));
    // Mức Khó dùng tới 3 giây; mọi mức đều bị giới hạn bởi thời gian còn tới hạn
    const budget = Math.round(Math.max(300, Math.min(bot.level === 'hard' ? 3_000 : 2_000, due - now - 250, (clockEnd - now) / 4)));
    const key = K.think(s.id, ply);
    if (!(await this.claim(key, due - now + budget + 10_000))) return;
    try {
      let move: string | null = null;
      try {
        const res = await this.pool!.search({ game: s.game, moves: s.moves, level: bot.level, config: { timeMs: budget, rootNoiseCp: bot.level === 'hard' ? 10 : 20 } }, budget + 4_000);
        move = res.move;
      } catch (e) {
        this.logger.warn(`Tính nước máy (ván ${s.id}) lỗi, dùng nước dự phòng: ${(e as Error).message}`);
      }
      const wait = due - Date.now();
      if (wait > 0) await sleep(wait);
      if (this.closed) return;
      await this.play(s, bot.id, ply, move);
    } finally {
      await this.redis.delIfEquals(key, this.cfg.instanceId).catch(() => undefined);
    }
  }

  /**
   * Nước dự phòng khi luồng AI hỏng: tìm nông ngay trên luồng chính (độ sâu 2; hạn 250 ms tính cả phần dựng lại ván và
   * lọc nước chiếu dai — ván 1.200 nửa nước đo được ~50 ms), cuối cùng là nước hợp lệ ngẫu nhiên.
   */
  private fallbackMove(game: GameType, moves: string[], engine: GameEngine): string | null {
    try {
      const r = findBestMove({ game, moves, config: { maxDepth: 2, timeMs: 250, quiescence: true, randomness: 0 } });
      if (r.move && engine.isLegal(r.move)) return r.move;
    } catch {
      /* dùng nước ngẫu nhiên bên dưới */
    }
    const legal = engine.legalMoves();
    const safe = game === 'xiangqi' ? legal.filter((m) => !engine.isPerpetualCheckLoss(m)) : legal;
    const list = safe.length ? safe : legal;
    return list.length ? list[Math.floor(Math.random() * list.length)] : null;
  }

  private async play(s: LiveMatchState, botId: string, ply: number, suggested: string | null): Promise<void> {
    const engine = replayGame(s.game, s.moves);
    if (engine.status().over) return;
    const move = suggested && engine.isLegal(suggested) ? suggested : this.fallbackMove(s.game, s.moves, engine);
    if (!move) return;
    // Đối thủ đang mời hoà: từ chối rõ ràng rồi mới đi (như người bấm "Từ chối")
    const cur = await this.live.load(s.id);
    if (cur && cur.status === 'playing' && cur.drawOfferBy !== null && cur.players[otherColor(cur.drawOfferBy)].userId === botId) {
      await this.live.respondDraw(botId, s.id, false).catch((err: Error) => {
        if (!(err instanceof GameError)) throw err;
      });
    }
    try {
      await this.live.move(botId, s.id, move, false, ply);
    } catch (e) {
      if (!(e instanceof GameError)) throw e;
      if (e.code === ERROR_CODES.CONFIRM_PERPETUAL) {
        // Mọi nước khác đều thua vì chiếu dai thì đành đi (AI đã tránh nếu còn nước khác)
        const alt = engine.legalMoves().filter((m) => m !== move && !engine.isPerpetualCheckLoss(m));
        const pick = alt.length ? alt[Math.floor(Math.random() * alt.length)] : move;
        await this.live.move(botId, s.id, pick, !alt.length, ply).catch((err: Error) => {
          if (!(err instanceof GameError)) throw err;
        });
        return;
      }
      // Ván đã kết thúc / thế cờ đã đổi / hệ thống bận: lần quét sau sẽ xử lý lại nếu cần
      if (e.code === 'busy') this.logger.warn(`Đi nước máy (ván ${s.id}) gặp khoá bận, sẽ thử lại`);
    }
  }
}
