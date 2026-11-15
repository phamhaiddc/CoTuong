import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import type { Request } from 'express';
import type { AdminDayStatDto, AdminStatsDto } from '@cotuong/shared';
import { AppConfig } from '../config';
import { SessionService } from '../auth/session.service';
import { ipBucket, ipNetBucket } from '../common/net';
import { PresenceService } from '../common/presence.service';
import { PrismaService } from '../common/prisma.service';
import { RedisService } from '../common/redis.service';

const DAY_MS = 86_400_000;
const VN_OFFSET_MS = 7 * 3_600_000;
/** Ngày YYYY-MM-DD theo giờ Việt Nam (GMT+7, không có giờ mùa hè) */
export const vnDate = (ms: number): string => new Date(ms + VN_OFFSET_MS).toISOString().slice(0, 10);
/** Thời điểm 00:00 (giờ Việt Nam) của ngày chứa `ms` */
export const vnDayStart = (ms: number): number => Date.parse(`${vnDate(ms)}T00:00:00+07:00`);

/** Bộ đếm theo ngày trong Redis giữ 40 ngày (đủ cho số liệu 30 ngày); lâu hơn thì đọc bảng site_daily_stats */
const KEEP_SEC = 40 * 86_400;
/** "Đang xem web": trình duyệt có gửi tín hiệu trong 5 phút gần nhất */
const LIVE_WINDOW_MS = 5 * 60_000;
/** Mỗi IP (IPv6 gộp /64) tối đa 120 lượt ghi nhận / phút — vượt thì bỏ qua (làm chậm việc thổi phồng số liệu) */
const VISITS_PER_IP_MINUTE = 120;
/**
 * Mỗi IP (IPv6 gộp /64) tối đa 10 NGƯỜI XEM MỚI / phút, mỗi dải IPv6 /48 tối đa 30 (người xem mới = mã trình duyệt
 * chưa có trong "đang xem web" — kể cả người quay lại sau hơn 5 phút). Vượt thì vẫn đếm lượt xem nhưng không thêm người
 * xem / "đang xem web" — làm chậm việc mỗi lần gửi một mã mới để thổi phồng số người xem (người có nhiều IP / nhiều dải
 * IPv6 vẫn thổi phồng được — số liệu chỉ để tham khảo). Không dùng giới hạn theo ngày: nhà mạng di động dùng chung một
 * IPv4 cho rất nhiều người.
 */
const NEW_VISITORS_PER_IP_MINUTE = 10;
const NEW_VISITORS_PER_NET_MINUTE = 30;
const VID_RE = /^[A-Za-z0-9_-]{16,64}$/;
/** Không đếm bot / công cụ tự động (trình duyệt headless, crawler, thư viện HTTP) */
const BOT_UA = /bot|crawl|spider|slurp|headless|lighthouse|preview|facebookexternalhit|curl|wget|python|axios|node-fetch|go-http/i;
/** Tên điện thoại thật có chứa chữ "bot" (vd CUBOT) — bỏ ra trước khi dò bot để không bỏ sót người xem thật */
const REAL_DEVICE_UA = /cubot/gi;

export function isBotUserAgent(ua: string): boolean {
  return BOT_UA.test(ua.replace(REAL_DEVICE_UA, ''));
}

const K = {
  pv: (d: string) => `an:pv:${d}`,
  uv: (d: string) => `an:uv:${d}`,
  mu: (d: string) => `an:mu:${d}`,
  pages: (d: string) => `an:pages:${d}`,
  live: 'an:live',
  seen: (d: string, sid: string) => `an:seen:${d}:${sid}`,
  newVisitors: (ip: string) => `rl:visit-new:${ip}`,
  newVisitorsNet: (net: string) => `rl:visit-new-net:${net}`,
};

/**
 * Ghi một lượt xem (nguyên tử).
 * KEYS: pv, pages, uv, live, bộ đếm người xem mới của IP, (IPv6) bộ đếm người xem mới của dải /48
 * ARGV: vid, trang, now (ms), hạn bộ đếm ngày (giây), mốc bỏ "đang xem" (ms), số người xem mới tối đa của IP, cửa sổ
 * (giây), số người xem mới tối đa của dải /48
 * Trả về 1 nếu mã trình duyệt được đếm vào người xem / đang xem, 0 nếu bị bỏ do vượt giới hạn người xem mới.
 * Mỗi mã chưa có trong "đang xem web" đều tính một lượt người xem mới (kể cả khi PFADD không đổi HyperLogLog) — giới hạn
 * đúng như đã ghi, không bị lọt qua theo xác suất.
 */
