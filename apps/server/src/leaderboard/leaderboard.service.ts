import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { GameType } from '@cotuong/game-core';
import {
  LEADERBOARD_MIN_GAMES,
  LEADERBOARD_SIZE,
  START_RATING,
  compareStandings,
  getTier,
  type LeaderboardEntry,
  type LeaderboardResponse,
  type MyStanding,
  type SeasonArchiveDto,
} from '@cotuong/shared';
import { AppConfig } from '../config';
import { GameError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { RedisService } from '../common/redis.service';
import { SeasonsService } from '../seasons/seasons.service';

/** Dữ liệu một người chơi trong cache (gọn để tiết kiệm bộ nhớ) */
interface CachedStanding {
  u: string; // username
  a: string | null; // avatar
  r: number; // rating
  w: number; // wins
  g: number; // gamesPlayed
  t: number; // ratingUpdatedAt (ms)
  b: 0 | 1; // bị khoá
  v?: number; // thời điểm đọc dữ liệu từ DB (ms) — bản đọc sau thắng khi cùng số ván
}

export interface StandingRow {
  userId: string;
  username: string;
  avatarUrl: string | null;
  rating: number;
  wins: number;
  gamesPlayed: number;
  ratingUpdatedAt: Date;
  isBanned: boolean;
  /** Thời điểm đọc dòng này từ DB (ms); mặc định = lúc ghi */
  readAt?: number;
}

const K = {
  // "lb2": đổi tiền tố khi đổi thang điểm (0 thay cho 1200) để cache cũ trong Redis không còn được dùng
  zset: (seasonId: string) => `lb2:${seasonId}:z`,
  hash: (seasonId: string) => `lb2:${seasonId}:h`,
  ready: (seasonId: string) => `lb2:${seasonId}:ready`,
  /** Dòng ghi tới lúc cache chưa sẵn sàng (đang nạp lại) — áp vào cache ngay khi nạp xong */
  pending: (seasonId: string) => `lb2:${seasonId}:p`,
  /** Tăng mỗi lần đánh dấu nạp lại: lần nạp bắt đầu trước đó không được đánh dấu "sẵn sàng" */
  gen: (seasonId: string) => `lb2:${seasonId}:gen`,
  /** Khoá tạm của một lần nạp (đổi tên thành khoá thật khi xong) */
  tmpZset: (seasonId: string, token: string) => `lb2:${seasonId}:z:${token}`,
  tmpHash: (seasonId: string, token: string) => `lb2:${seasonId}:h:${token}`,
  lock: (seasonId: string) => `lock:lb:${seasonId}`,
  archive: (game: GameType) => `lb2:archive:${game}`,
};
const CACHE_TTL_SEC = 100 * 86_400;
/**
 * Giá trị của khoá "ready": gắn với số ván tối thiểu để vào Top 10 — đổi LEADERBOARD_MIN_GAMES (hoặc cache có dạng cũ
 * "1") thì cache tự được nạp lại thay vì giữ danh sách tính theo mức cũ.
 */
const READY_TAG = `min${LEADERBOARD_MIN_GAMES}`;
/** Mỗi lần đọc DB khi nạp cache (đọc từng trang để không giữ cả mùa trong bộ nhớ một lúc) */
const LOAD_PAGE = 5_000;
/** Hạn khoá nạp cache; được gia hạn sau mỗi trang nên lần nạp dài không bị một tiến trình khác chạy chồng */
const LOAD_LOCK_MS = 60_000;
/** Khoá tạm tự hết hạn nếu tiến trình nạp bị dừng giữa chừng */
const TMP_TTL_SEC = 3_600;
/** Cache chưa có gì và tiến trình khác đang nạp: chờ tối đa chừng này rồi báo bận */
const COLD_WAIT_MS = 15_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Một dòng khi nạp cache: chỉ các cột cần, đọc bằng một câu JOIN (findMany kèm quan hệ chậm hơn nhiều lần ở mùa lớn) */
interface LoadRow {
  user_id: string;
  rating: number;
  wins: number;
  games_played: number;
  rating_updated_at: Date;
  username: string;
  avatar_url: string | null;
  is_banned: boolean;
}

/**
 * Hàm Lua dùng chung: ghi một dòng vào (hash, zset) nếu không cũ hơn bản đang lưu.
 * Bỏ bản mới khi: ít ván hơn, hoặc cùng số ván nhưng đọc từ DB sớm hơn (vd trạng thái khoá đọc trước khi admin khoá).
 * Có trong Top 10 (zset) khi đủ số ván tối thiểu và không bị khoá.
 */
const LUA_APPLY = `
local function apply(hkey, zkey, id, raw, minGames)
  local okNew, row = pcall(cjson.decode, raw)
  if not okNew or type(row) ~= 'table' then return 0 end
  local ng, nv = tonumber(row.g) or 0, tonumber(row.v) or 0
  local cur = redis.call('HGET', hkey, id)
  if cur then
    local ok, obj = pcall(cjson.decode, cur)
    if ok and type(obj) == 'table' and obj.g then
      local g = tonumber(obj.g)
      if g > ng or (g == ng and obj.v and tonumber(obj.v) > nv) then return 0 end
    end
  end
  redis.call('HSET', hkey, id, raw)
  if zkey then
    if ng >= minGames and tonumber(row.b) ~= 1 then redis.call('ZADD', zkey, row.r, id) else redis.call('ZREM', zkey, id) end
  end
  return 1
end
`;

/**
 * Cập nhật một người chơi. Cache sẵn sàng → ghi thẳng; đang nạp lại / chưa nạp → ghi vào hàng chờ (áp khi nạp xong),
 * không bao giờ phải chờ lần nạp.
 * KEYS: hash, zset, ready, pending · ARGV: userId, bản mã hoá, số ván tối thiểu, READY_TAG, hạn (giây)
 */
const UPSERT_SCRIPT = `${LUA_APPLY}
if redis.call('GET', KEYS[3]) == ARGV[4] then
  return apply(KEYS[1], KEYS[2], ARGV[1], ARGV[2], tonumber(ARGV[3]))
end
local n = apply(KEYS[4], false, ARGV[1], ARGV[2], 0)
redis.call('EXPIRE', KEYS[4], ARGV[5])
return n
`;

/**
 * Kết thúc một lần nạp (nguyên tử): còn giữ khoá và không ai đánh dấu nạp lại trong lúc nạp → đổi khoá tạm thành khoá
 * thật, áp các dòng trong hàng chờ, đánh dấu sẵn sàng. Ngược lại bỏ khoá tạm (lần đọc sau sẽ nạp lại).
 * KEYS: lock, tmpHash, tmpZset, hash, zset, pending, ready, gen · ARGV: token, gen lúc bắt đầu, số ván tối thiểu, READY_TAG, hạn
 */
const SWAP_SCRIPT = `${LUA_APPLY}
local gen = redis.call('GET', KEYS[8]) or '0'
if redis.call('GET', KEYS[1]) ~= ARGV[1] or gen ~= ARGV[2] then
  redis.call('DEL', KEYS[2], KEYS[3])
  return 0
end
if redis.call('EXISTS', KEYS[2]) == 1 then redis.call('RENAME', KEYS[2], KEYS[4]) else redis.call('DEL', KEYS[4]) end
if redis.call('EXISTS', KEYS[3]) == 1 then redis.call('RENAME', KEYS[3], KEYS[5]) else redis.call('DEL', KEYS[5]) end
local p = redis.call('HGETALL', KEYS[6])
for i = 1, #p, 2 do apply(KEYS[4], KEYS[5], p[i], p[i + 1], tonumber(ARGV[3])) end
redis.call('DEL', KEYS[6])
redis.call('EXPIRE', KEYS[4], ARGV[5])
redis.call('EXPIRE', KEYS[5], ARGV[5])
redis.call('SET', KEYS[7], ARGV[4], 'EX', ARGV[5])
return 1
`;

/** Gia hạn khoá nếu vẫn đang giữ. KEYS: lock · ARGV: token, ms */
const EXTEND_SCRIPT = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) else return 0 end`;

const toStanding = (c: CachedStanding) => ({ rating: c.r, wins: c.w, gamesPlayed: c.g, ratingUpdatedAt: c.t });
const isEligible = (c: { g: number; b: 0 | 1 }) => c.g >= LEADERBOARD_MIN_GAMES && !c.b;

/**
 * Bảng xếp hạng lấy từ cache Redis (Sorted Set theo điểm + Hash thông tin), không truy vấn DB mỗi lần tải trang.
 * Chỉ người chơi đủ LEADERBOARD_MIN_GAMES (5) ván xếp hạng trong quý mới nằm trong Sorted Set.
 * Nạp lại cache (lần đầu / sau khi trừ điểm do không chơi / Redis mất dữ liệu) ghi vào khoá tạm rồi đổi tên một lần:
 * trong lúc nạp, người xem vẫn thấy bản cũ (nếu có) và kết quả ván mới được giữ trong hàng chờ, không phải chờ khoá.
 */
@Injectable()
export class LeaderboardService {
  private readonly logger = new Logger('Leaderboard');

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly seasons: SeasonsService,
    private readonly cfg: AppConfig,
  ) {}

  private encode(row: StandingRow): string {
    const c: CachedStanding = {
      u: row.username,
      a: row.avatarUrl,
      r: row.rating,
      w: row.wins,
      g: row.gamesPlayed,
      t: row.ratingUpdatedAt.getTime(),
      b: row.isBanned ? 1 : 0,
      v: row.readAt ?? Date.now(),
    };
    return JSON.stringify(c);
  }

  private async isReady(seasonId: string): Promise<boolean> {
    return (await this.redis.client.get(K.ready(seasonId))) === READY_TAG;
  }

  /**
   * Bảo đảm cache dùng được.
   * - Sẵn sàng: trả về ngay.
   * - Chưa sẵn sàng nhưng còn bản cũ (vừa bị đánh dấu nạp lại): dùng bản cũ, nạp lại chạy nền.
   * - Chưa có gì: tự nạp (hoặc chờ tiến trình đang nạp, tối đa COLD_WAIT_MS rồi báo bận).
   */
  async ensureLoaded(seasonId: string): Promise<void> {
    if (await this.isReady(seasonId)) return;
    const hasOld = (await this.redis.client.exists(K.hash(seasonId))) === 1;
    const token = await this.redis.tryLock(K.lock(seasonId), LOAD_LOCK_MS);
    if (token) {
      const run = this.loadLocked(seasonId, token);
      if (hasOld) {
        run.catch((e: Error) => this.logger.warn(`Nạp lại cache bảng xếp hạng mùa ${seasonId} thất bại: ${e.message}`));
        return;
      }
      await run;
      // Lần nạp bị bỏ (dữ liệu vừa đổi trong lúc nạp) và chưa có bản nào để dùng: báo bận để người dùng thử lại
      if (!(await this.isReady(seasonId)) && (await this.redis.client.exists(K.hash(seasonId))) === 0) {
        throw new GameError('Hệ thống đang bận, vui lòng thử lại', 'busy');
      }
      return;
    }
    if (hasOld) return;
    const deadline = Date.now() + COLD_WAIT_MS;
    while (Date.now() < deadline) {
      await sleep(100);
      if (await this.isReady(seasonId)) return;
    }
    throw new GameError('Hệ thống đang bận, vui lòng thử lại', 'busy');
  }

  /** Nạp cache từ DB khi đã giữ khoá (nhả khoá khi xong) */
  private async loadLocked(seasonId: string, token: string): Promise<void> {
    const tmpH = K.tmpHash(seasonId, token);
    const tmpZ = K.tmpZset(seasonId, token);
    try {
      if (await this.isReady(seasonId)) return;
      const gen = (await this.redis.client.get(K.gen(seasonId))) ?? '0';
      // Thời điểm đọc lấy TRƯỚC khi đọc DB: thay đổi ghi sau mốc này (vd admin khoá tài khoản) luôn thắng bản nạp
      const readAt = Date.now();
      let cursor: string | null = null;
      let total = 0;
      for (;;) {
        // Đọc từng trang theo user_id (khoá chính ratings bắt đầu bằng user_id)
        const after: Prisma.Sql = cursor ? Prisma.sql`AND r.user_id > ${cursor}::uuid` : Prisma.empty;
        const rows: LoadRow[] = await this.prisma.$queryRaw<LoadRow[]>`
          SELECT r.user_id::text AS user_id, r.rating, r.wins, r.games_played, r.rating_updated_at,
                 u.username, u.avatar_url, u.is_banned
          FROM ratings r JOIN users u ON u.id = r.user_id
          WHERE r.season_id = ${seasonId}::uuid ${after}
          ORDER BY r.user_id
          LIMIT ${LOAD_PAGE}`;
        if (rows.length) {
          // Mỗi trang chỉ 2 lệnh ghi (HSET / ZADD nhiều cặp) thay vì 2 lệnh cho mỗi người chơi
          const fields: string[] = [];
          const members: Array<string | number> = [];
          for (const r of rows) {
            const row: StandingRow = {
              userId: r.user_id,
              username: r.username,
              avatarUrl: r.avatar_url,
              rating: r.rating,
              wins: r.wins,
              gamesPlayed: r.games_played,
              ratingUpdatedAt: r.rating_updated_at,
              isBanned: r.is_banned,
              readAt,
            };
            fields.push(r.user_id, this.encode(row));
            if (isEligible({ g: row.gamesPlayed, b: row.isBanned ? 1 : 0 })) members.push(r.rating, r.user_id);
          }
          const multi = this.redis.client.multi().hset(tmpH, ...fields);
          if (members.length) multi.zadd(tmpZ, ...members);
          await multi.expire(tmpH, TMP_TTL_SEC).expire(tmpZ, TMP_TTL_SEC).exec();
          total += rows.length;
          cursor = rows[rows.length - 1].user_id;
        }
        if (rows.length < LOAD_PAGE) break;
        if (Number(await this.redis.client.eval(EXTEND_SCRIPT, 1, K.lock(seasonId), token, String(LOAD_LOCK_MS))) !== 1) {
          throw new Error('mất khoá trong lúc nạp');
        }
      }
      const ok = await this.redis.client.eval(
        SWAP_SCRIPT,
        8,
        K.lock(seasonId),
        tmpH,
        tmpZ,
        K.hash(seasonId),
        K.zset(seasonId),
        K.pending(seasonId),
        K.ready(seasonId),
        K.gen(seasonId),
        token,
        gen,
        String(LEADERBOARD_MIN_GAMES),
        READY_TAG,
        String(CACHE_TTL_SEC),
      );
      if (Number(ok) === 1) this.logger.log(`Đã nạp cache bảng xếp hạng mùa ${seasonId} (${total} người chơi)`);
      else this.logger.log(`Bỏ lần nạp cache mùa ${seasonId}: dữ liệu vừa đổi trong lúc nạp, sẽ nạp lại ở lần xem sau`);
    } catch (e) {
      await this.redis.client.del(tmpH, tmpZ).catch(() => undefined);
      throw e;
    } finally {
      await this.redis.unlock(K.lock(seasonId), token).catch(() => undefined);
    }
  }

  /**
   * Cập nhật cache sau ván xếp hạng / khi đổi tên, avatar, trạng thái khoá. Không chờ lần nạp cache đang chạy (nếu có):
   * khi đó dòng được giữ trong hàng chờ và áp vào ngay lúc nạp xong.
   * Ghi có điều kiện (Lua, nguyên tử): bỏ qua dòng có số ván ít hơn bản đang lưu — tránh ghi đè số liệu mới bằng bản
   * đọc cũ (vd refreshUser đọc DB trước khi một ván kết thúc nhưng ghi sau).
   */
  async upsert(seasonId: string, rows: StandingRow[]): Promise<void> {
    const now = Date.now();
    for (const r of rows) {
      const row: StandingRow = { ...r, readAt: r.readAt ?? now };
      await this.redis.client.eval(
        UPSERT_SCRIPT,
        4,
        K.hash(seasonId),
        K.zset(seasonId),
        K.ready(seasonId),
        K.pending(seasonId),
        row.userId,
        this.encode(row),
        String(LEADERBOARD_MIN_GAMES),
        READY_TAG,
        String(CACHE_TTL_SEC),
      );
    }
  }

  /** Làm mới tên/avatar/trạng thái khoá của người chơi trong cache các mùa đang mở */
  async refreshUser(userId: string): Promise<void> {
    const readAt = Date.now();
    const rows = await this.prisma.rating.findMany({
      where: { userId, season: { status: { in: ['active', 'finalizing'] } } },
      include: { user: { select: { username: true, avatarUrl: true, isBanned: true } } },
    });
    for (const r of rows) {
      await this.upsert(r.seasonId, [
        {
          userId,
          username: r.user.username,
          avatarUrl: r.user.avatarUrl,
          rating: r.rating,
          wins: r.wins,
          gamesPlayed: r.gamesPlayed,
          ratingUpdatedAt: r.ratingUpdatedAt,
          isBanned: r.user.isBanned,
          readAt,
        },
      ]);
    }
  }

  /**
   * Đánh dấu cần nạp lại (vd sau khi trừ điểm do không chơi). Bản cũ vẫn được dùng cho tới khi bản mới nạp xong;
   * lần nạp nào đang chạy (đọc DB trước thay đổi) sẽ không được đánh dấu "sẵn sàng".
   */
  async invalidate(seasonId: string): Promise<void> {
    await this.redis.client
      .multi()
      .incr(K.gen(seasonId))
      .expire(K.gen(seasonId), CACHE_TTL_SEC)
      .del(K.ready(seasonId))
      .exec();
  }

  /** Xoá hẳn cache của một mùa (mùa đã chốt — không còn ai xem bảng đang diễn ra) */
  async drop(seasonId: string): Promise<void> {
    await this.invalidate(seasonId);
    await this.redis.client.del(K.zset(seasonId), K.hash(seasonId), K.pending(seasonId));
  }

  async invalidateArchive(game: GameType): Promise<void> {
    await this.redis.client.del(K.archive(game));
  }

  private entry(rank: number, userId: string, c: CachedStanding): LeaderboardEntry {
    const tier = getTier(c.r, this.cfg.tiers);
    return {
      rank,
      userId,
      username: c.u,
      avatarUrl: c.a,
      rating: c.r,
      tier: tier.name,
      tierLevel: tier.level,
      wins: c.w,
      gamesPlayed: c.g,
    };
  }

  /** Top N, đã áp dụng quy tắc xếp khi bằng điểm */
  async top(seasonId: string, n = LEADERBOARD_SIZE): Promise<LeaderboardEntry[]> {
    await this.ensureLoaded(seasonId);
    const z = K.zset(seasonId);
    const nth = await this.redis.client.zrevrange(z, n - 1, n - 1, 'WITHSCORES');
    // Lấy mọi người có điểm >= điểm của người thứ N (để xử lý bằng điểm ở biên)
    const ids =
      nth.length === 2
        ? await this.redis.client.zrangebyscore(z, nth[1], '+inf')
        : await this.redis.client.zrange(z, 0, -1);
    if (!ids.length) return [];
    const raw = await this.redis.client.hmget(K.hash(seasonId), ...ids);
    const list = ids
      .map((id, i) => ({ id, c: raw[i] ? (JSON.parse(raw[i]!) as CachedStanding) : null }))
      // Lọc lại theo điều kiện hiện tại (phòng khi đang dùng bản cũ trong lúc nạp lại)
      .filter((x): x is { id: string; c: CachedStanding } => x.c !== null && isEligible(x.c));
    list.sort((a, b) => compareStandings(toStanding(a.c), toStanding(b.c)));
    return list.slice(0, n).map((x, i) => this.entry(i + 1, x.id, x.c));
  }

  /** Thứ hạng của một người (null nếu chưa đủ số ván) */
  async standingOf(seasonId: string, userId: string): Promise<MyStanding | null> {
    await this.ensureLoaded(seasonId);
    const raw = await this.redis.client.hget(K.hash(seasonId), userId);
    const base = (c: CachedStanding | null, rank: number | null): MyStanding => {
      const rating = c?.r ?? START_RATING;
      const tier = getTier(rating, this.cfg.tiers);
      return {
        rank,
        rating,
        tier: tier.name,
        tierLevel: tier.level,
        wins: c?.w ?? 0,
        gamesPlayed: c?.g ?? 0,
        minGames: LEADERBOARD_MIN_GAMES,
      };
    };
    if (!raw) return base(null, null);
    const c = JSON.parse(raw) as CachedStanding;
    if (!isEligible(c)) return base(c, null);
    const z = K.zset(seasonId);
    const higher = await this.redis.client.zcount(z, `(${c.r}`, '+inf');
    const tiedIds = (await this.redis.client.zrangebyscore(z, c.r, c.r)).filter((id) => id !== userId);
    let better = 0;
    if (tiedIds.length) {
      const tied = await this.redis.client.hmget(K.hash(seasonId), ...tiedIds);
      for (const t of tied) {
        if (t && compareStandings(toStanding(JSON.parse(t) as CachedStanding), toStanding(c)) < 0) better++;
      }
    }
    return base(c, higher + better + 1);
  }

  async response(game: GameType, userId: string | null): Promise<LeaderboardResponse> {
    const season = await this.seasons.current(game);
    const [entries, me] = await Promise.all([
      this.top(season.id),
      userId ? this.standingOf(season.id, userId) : Promise.resolve(null),
    ]);
    return { season: this.seasons.toDto(season), entries, me };
  }

  /** Top 10 đã chốt của các quý trước (cache 1 giờ, xoá khi chốt mùa mới) */
  async archive(game: GameType): Promise<SeasonArchiveDto[]> {
    const cached = await this.redis.getJson<SeasonArchiveDto[]>(K.archive(game));
    if (cached) return cached;
    const seasons = await this.prisma.season.findMany({
      where: { game, status: 'closed' },
      orderBy: [{ year: 'desc' }, { quarter: 'desc' }],
      take: 20,
      include: {
        results: { orderBy: { rank: 'asc' }, include: { user: { select: { username: true, avatarUrl: true } } } },
        ratings: { where: { finalRank: { not: null, lte: LEADERBOARD_SIZE } } },
      },
    });
    const out: SeasonArchiveDto[] = seasons.map((s) => ({
      season: this.seasons.toDto(s),
      entries: s.results.map((r) => {
        const st = s.ratings.find((x) => x.userId === r.userId);
        const tier = getTier(r.rating, this.cfg.tiers);
        return {
          rank: r.rank,
          userId: r.userId,
          username: r.user.username,
          avatarUrl: r.user.avatarUrl,
          rating: r.rating,
          tier: tier.name,
          tierLevel: tier.level,
          wins: st?.wins ?? 0,
          gamesPlayed: st?.gamesPlayed ?? 0,
        };
      }),
    }));
    await this.redis.client.set(K.archive(game), JSON.stringify(out), 'EX', 3600);
    return out;
  }
}