const VISIT_SCRIPT = `
redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], ARGV[4])
redis.call('HINCRBY', KEYS[2], ARGV[2], 1)
redis.call('EXPIRE', KEYS[2], ARGV[4])
local function under(k, cap) return tonumber(redis.call('GET', k) or '0') < tonumber(cap) end
local function count(k)
  local n = redis.call('INCR', k)
  if n == 1 or redis.call('TTL', k) < 0 then redis.call('EXPIRE', k, ARGV[7]) end
end
local counted = 0
if redis.call('ZSCORE', KEYS[4], ARGV[1]) then
  -- Đang xem web (đã được đếm): luôn ghi tiếp (kể cả sang ngày mới)
  redis.call('PFADD', KEYS[3], ARGV[1])
  redis.call('ZADD', KEYS[4], ARGV[3], ARGV[1])
  counted = 1
elseif under(KEYS[5], ARGV[6]) and (#KEYS < 6 or under(KEYS[6], ARGV[8])) then
  count(KEYS[5])
  if #KEYS >= 6 then count(KEYS[6]) end
  redis.call('PFADD', KEYS[3], ARGV[1])
  redis.call('ZADD', KEYS[4], ARGV[3], ARGV[1])
  counted = 1
end
redis.call('EXPIRE', KEYS[3], ARGV[4])
redis.call('ZREMRANGEBYSCORE', KEYS[4], 0, ARGV[5])
redis.call('EXPIRE', KEYS[4], 600)
return counted
`;

/** Trang tĩnh được ghi đúng tên; trang có mã (ván, phòng, người…) gộp theo mẫu để không lưu mã và giữ ít khoá */
const STATIC_PATHS = new Set([
  '/',
  '/login',
  '/register',
  '/verify-email',
  '/forgot-password',
  '/reset-password',
  '/seasons',
  '/co-up',
  '/co-the',
  '/ai',
  '/admin',
]);
const DYNAMIC_PATHS: ReadonlyArray<[RegExp, string]> = [
  [/^\/play\/[^/]+$/, '/play/:id'],
  [/^\/room\/[^/]+$/, '/room/:code'],
  [/^\/profile\/[^/]+$/, '/profile/:id'],
  [/^\/replay\/[^/]+$/, '/replay/:id'],
  [/^\/co-the\/[^/]+$/, '/co-the/:id'],
];
const OTHER_PATH = '(khác)';

export function normalizePath(raw: unknown): string {
  if (typeof raw !== 'string') return OTHER_PATH;
  let p = raw.split(/[?#]/)[0].slice(0, 200);
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  if (STATIC_PATHS.has(p)) return p;
  for (const [re, name] of DYNAMIC_PATHS) if (re.test(p)) return name;
  return OTHER_PATH;
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

/**
 * Đếm truy cập web cho bảng theo dõi của admin.
 * - Trình duyệt gửi POST /api/analytics/visit mỗi lần mở trang (kèm mã ngẫu nhiên lưu ở localStorage, không gắn danh
 *   tính). Server KHÔNG lưu IP, chỉ cộng bộ đếm: lượt xem (INCR), người xem (HyperLogLog, sai số ~1%), thành viên hoạt
 *   động (HyperLogLog theo id tài khoản, mỗi phiên chỉ tra DB một lần / ngày), trang xem nhiều (Hash theo mẫu đường dẫn).
 * - Mỗi 10 phút chép số của hôm nay + hôm qua vào bảng site_daily_stats (giữ lâu dài; Redis chỉ giữ 40 ngày).
 */
@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger('Analytics');

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly sessions: SessionService,
    private readonly presence: PresenceService,
    private readonly cfg: AppConfig,
  ) {}

  /** Ghi nhận một lần xem trang. Dữ liệu sai / bot / quá giới hạn thì lặng lẽ bỏ qua (không báo lỗi cho trình duyệt) */
  async recordVisit(req: Request, body: unknown): Promise<void> {
    const b = (body ?? {}) as Record<string, unknown>;
    const vid = typeof b.vid === 'string' && VID_RE.test(b.vid) ? b.vid : null;
    if (!vid) return;
    const ua = req.headers['user-agent'] ?? '';
    if (!ua || isBotUserAgent(ua)) return;
    const ip = ipBucket(req.ip ?? '');
    const net = ipNetBucket(req.ip ?? '');
    if ((await this.redis.hit(`rl:visit:${ip}`, 60)) > VISITS_PER_IP_MINUTE) return;
    const now = Date.now();
    const d = vnDate(now);
    // IPv4: dải "mạng" chính là địa chỉ đó → chỉ một bộ đếm người xem mới
    const keys = [K.pv(d), K.pages(d), K.uv(d), K.live, K.newVisitors(ip), ...(net !== ip ? [K.newVisitorsNet(net)] : [])];
    await this.redis.client.eval(
      VISIT_SCRIPT,
      keys.length,
      ...keys,
      vid,
      normalizePath(b.path),
      String(now),
      String(KEEP_SEC),
      String(now - LIVE_WINDOW_MS),
      String(NEW_VISITORS_PER_IP_MINUTE),
      '60',
      String(NEW_VISITORS_PER_NET_MINUTE),
    );
    // Thành viên hoạt động trong ngày: mỗi phiên đăng nhập chỉ tra cơ sở dữ liệu một lần / ngày
    const cookies = (req as Request & { cookies?: Record<string, string> }).cookies;
    const s = await this.sessions.verify(cookies?.[this.cfg.cookieName]);
    if (!s) return;
    if ((await this.redis.client.set(K.seen(d, s.sid), '1', 'EX', 2 * 86_400, 'NX')) !== 'OK') return;
    const u = await this.prisma.user.findUnique({ where: { id: s.userId }, select: { isGuest: true, isBot: true } });
    if (u && !u.isGuest && !u.isBot) await this.redis.client.multi().pfadd(K.mu(d), s.userId).expire(K.mu(d), KEEP_SEC).exec();
  }

  @Interval(10 * 60_000)
  async tick(): Promise<void> {
    try {
      await this.persist();
    } catch (e) {
      this.logger.warn(`Lưu số liệu truy cập thất bại: ${(e as Error).message}`);
    }
  }

  /** Chép số liệu hôm nay + hôm qua từ Redis vào site_daily_stats (giữ số lớn hơn — Redis lỡ mất dữ liệu thì không ghi đè) */
  async persist(now = Date.now()): Promise<void> {
    const token = await this.redis.tryLock('lock:analytics-persist', 120_000);
    if (!token) return;
    try {
      for (const date of [vnDate(now), vnDate(now - DAY_MS)]) {
        const live = await this.redisDay(date);
        if (!live) continue;
        const old = await this.prisma.siteDailyStat.findUnique({ where: { date } });
        const data = {
          pageViews: Math.max(live.pageViews, old?.pageViews ?? 0),
          visitors: Math.max(live.visitors, old?.visitors ?? 0),
          members: Math.max(live.members, old?.members ?? 0),
        };
        await this.prisma.siteDailyStat.upsert({ where: { date }, create: { date, ...data }, update: data });
      }
    } finally {
      await this.redis.unlock('lock:analytics-persist', token);
    }
  }

  /** Số của một ngày từ Redis; null nếu Redis không có (ngày cũ hơn 40 ngày / mất dữ liệu) */
  private async redisDay(date: string): Promise<{ pageViews: number; visitors: number; members: number } | null> {
    const [pv, uv, mu] = await Promise.all([
      this.redis.client.get(K.pv(date)),
      this.redis.client.pfcount(K.uv(date)),
      this.redis.client.pfcount(K.mu(date)),
    ]);
    if (pv === null && uv === 0) return null;
    return { pageViews: num(pv), visitors: num(uv), members: num(mu) };
  }

  /** Tổng hợp cho GET /api/admin/stats */
  async stats(now = Date.now()): Promise<AdminStatsDto> {
    const today = vnDate(now);
    const todayStart = vnDayStart(now);
    const dates = Array.from({ length: 30 }, (_, i) => vnDate(now - (29 - i) * DAY_MS));
    const firstDayStart = new Date(vnDayStart(now - 29 * DAY_MS));
    const memberWhere = { isBot: false, isGuest: false };
    const since = (ms: number) => ({ ...memberWhere, createdAt: { gte: new Date(ms) } });

    const [members, verified, banned, admins, viaGoogle, viaFacebook, newToday, new7d, new30d, guests, bots] = await Promise.all([
      this.prisma.user.count({ where: memberWhere }),
      this.prisma.user.count({ where: { ...memberWhere, emailVerifiedAt: { not: null } } }),
      this.prisma.user.count({ where: { ...memberWhere, isBanned: true } }),
      this.prisma.user.count({ where: { ...memberWhere, role: 'admin' } }),
      this.prisma.oAuthAccount.count({ where: { provider: 'google', user: memberWhere } }),
      this.prisma.oAuthAccount.count({ where: { provider: 'facebook', user: memberWhere } }),
      this.prisma.user.count({ where: since(todayStart) }),
      this.prisma.user.count({ where: since(vnDayStart(now - 6 * DAY_MS)) }),
      this.prisma.user.count({ where: since(vnDayStart(now - 29 * DAY_MS)) }),
      this.prisma.user.count({ where: { isGuest: true } }),
      this.prisma.user.count({ where: { isBot: true } }),
    ]);

    const [newByDay, matchesByDay, stored] = await Promise.all([
      this.prisma.$queryRaw<Array<{ d: string; n: number }>>`
        SELECT to_char(created_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD') AS d, count(*)::int AS n
        FROM users WHERE is_bot = false AND is_guest = false AND created_at >= ${firstDayStart}
        GROUP BY 1`,
      this.prisma.$queryRaw<Array<{ d: string; n: number }>>`
        SELECT to_char(started_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD') AS d, count(*)::int AS n
        FROM matches WHERE started_at >= ${firstDayStart}
        GROUP BY 1`,
      this.prisma.siteDailyStat.findMany({ where: { date: { gte: dates[0] } } }),
    ]);
    const newMap = new Map(newByDay.map((r) => [r.d, Number(r.n)]));
    const matchMap = new Map(matchesByDay.map((r) => [r.d, Number(r.n)]));
    const storedMap = new Map(stored.map((r) => [r.date, r]));

    const days: AdminDayStatDto[] = [];
    for (const date of dates) {
      const live = await this.redisDay(date);
      const db = storedMap.get(date);
      days.push({
        date,
        pageViews: Math.max(live?.pageViews ?? 0, db?.pageViews ?? 0),
        visitors: Math.max(live?.visitors ?? 0, db?.visitors ?? 0),
        members: Math.max(live?.members ?? 0, db?.members ?? 0),
        newAccounts: newMap.get(date) ?? 0,
        matches: matchMap.get(date) ?? 0,
      });
    }

    /**
     * Lượt xem cộng theo ngày; người xem / thành viên đếm KHÔNG trùng qua nhiều ngày (gộp HyperLogLog).
     * Không bao giờ ít hơn ngày đông nhất trong khoảng: Redis lỡ mất dữ liệu (bộ đếm gộp về 0) thì vẫn còn số từng ngày
     * đã chép vào site_daily_stats.
     */
    const span = async (n: number) => {
      const last = dates.slice(-n);
      const lastDays = days.slice(-n);
      const pageViews = lastDays.reduce((s, d) => s + d.pageViews, 0);
      const [uv, mu] = await Promise.all([
        this.redis.client.pfcount(...last.map(K.uv)),
        this.redis.client.pfcount(...last.map(K.mu)),
      ]);
      return {
        pageViews,
        visitors: Math.max(num(uv), ...lastDays.map((d) => d.visitors)),
        members: Math.max(num(mu), ...lastDays.map((d) => d.members)),
      };
    };
    const t = days[days.length - 1];

    const [ranked, ai, unranked, live, total, connected, visitorsNow, pages] = await Promise.all([
      this.prisma.match.count({ where: { startedAt: { gte: new Date(todayStart) }, ranked: true } }),
      this.prisma.match.count({ where: { startedAt: { gte: new Date(todayStart) }, mode: 'ai' } }),
      this.prisma.match.count({ where: { startedAt: { gte: new Date(todayStart) }, mode: 'pvp', ranked: false } }),
      // Ván người với người chưa kết thúc, bắt đầu trong 12 giờ gần đây (bỏ qua ván treo do sự cố cũ).
      // Không tính ván xếp hạng ghép với tài khoản máy (cùng mode "pvp" trong DB)
      this.prisma.match.count({
        where: {
          mode: 'pvp',
          endedAt: null,
          startedAt: { gte: new Date(now - 12 * 3_600_000) },
          player1: { isBot: false },
          player2: { isBot: false },
        },
      }),
      this.prisma.match.count(),
      this.presence.onlineHumans(),
      this.redis.client.zcount(K.live, now - LIVE_WINDOW_MS, '+inf'),
      this.redis.client.hgetall(K.pages(today)),
    ]);

    return {
      generatedAt: new Date(now).toISOString(),
      accounts: {
        members,
        verified,
        banned,
        admins,
        viaGoogle,
        viaFacebook,
        newToday,
        new7d,
        new30d,
        guests,
        bots,
        // Khách được dọn sau (hạn phiên + 1 ngày) — cùng mốc với GuestCleanupService
        guestTtlDays: Math.round((this.cfg.sessionTtlSec / 86_400 + 1) * 100) / 100,
      },
      online: { connected, visitorsNow: num(visitorsNow) },
      traffic: {
        today: { pageViews: t.pageViews, visitors: t.visitors, members: t.members },
        last7d: await span(7),
        last30d: await span(30),
      },
      matches: { today: { ranked, unranked, ai }, live, total },
      days,
      topPages: Object.entries(pages)
        .map(([path, v]) => ({ path, views: num(v) }))
        .sort((a, b) => b.views - a.views)
        .slice(0, 10),
    };
  }
}
