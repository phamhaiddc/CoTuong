import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'crypto';
import type { User } from '@prisma/client';
import {
  mailboxKey,
  normalizeEmail,
  normalizeUsername,
  usernameKey,
  validateEmail,
  validatePassword,
  validateUsername,
  type MeDto,
  type OAuthProvider,
  type RegisterStartResponse,
  type RegisterVerifyResponse,
} from '@cotuong/shared';
import { AppConfig } from '../config';
import { GameError } from '../common/errors';
import { MailService, type MailResult } from '../common/mail.service';
import { PresenceService } from '../common/presence.service';
import { PrismaService } from '../common/prisma.service';
import { RealtimeService } from '../common/realtime.service';
import { RedisService } from '../common/redis.service';
import { LiveMatchService } from '../game/live-match.service';
import { GUEST_EMAIL_DOMAIN, isReservedBotEmail } from '../bots/bot-accounts';
import { ipBucket, ipNetBucket } from '../common/net';
import { TokenBucketLimiter } from '../common/rate-limiter';
import { SessionService } from './session.service';
import { passwordBusyError, passwords } from './password.service';
import type { AuthUser, EmailVerifiedVia } from './auth.types';

const VERIFY_TTL_SEC = 24 * 3600;
const RESET_TTL_SEC = 3600;

const tooMany = (msg: string) => new HttpException(msg, HttpStatus.TOO_MANY_REQUESTS);
/** Số thư liên kết xác thực tối đa mỗi ngày tới một địa chỉ (mã đăng ký có giới hạn riêng — xem REG_*) */
const MAIL_PER_DAY = 10;
/**
 * Thư đặt lại mật khẩu (chỉ đếm thư THẬT SỰ gửi đi; yêu cầu bị từ chối không tính): mỗi (địa chỉ, IP) 5 thư / ngày; mỗi
 * địa chỉ 4 thư / giờ; mỗi IP (IPv6 gộp /64) 5 thư / giờ — chỉ còn 1 thư / giờ khi phần thư đặt lại mật khẩu của trang
 * đã dùng quá nửa (MailService.isBusy) — và 15 thư / ngày; mỗi dải IPv6 /48 10 thư / giờ (lúc bận 2) và 30 thư / ngày.
 * Thư ĐẦU TIÊN trong 24 giờ tới một địa chỉ được dùng cả phần trần còn trống của loại thư khác (MailService, `overflow`):
 * ai đó dùng vài địa chỉ đã đăng ký xin thư liên tục để làm hết phần thư đặt lại mật khẩu của trang thì người khác vẫn
 * nhận được thư của mình (trừ khi cả trần chung của trang cũng đã đầy). Yêu cầu "Quên mật khẩu": mỗi IP 20 lần / giờ,
 * mỗi dải IPv6 /48 60 lần / giờ.
 */
const RESET_MAIL_PER_IP_DAY = 5;
const RESET_MAIL_PER_HOUR = 4;
const RESET_SEND_PER_IP_HOUR = 5;
const RESET_SEND_PER_IP_HOUR_BUSY = 1;
const RESET_SEND_PER_IP_DAY = 15;
const RESET_SEND_PER_NET_HOUR = 10;
const RESET_SEND_PER_NET_HOUR_BUSY = 2;
const RESET_SEND_PER_NET_DAY = 30;
const FORGOT_PER_IP_HOUR = 20;
const FORGOT_PER_NET_HOUR = 60;
/**
 * Đăng nhập SAI (cửa sổ 15 phút): mỗi IP (IPv6 gộp /64) 50 lần, mỗi dải IPv6 /48 150 lần, mỗi email 10 lần. Trình
 * duyệt quen của email đó (đã từng đăng nhập / đặt lại mật khẩu thành công với ĐÚNG mật khẩu hiện tại —
 * SessionService.isKnownDevice) không bị khoá theo email mà có giới hạn riêng 10 lần cho mỗi (email, IP): người lạ cố
 * tình nhập sai để khoá email không khoá được chủ tài khoản.
 */
const LOGIN_WINDOW_SEC = 900;
const LOGIN_PER_IP = 50;
const LOGIN_PER_NET = 150;
const LOGIN_PER_EMAIL = 10;
const LOGIN_PER_KNOWN_DEVICE = 10;
/**
 * Số lần kiểm tra mật khẩu đăng nhập ĐANG CHẠY cùng lúc, mỗi instance: quá thì trả 503 "bận" ngay (không tính vào giới
 * hạn). Trình duyệt lạ: 4 cho mỗi IP (IPv6: cả dải /48). Trình duyệt quen (hàng ưu tiên): riêng 4 cho mỗi IP / dải /48
 * và 2 cho mỗi email. Một IP gửi dồn hàng loạt yêu cầu không chiếm hết hàng chờ băm mật khẩu (PasswordService).
 */
const LOGIN_INFLIGHT_PER_NET = 4;
const KNOWN_INFLIGHT_PER_EMAIL = 2;
/**
 * Quyền "trình duyệt quen" (hàng ưu tiên, giới hạn riêng) mỗi IP / dải /48 dùng được 10 lần liền rồi 1 lần / 30 giây (~30 lần / 15 phút; dồn tối
 * đa 10 lần, mỗi instance). Quá thì yêu cầu được xét như trình duyệt lạ (vẫn đăng nhập được): ai đó dùng vài tài khoản
 * của mình gửi dồn đăng nhập ĐÚNG mật khẩu không chiếm mãi được hàng ưu tiên của mọi người.
 */
const KNOWN_PRIVILEGE_RULE = { capacity: 10, perSecond: 1 / 30 };
/**
 * Băm "không dùng được" (đúng định dạng, cùng số vòng) — so sánh khi email không tồn tại để thời gian như nhau.
 * Không tốn CPU để tạo (trước đây băm thật lúc khởi động).
 */
const DUMMY_HASH = passwords.unusableHash();

/* ---- Đăng ký 3 bước (email → mã 6 số → tên + mật khẩu) ---- */
/** Mã xác thực có hiệu lực 10 phút; phiếu (ticket) sau khi nhập đúng mã có hiệu lực 15 phút */
const REG_CODE_TTL_SEC = 600;
const REG_TICKET_TTL_SEC = 900;
/** Số lần nhập sai tối đa cho một mã (hết lượt thì phải gửi mã mới) */
const REG_CODE_MAX_ATTEMPTS = 5;
/** Chờ giữa hai lần gửi mã tới cùng một hộp thư từ cùng một IP */
const REG_RESEND_COOLDOWN_SEC = 60;
/** Mỗi IP: 60 lần gọi register/start / giờ (tính cả yêu cầu bị từ chối 409 / 429); 60 lần nhập mã / giờ */
const REG_START_PER_IP_HOUR = 60;
const REG_VERIFY_PER_IP_HOUR = 60;
/**
 * Thư mã thật sự gửi đi: mỗi IP (IPv6 gộp /64) 10 thư / giờ và 30 thư / 24 giờ; mỗi dải IPv6 /48 20 thư / giờ. Khi phần
 * thư mã đăng ký của trang đã dùng quá nửa (MailService.isBusy — vd có người xin mã hàng loạt): mỗi IP chỉ còn 3 thư /
 * giờ, mỗi /48 6 thư / giờ — người mới vẫn đăng ký được, một người có vài IP không dùng hết được phần của mọi người.
 * Mỗi (hộp thư, IP) 5 thư / 24 giờ — người lạ ở IP khác không làm chủ email mất lượt; mỗi hộp thư 5 thư / giờ — dùng
 * nhiều IP cũng không dội được nhiều thư / đoán được nhiều mã.
 */
const REG_SEND_PER_IP_HOUR = 10;
const REG_SEND_PER_IP_HOUR_BUSY = 3;
const REG_SEND_PER_IP_DAY = 30;
const REG_SEND_PER_NET_HOUR = 20;
const REG_SEND_PER_NET_HOUR_BUSY = 6;
const REG_MAIL_PER_MBOX_IP_DAY = 5;
const REG_MAIL_PER_MBOX_HOUR = 5;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** Mã phiên đăng ký (regId): 16 byte ngẫu nhiên dạng base64url */
const REG_ID_RE = /^[A-Za-z0-9_-]{22}$/;
/**
 * Cổng gửi mã — MỘT script nên nguyên tử: kiểm tra hết rồi mới ghi. Yêu cầu đồng thời không vượt giới hạn; yêu cầu bị
 * từ chối KHÔNG cộng / đặt gì (không bật thời gian chờ khi chưa gửi thư nào).
 * KEYS: 1 thời gian chờ gửi lại (hộp thư + IP), 2 trở đi là các bộ đếm (xem registerStart).
 * ARGV: 1 giá trị khoá chờ (regId), 2 thời gian chờ (ms), rồi từng cặp (trần, cửa sổ ms) cho KEYS 2, 3, …
 * Trả về {0, 0} = được gửi (đã đặt khoá chờ, cộng mọi bộ đếm — cửa sổ cố định như RedisService.hit);
 * {i, pttl} = khoá thứ i chặn, còn pttl ms.
 */
const REG_SEND_GATE = `
local function blocked(i, ms)
  local t = redis.call('PTTL', KEYS[i])
  -- Khoá lỡ không có hạn: đặt lại hạn để không chặn mãi
  if t == -1 then redis.call('PEXPIRE', KEYS[i], ms); t = tonumber(ms) end
  return {i, t}
end
if redis.call('EXISTS', KEYS[1]) == 1 then return blocked(1, ARGV[2]) end
for i = 2, #KEYS do
  local n = tonumber(redis.call('GET', KEYS[i]) or '0')
  if n >= tonumber(ARGV[i * 2 - 1]) then return blocked(i, ARGV[i * 2]) end
end
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
for i = 2, #KEYS do
  redis.call('INCR', KEYS[i])
  if redis.call('PTTL', KEYS[i]) < 0 then redis.call('PEXPIRE', KEYS[i], ARGV[i * 2]) end
end
return {0, 0}
`;
/**
 * Một lần nhập mã (nguyên tử). KEYS[1] = reg:code:<regId>, ARGV[1] = email đã chuẩn hoá.
 * Không có mã, hoặc mã thuộc email khác → {-1, ''} và KHÔNG tính lần thử (HGET trên khoá không tồn tại trả về nil).
 * Ngược lại tăng số lần thử, trả về {số lần thử sau khi tăng, băm của mã}.
 * Không dùng HINCRBY trần: khoá đã hết hạn sẽ bị tạo lại không có hạn.
 */
const REG_ATTEMPT = `if redis.call('HGET', KEYS[1], 'e') ~= ARGV[1] then return {-1, ''} end
local n = redis.call('HINCRBY', KEYS[1], 'a', 1)
return {n, redis.call('HGET', KEYS[1], 'h') or ''}`;
/** "Gửi lại mã": xoá mã trước đó của chính trình duyệt này — chỉ khi mã đó thuộc đúng email này */
const REG_DEL_OWN = `if redis.call('HGET', KEYS[1], 'e') == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0`;
const REG_LOCKED_MSG = 'Bạn nhập sai quá nhiều lần, hãy bấm Gửi lại mã';
const REG_CODE_EXPIRED_MSG = 'Mã đã hết hạn, bạn bấm Gửi lại mã nhé';
const REG_TICKET_EXPIRED_MSG = 'Phiên đăng ký đã hết hạn, bạn nhập lại email để nhận mã mới nhé';
const REG_MAIL_FAILED_MSG = 'Chưa gửi được email chứa mã. Bạn thử lại sau ít phút nhé';

/**
 * Tài khoản KHÁCH (chơi không cần đăng nhập — trừ xếp hạng). Giới hạn mỗi giờ (cửa sổ cố định), để không ai dùng việc
 * này làm đầy cơ sở dữ liệu nhưng cũng không ai chặn được khách mới của cả trang:
 *  - mỗi IP (IPv6 gộp /64) 10 khách, mỗi dải IPv6 /48 30 khách;
 *  - toàn trang quá 300 khách / giờ = "đang đông": KHÔNG chặn mọi người mà siết theo IP — mỗi IP chỉ còn 3 khách, mỗi
 *    /48 6 khách (người mới vẫn vào được; muốn dùng hết phải có rất nhiều IP);
 *  - trần cứng toàn trang 3000 khách / giờ (bảo vệ cơ sở dữ liệu): chạm trần mới chặn tất cả, kèm báo lỗi trong log.
 * Yêu cầu bị từ chối không được tính (bấm "Thử lại" không làm mất lượt). Khách cũ được dọn định kỳ (GuestCleanupService).
 */
const GUEST_PER_IP_HOUR = 10;
const GUEST_PER_NET_HOUR = 30;
const GUEST_BUSY_GLOBAL_HOUR = 300;
const GUEST_BUSY_PER_IP_HOUR = 3;
const GUEST_BUSY_PER_NET_HOUR = 6;
const GUEST_MAX_GLOBAL_HOUR = 3000;
const GUEST_GLOBAL_KEY = 'rl:guest-global';
/**
 * Cổng tạo khách (nguyên tử, kiểm tra hết rồi mới cộng — bị từ chối thì không cộng gì).
 * KEYS: 1 toàn trang, 2 theo IP, 3 (nếu có) theo dải /48. ARGV: 1 cửa sổ (giây), 2 ngưỡng "đông", 3 trần cứng, rồi từng
 * cặp (giới hạn thường, giới hạn lúc đông) cho KEYS 2, 3. Trả về {0, 0|1 (đang đông)} = được tạo; {i, pttl} = khoá i chặn.
 */
const GUEST_GATE = `
local function blocked(i)
  local t = redis.call('PTTL', KEYS[i])
  if t == -1 then redis.call('EXPIRE', KEYS[i], ARGV[1]); t = tonumber(ARGV[1]) * 1000 end
  return {i, t}
end
local g = tonumber(redis.call('GET', KEYS[1]) or '0')
if g >= tonumber(ARGV[3]) then return blocked(1) end
local busy = g >= tonumber(ARGV[2])
for i = 2, #KEYS do
  local n = tonumber(redis.call('GET', KEYS[i]) or '0')
  local lim = tonumber(busy and ARGV[i * 2 + 1] or ARGV[i * 2])
  if n >= lim then return blocked(i) end
end
for i = 1, #KEYS do
  redis.call('INCR', KEYS[i])
  if redis.call('TTL', KEYS[i]) < 0 then redis.call('EXPIRE', KEYS[i], ARGV[1]) end
end
if busy then return {0, 1} end
return {0, 0}
`;
/** Báo "chạm trần cứng tạo khách" tối đa một lần mỗi 10 phút (mỗi instance) */
const GUEST_CAP_ALERT_EVERY_MS = 10 * 60_000;

/** Số giây / số phút còn lại (làm tròn lên, tối thiểu 1) từ PTTL của khoá (PTTL âm = khoá vừa hết hạn → 1) */
const secondsLeft = (ms: number) => (Number.isFinite(ms) && ms > 0 ? Math.ceil(ms / 1000) : 1);
const minutesLeft = (ms: number) => (Number.isFinite(ms) && ms > 0 ? Math.ceil(ms / 60_000) : 1);
/** "N phút", hoặc "khoảng N giờ" khi phải chờ từ 90 phút */
function waitText(ms: number): string {
  const min = minutesLeft(ms);
  return min >= 90 ? `khoảng ${Math.round(min / 60)} giờ` : `${min} phút`;
}

/** 429 reg_ip_limit: IP này yêu cầu / nhập mã quá nhiều lần (kèm thời gian phải chờ, "khoảng N giờ" khi từ 90 phút) */
function regIpLimit(what: string, pttl: number): GameError {
  return new GameError(`${what}. Bạn thử lại sau ${waitText(pttl)} nhé`, 'reg_ip_limit', {
    status: 429,
    retryAfterSec: secondsLeft(pttl),
  });
}

/** 429 reg_mail_quota: đã gửi nhiều mã tới hộp thư này ("sau khoảng N giờ" khi phải chờ từ 90 phút) */
function regMailQuota(pttl: number): GameError {
  return new GameError(`Đã gửi nhiều mã tới email này. Bạn thử lại sau ${waitText(pttl)} nhé`, 'reg_mail_quota', {
    status: 429,
    retryAfterSec: secondsLeft(pttl),
  });
}

/**
 * Khoá giới hạn thư đặt lại mật khẩu: theo (địa chỉ, IP) / ngày, theo địa chỉ / giờ, theo IP / giờ và / ngày, theo dải
 * IPv6 /48 / giờ và / ngày; số thư đã gửi tới địa chỉ trong 24 giờ (thư đầu tiên được dùng phần trần còn trống)
 */
const resetDayKey = (email: string, ip: string) => `rl:mail-day:reset:${email}:${ipBucket(ip)}`;
const resetHourKey = (email: string) => `rl:mail-hour:reset:${email}`;
const resetSendHourKey = (ip: string) => `rl:reset-send:${ipBucket(ip)}`;
const resetSendDayKey = (ip: string) => `rl:reset-send-day:${ipBucket(ip)}`;
const resetSendNetHourKey = (ip: string) => `rl:reset-send-net:${ipNetBucket(ip)}`;
const resetSendNetDayKey = (ip: string) => `rl:reset-send-net-day:${ipNetBucket(ip)}`;
const resetRecvDayKey = (email: string) => `rl:reset-recv-day:${email}`;

@Injectable()
export class AuthService {
  private readonly logger = new Logger('Auth');

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly mail: MailService,
    private readonly redis: RedisService,
    private readonly realtime: RealtimeService,
    private readonly live: LiveMatchService,
    private readonly presence: PresenceService,
    private readonly cfg: AppConfig,
  ) {}

  async userFromToken(token: string | undefined | null): Promise<AuthUser | null> {
    const s = await this.sessions.verify(token);
    if (!s) return null;
    const user = await this.prisma.user.findUnique({ where: { id: s.userId } });
    // Tài khoản máy chơi không bao giờ có phiên đăng nhập hợp lệ
    if (!user || user.isBanned || user.isBot) return null;
    return { ...user, sid: s.sid };
  }

  userFromRequest(req: Request): Promise<AuthUser | null> {
    const cookies = (req as Request & { cookies?: Record<string, string> }).cookies;
    return this.userFromToken(cookies?.[this.cfg.cookieName]);
  }

  /** Thành viên đã đăng nhập (KHÔNG tính khách); null nếu chưa đăng nhập hoặc đang là khách */
  async memberFromRequest(req: Request): Promise<AuthUser | null> {
    const u = await this.userFromRequest(req);
    return u && !u.isGuest ? u : null;
  }

  /**
   * Phiên KHÁCH: chơi phòng riêng / Cờ úp… không cần tài khoản (chỉ xếp hạng mới cần đăng nhập).
   * Đã có phiên (thành viên hoặc khách) → trả lại đúng người đó, không tạo gì. Chưa có → tạo tài khoản khách tạm
   * (tên "Khách 123456", email nội bộ @guests.invalid, mật khẩu ngẫu nhiên không ai biết → không đăng nhập bằng mật
   * khẩu được) rồi tạo phiên + cookie như đăng nhập.
   */
  async createGuest(req: Request, res: Response, ip: string): Promise<MeDto> {
    const current = await this.userFromRequest(req);
    if (current) return this.me(current);
    const ipb = ipBucket(ip);
    const netb = ipNetBucket(ip);
    // IPv4: dải "mạng" chính là địa chỉ đó → chỉ một bộ đếm theo IP
    const keys = [GUEST_GLOBAL_KEY, `rl:guest:${ipb}`, ...(netb !== ipb ? [`rl:guest-net:${netb}`] : [])];
    const [blockedBy, pttl] = (await this.redis.client.eval(
      GUEST_GATE,
      keys.length,
      ...keys,
      '3600',
      String(GUEST_BUSY_GLOBAL_HOUR),
      String(GUEST_MAX_GLOBAL_HOUR),
      String(GUEST_PER_IP_HOUR),
      String(GUEST_BUSY_PER_IP_HOUR),
      String(GUEST_PER_NET_HOUR),
      String(GUEST_BUSY_PER_NET_HOUR),
    )) as [number, number];
    if (blockedBy === 1) {
      this.guestCapAlert();
      throw new GameError(
        `Đang có quá nhiều người vào chơi với tư cách khách. Bạn thử lại sau ${minutesLeft(pttl)} phút, hoặc đăng nhập để chơi ngay nhé`,
        'guest_limit',
        { status: 429, retryAfterSec: secondsLeft(pttl) },
      );
    }
    if (blockedBy !== 0) {
      throw new GameError(
        `Từ mạng của bạn đã có nhiều lượt vào chơi với tư cách khách. Bạn thử lại sau ${minutesLeft(pttl)} phút, hoặc đăng nhập để chơi ngay nhé`,
        'guest_limit',
        { status: 429, retryAfterSec: secondsLeft(pttl) },
      );
    }
    // Mật khẩu "không dùng được" (không ai đăng nhập bằng mật khẩu vào khách) — không tốn CPU như băm thật
    const passwordHash = passwords.unusableHash();
    let user: User | null = null;
    for (let i = 0; i < 6 && !user; i++) {
      const username = `Khách ${randomInt(100_000, 1_000_000)}`;
      try {
        user = await this.prisma.user.create({
          data: {
            username,
            usernameKey: usernameKey(username),
            email: `guest-${randomUUID()}@${GUEST_EMAIL_DOMAIN}`,
            passwordHash,
            isGuest: true,
          },
        });
      } catch {
        // Trùng tên (hiếm): thử số khác
      }
    }
    if (!user) {
      // Không tạo được: trả lại các lượt vừa tính
      await this.redis.giveBack(...keys).catch(() => undefined);
      throw new GameError('Chưa vào được với tư cách khách, bạn thử lại nhé', 'guest_failed', { status: 503 });
    }
    const { token } = await this.sessions.create(user.id);
    this.sessions.setCookie(res, token);
    return this.me(user);
  }

  private guestCapAlertAt = 0;

  /** Chạm trần cứng tạo khách của cả trang — báo lỗi trong log, tối đa một lần mỗi 10 phút */
  private guestCapAlert(): void {
    const now = Date.now();
    if (now - this.guestCapAlertAt < GUEST_CAP_ALERT_EVERY_MS) return;
    this.guestCapAlertAt = now;
    this.logger.error(
      `Chạm trần ${GUEST_MAX_GLOBAL_HOUR} khách / giờ của cả trang — đang chặn mọi khách mới. Kiểm tra xem có ai tạo khách ` +
        'hàng loạt không (nhiều IP khác nhau); lưu lượng thật thì nâng GUEST_MAX_GLOBAL_HOUR trong auth.service.ts.',
    );
  }

  async me(user: User): Promise<MeDto> {
    return {
      id: user.id,
      username: user.username,
      avatarUrl: user.avatarUrl,
      // Khách: email nội bộ (guest-…@guests.invalid) không đưa ra ngoài
      email: user.isGuest ? '' : user.email,
      role: user.role,
      emailVerified: user.emailVerifiedAt !== null,
      createdAt: user.createdAt.toISOString(),
      activeMatchId: await this.live.activeMatchOf(user.id),
      isGuest: user.isGuest,
    };
  }

  private fingerprint(passwordHash: string): string {
    return createHash('sha256').update(passwordHash).digest('base64url').slice(0, 16);
  }

  /**
   * Thư đặt lại mật khẩu: tính theo (địa chỉ, IP người yêu cầu) để người lạ không thể dùng hết lượt của nạn nhân
   * (chặn họ lấy lại mật khẩu cả ngày); thêm trần chung theo địa chỉ TÍNH THEO GIỜ để không bị dùng gửi thư rác —
   * kẻ phá có nhiều IP cũng chỉ chặn được tối đa 1 giờ (chặn hẳn cần captcha — chưa có). Thêm giới hạn số thư theo IP
   * (siết lại khi phần thư đặt lại mật khẩu của trang đang bận; IPv6 tính thêm theo dải /48) để một người có vài IP và
   * vài địa chỉ đã đăng ký không dùng hết phần thư đó của cả trang. Trả về các khoá đã cộng (để trả lại khi thư không đi)
   * và `firstToday` = đây là thư đầu tiên tới địa chỉ này trong 24 giờ; null = hết lượt (không cộng gì).
   */
  private async underResetMailQuota(email: string, ip: string): Promise<{ counted: string[]; firstToday: boolean } | null> {
    const busy = await this.mail.isBusy('reset');
    const ipv6Net = ipNetBucket(ip) !== ipBucket(ip);
    const checks: [string, number, number][] = [
      [resetDayKey(email, ip), RESET_MAIL_PER_IP_DAY, 86_400],
      [resetHourKey(email), RESET_MAIL_PER_HOUR, 3_600],
      [resetSendHourKey(ip), busy ? RESET_SEND_PER_IP_HOUR_BUSY : RESET_SEND_PER_IP_HOUR, 3_600],
      [resetSendDayKey(ip), RESET_SEND_PER_IP_DAY, 86_400],
      ...(ipv6Net
        ? ([
            [resetSendNetHourKey(ip), busy ? RESET_SEND_PER_NET_HOUR_BUSY : RESET_SEND_PER_NET_HOUR, 3_600],
            [resetSendNetDayKey(ip), RESET_SEND_PER_NET_DAY, 86_400],
          ] as [string, number, number][])
        : []),
    ];
    const counted: string[] = [];
    for (const [key, limit, windowSec] of checks) {
      counted.push(key);
      if ((await this.redis.hit(key, windowSec)) > limit) {
        // Bị từ chối: không tính lần này vào bộ đếm nào
        await this.redis.giveBack(...counted).catch(() => undefined);
        return null;
      }
    }
    // Không có giới hạn: chỉ để biết đây có phải thư đầu tiên tới địa chỉ này trong 24 giờ không
    const recvKey = resetRecvDayKey(email);
    counted.push(recvKey);
    const received = await this.redis.hit(recvKey, 86_400);
    return { counted, firstToday: received === 1 };
  }

  /**
   * Gửi email xác thực — tối đa MAIL_PER_DAY thư / ngày tới mỗi địa chỉ (chống dùng web để gửi thư rác).
   * 'quota' = địa chỉ đã hết lượt trong ngày; còn lại là kết quả gửi thư (MailResult — chưa gửi được thì đã trả lại lượt
   * vừa tính).
   */
  private async sendVerification(user: User): Promise<MailResult | 'quota'> {
    const quotaKey = `rl:mail-day:verify:${user.email}`;
    if ((await this.redis.hit(quotaKey, 86_400)) > MAIL_PER_DAY) return 'quota';
    const token = this.sessions.signPurposeToken(user.id, 'verify', user.email, VERIFY_TTL_SEC);
    const link = `${this.cfg.appUrl}/verify-email?token=${encodeURIComponent(token)}`;
    const r = await this.mail.sendVerification(user.email, user.username, link);
    if (!r.ok) await this.redis.giveBack(quotaKey).catch(() => undefined);
    return r;
  }

  /**
   * Email của tài khoản đã được CHỦ HỘP THƯ chứng minh chưa: nhập mã / bấm liên kết / đặt lại mật khẩu ('email'), hoặc
   * Google xác nhận email_verified ('google'). Email chỉ được tin vì Facebook trả về ('facebook') thì CHƯA: có thể là
   * người khác dùng tài khoản Facebook khai email này. Tài khoản xác thực trước khi có cột email_verified_via (null):
   * coi là đã chứng minh, TRỪ KHI có liên kết Facebook (từ 11/11/2026 tài khoản tạo bằng Facebook được xác thực ngay).
   */
  async emailProven(user: Pick<User, 'id' | 'emailVerifiedAt' | 'emailVerifiedVia'>): Promise<boolean> {
    if (!user.emailVerifiedAt) return false;
    const via = user.emailVerifiedVia as EmailVerifiedVia | null;
    if (via === 'email' || via === 'google') return true;
    if (via !== null) return false;
    return (await this.prisma.oAuthAccount.count({ where: { userId: user.id, provider: 'facebook' } })) === 0;
  }

  /** Câu gợi ý đăng nhập bằng mạng xã hội (chỉ những cách đang bật), vd ", hoặc đăng nhập bằng Google, Facebook" */
  private socialHint(prefix: string): string {
    const names = [this.cfg.oauth.google ? 'Google' : null, this.cfg.oauth.facebook ? 'Facebook' : null].filter(Boolean);
    return names.length ? `${prefix}${names.join(', ')}` : '';
  }

  /** 503 mail_unavailable khi loại thư này đã hết phần trong trần gửi thư của trang — kèm thời gian chờ thật */
  private mailCapError(what: string, retryAfterSec: number, hint = ''): GameError {
    return new GameError(
      `Hệ thống tạm thời đã gửi quá nhiều email ${what}. Bạn thử lại sau ${waitText(retryAfterSec * 1000)}${hint} nhé`,
      'mail_unavailable',
      { status: 503, retryAfterSec },
    );
  }

  /** Gửi email xác thực (tài khoản tạo từ mạng xã hội khi email chưa được nhà cung cấp xác minh) — cố gắng hết sức */
  async sendVerificationTo(user: User): Promise<void> {
    await this.sendVerification(user);
  }

  /**
   * Đăng ký MỘT bước kiểu cũ (tạo tài khoản CHƯA xác thực email + gửi liên kết xác thực). Giao diện không dùng nữa;
   * chỉ mở khi cfg.allowLegacyRegister (mặc định: dev bật — smoke test dùng; production tắt). Tắt → 404 như đường dẫn lạ.
   */
  async register(body: unknown, res: Response, ip: string): Promise<MeDto> {
    if (!this.cfg.allowLegacyRegister) throw new NotFoundException('Không tìm thấy');
    const b = (body ?? {}) as Record<string, unknown>;
    const err = validateUsername(b.username) ?? validateEmail(b.email) ?? validatePassword(b.password);
    if (err) throw new BadRequestException(err);
    // Tên miền dành riêng cho tài khoản máy: báo như email sai định dạng
    if (isReservedBotEmail(b.email as string)) throw new BadRequestException('Email không hợp lệ');
    if ((await this.redis.hit(`rl:register:${ipBucket(ip)}`, 3600)) > 20) throw tooMany('Bạn đăng ký quá nhiều lần, hãy thử lại sau');
    const username = normalizeUsername(b.username as string);
    const email = normalizeEmail(b.email as string);
    const key = usernameKey(username);
    const exists = await this.prisma.user.findFirst({ where: { OR: [{ email }, { usernameKey: key }] } });
    if (exists) {
      throw new ConflictException(exists.email === email ? 'Email đã được sử dụng' : 'Tên hiển thị đã có người dùng');
    }
    const passwordHash = await passwords.hash(b.password as string);
    let user: User;
    try {
      user = await this.prisma.user.create({ data: { username, usernameKey: key, email, passwordHash } });
    } catch {
      throw new ConflictException('Email hoặc tên hiển thị đã được sử dụng');
    }
    // Cố gắng hết sức: tài khoản đã tạo; chưa gửi được thì người dùng bấm "Gửi lại email xác thực" sau
    await this.sendVerification(user);
    const { token } = await this.sessions.create(user.id);
    this.sessions.setCookie(res, token);
    return this.me(user);
  }

  /* ======================= Đăng ký 3 bước ======================= */

  /**
   * Băm HMAC của mã xác thực (khoá lấy từ JWT_SECRET, tách mục đích để không dùng lẫn); Redis chỉ giữ băm.
   * Gắn cả regId và email: mã chỉ đúng cho đúng lần gửi đó. Chuỗi không mơ hồ — regId (base64url) và email đã kiểm tra
   * định dạng đều không chứa ':'.
   */
  private regCodeHash(regId: string, email: string, code: string): string {
    const key = createHash('sha256').update(`reg-code:${this.cfg.jwtSecret}`).digest();
    return createHmac('sha256', key).update(`${regId}:${email}:${code}`).digest('base64url');
  }

  /**
   * Bước 1 (và "Gửi lại mã"): gửi mã 6 chữ số tới email chưa có tài khoản. Mỗi lần gửi thành công tạo một regId mới với
   * mã riêng — trình duyệt giữ regId, gửi kèm ở bước 2. Người lạ không có regId nên không nhập thử / khoá / thay được mã
   * của người khác. Gửi lại kèm regId cũ (cùng email) thì mã cũ bị huỷ.
   */
  async registerStart(body: unknown, ip: string): Promise<RegisterStartResponse> {
    const b = (body ?? {}) as Record<string, unknown>;
    const err = validateEmail(b.email);
    if (err) throw new BadRequestException(err);
    if (isReservedBotEmail(b.email as string)) throw new BadRequestException('Email không hợp lệ');
    const ipb = ipBucket(ip);
    const netb = ipNetBucket(ip);
    // Đếm MỌI yêu cầu của IP (kể cả bị từ chối 409 / 429) — chặn dò email hàng loạt
    const reqKey = `rl:reg-start:${ipb}`;
    if ((await this.redis.hit(reqKey, 3600)) > REG_START_PER_IP_HOUR) {
      throw regIpLimit('Bạn yêu cầu gửi mã quá nhiều lần', await this.redis.client.pttl(reqKey));
    }
    const email = normalizeEmail(b.email as string);
    if (await this.prisma.user.findUnique({ where: { email }, select: { id: true } })) {
      throw new ConflictException('Email đã được sử dụng');
    }
    // Giới hạn gửi thư tính theo HỘP THƯ (gộp ban+1@…, b.a.n@gmail.com…) — xem mailboxKey
    const mbox = mailboxKey(email);
    const regId = randomBytes(16).toString('base64url');
    const cooldownKey = `rl:reg-resend:${mbox}:${ipb}`;
    // Phần thư mã đăng ký của trang đã dùng quá nửa → siết giới hạn theo IP / dải mạng
    const busy = await this.mail.isBusy('register-code');
    // Bộ đếm (khoá, trần, cửa sổ ms) — thứ tự quyết định cách báo lỗi bên dưới; dải /48 chỉ có với IPv6
    const gates: [string, number, number][] = [
      [`rl:reg-send:${ipb}`, busy ? REG_SEND_PER_IP_HOUR_BUSY : REG_SEND_PER_IP_HOUR, HOUR_MS],
      [`rl:reg-mail-day:${mbox}:${ipb}`, REG_MAIL_PER_MBOX_IP_DAY, DAY_MS],
      [`rl:reg-mail-hour:${mbox}`, REG_MAIL_PER_MBOX_HOUR, HOUR_MS],
      [`rl:reg-send-day:${ipb}`, REG_SEND_PER_IP_DAY, DAY_MS],
      ...(netb !== ipb
        ? [[`rl:reg-send-net:${netb}`, busy ? REG_SEND_PER_NET_HOUR_BUSY : REG_SEND_PER_NET_HOUR, HOUR_MS] as [string, number, number]]
        : []),
    ];
    const counters = gates.map(([k]) => k);
    const [blockedBy, pttl] = (await this.redis.client.eval(
      REG_SEND_GATE,
      1 + gates.length,
      cooldownKey,
      ...counters,
      regId,
      String(REG_RESEND_COOLDOWN_SEC * 1000),
      ...gates.flatMap(([, limit, windowMs]) => [String(limit), String(windowMs)]),
    )) as [number, number];
    if (blockedBy === 1) {
      const sec = secondsLeft(pttl);
      throw new GameError(`Bạn chờ ${sec} giây rồi gửi lại mã nhé`, 'reg_resend_wait', { status: 429, retryAfterSec: sec });
    }
    // KEYS[3], KEYS[4] = giới hạn theo hộp thư; còn lại = theo IP / dải mạng
    if (blockedBy === 3 || blockedBy === 4) throw regMailQuota(pttl);
    if (blockedBy !== 0) throw regIpLimit('Bạn yêu cầu gửi mã quá nhiều lần', pttl);
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const codeKey = `reg:code:${regId}`;
    await this.redis.client
      .multi()
      .hset(codeKey, 'e', email, 'h', this.regCodeHash(regId, email, code), 'a', '0')
      .expire(codeKey, REG_CODE_TTL_SEC)
      .exec();
    const sent: MailResult = await this.mail.sendRegisterCode(email, code, REG_CODE_TTL_SEC / 60).catch((e: unknown) => {
      this.logger.error(`Lỗi khi gửi mã đăng ký: ${(e as Error).message}`);
      return { ok: false, reason: 'error' } as const;
    });
    if (!sent.ok) {
      // Thư không đi (MailService đã ghi lý do vào log): huỷ mã vừa tạo, gỡ thời gian chờ của lần này, trả lại các lượt
      // đếm — không báo "đã gửi" sai, không làm người dùng mất lượt. Mã cũ (nếu đang gửi lại) vẫn dùng được.
      try {
        await this.redis.client.del(codeKey);
        await this.redis.delIfEquals(cooldownKey, regId);
        await this.redis.giveBack(...counters);
      } catch (e) {
        this.logger.warn(`Không hoàn tác được lần gửi mã thất bại: ${(e as Error).message}`);
      }
      if (sent.reason === 'cap') throw this.mailCapError('mã đăng ký', sent.retryAfterSec, this.socialHint(', hoặc đăng nhập bằng '));
      throw new GameError(REG_MAIL_FAILED_MSG, 'mail_unavailable', { status: 503 });
    }
    // "Gửi lại mã": huỷ mã trước đó của chính trình duyệt này (regId nó giữ, cùng email). Không huỷ được thì mã cũ tự
    // hết hạn — không ảnh hưởng mã mới.
    const prevRegId = typeof b.regId === 'string' && REG_ID_RE.test(b.regId) ? b.regId : null;
    if (prevRegId) await this.redis.client.eval(REG_DEL_OWN, 1, `reg:code:${prevRegId}`, email).catch(() => undefined);
    return { email, regId, resendAfterSec: REG_RESEND_COOLDOWN_SEC, expiresInSec: REG_CODE_TTL_SEC };
  }

  /** Bước 2: kiểm tra mã (kèm regId nhận ở bước 1); đúng thì trả phiếu dùng một lần cho bước 3 */
  async registerVerify(body: unknown, ip: string): Promise<RegisterVerifyResponse> {
    const b = (body ?? {}) as Record<string, unknown>;
    if (validateEmail(b.email)) throw new BadRequestException('Email không hợp lệ');
    const code = typeof b.code === 'string' ? b.code.trim() : '';
    if (!/^\d{6}$/.test(code)) throw new BadRequestException('Mã gồm 6 chữ số');
    const ipKey = `rl:reg-verify:${ipBucket(ip)}`;
    if ((await this.redis.hit(ipKey, 3600)) > REG_VERIFY_PER_IP_HOUR) {
      throw regIpLimit('Bạn nhập mã quá nhiều lần', await this.redis.client.pttl(ipKey));
    }
    // Thiếu / sai dạng regId, mã không còn, hoặc mã của email khác: cùng một câu "hết hạn", không tính lần thử nào
    const regId = typeof b.regId === 'string' && REG_ID_RE.test(b.regId) ? b.regId : null;
    if (!regId) throw new GameError(REG_CODE_EXPIRED_MSG, 'reg_code_expired');
    const email = normalizeEmail(b.email as string);
    const key = `reg:code:${regId}`;
    const [n, stored] = (await this.redis.client.eval(REG_ATTEMPT, 1, key, email)) as [number, string];
    if (n === -1 || !stored) throw new GameError(REG_CODE_EXPIRED_MSG, 'reg_code_expired');
    if (n > REG_CODE_MAX_ATTEMPTS) throw new GameError(REG_LOCKED_MSG, 'reg_code_locked');
    const expected = Buffer.from(stored);
    const got = Buffer.from(this.regCodeHash(regId, email, code));
    if (expected.length !== got.length || !timingSafeEqual(expected, got)) {
      const left = REG_CODE_MAX_ATTEMPTS - n;
      if (left <= 0) throw new GameError(REG_LOCKED_MSG, 'reg_code_locked');
      throw new GameError(`Mã chưa đúng, bạn còn ${left} lần thử`, 'reg_code_wrong', { attemptsLeft: left });
    }
    // Chỉ một yêu cầu đúng (kể cả gửi đồng thời) được phiếu: yêu cầu xoá được khoá
    if ((await this.redis.client.del(key)) !== 1) throw new GameError(REG_CODE_EXPIRED_MSG, 'reg_code_expired');
    const ticket = randomBytes(32).toString('base64url');
    await this.redis.client.set(`reg:ticket:${ticket}`, email, 'EX', REG_TICKET_TTL_SEC);
    return { ticket, expiresInSec: REG_TICKET_TTL_SEC };
  }

  /** Bước 3: tạo tài khoản (email đã xác thực) và đăng nhập */
  async registerComplete(body: unknown, req: Request, res: Response): Promise<MeDto> {
    const b = (body ?? {}) as Record<string, unknown>;
    const ticket = typeof b.ticket === 'string' && /^[A-Za-z0-9_-]{43}$/.test(b.ticket) ? b.ticket : null;
    if (!ticket) throw new GameError(REG_TICKET_EXPIRED_MSG, 'reg_ticket_expired');
    // Kiểm tra dữ liệu TRƯỚC khi dùng phiếu: nhập sai thì sửa rồi gửi lại được
    const err = validateUsername(b.username) ?? validatePassword(b.password);
    if (err) throw new BadRequestException(err);
    const ticketKey = `reg:ticket:${ticket}`;
    if (!(await this.redis.client.exists(ticketKey))) throw new GameError(REG_TICKET_EXPIRED_MSG, 'reg_ticket_expired');
    const username = normalizeUsername(b.username as string);
    const key = usernameKey(username);
    if (await this.prisma.user.findUnique({ where: { usernameKey: key }, select: { id: true } })) {
      throw new ConflictException('Tên hiển thị đã có người dùng');
    }
    // Băm TRƯỚC khi dùng phiếu: máy chủ bận (503) thì phiếu vẫn còn, bấm lại được. Người có phiếu đã chứng minh hộp thư
    // → hàng ưu tiên
    const passwordHash = await passwords.hash(b.password as string, 'high');
    const ttl = await this.redis.client.ttl(ticketKey);
    // Dùng phiếu (nguyên tử): hai yêu cầu đồng thời chỉ một cái tạo được tài khoản
    const email = await this.redis.client.getdel(ticketKey);
    if (!email) throw new GameError(REG_TICKET_EXPIRED_MSG, 'reg_ticket_expired');
    if (await this.prisma.user.findUnique({ where: { email }, select: { id: true } })) {
      throw new ConflictException('Email đã được sử dụng');
    }
    let user: User;
    try {
      user = await this.prisma.user.create({
        data: { username, usernameKey: key, email, passwordHash, emailVerifiedAt: new Date(), emailVerifiedVia: 'email' satisfies EmailVerifiedVia },
      });
    } catch {
      // Trùng do tạo đồng thời: email đã có → báo email; còn lại là trùng tên → trả lại phiếu để chọn tên khác
      if (await this.prisma.user.findUnique({ where: { email }, select: { id: true } })) throw new ConflictException('Email đã được sử dụng');
      if (ttl > 0) await this.redis.client.set(ticketKey, email, 'EX', ttl);
      throw new ConflictException('Tên hiển thị đã có người dùng');
    }
    const { token } = await this.sessions.create(user.id);
    this.sessions.setCookie(res, token);
    this.sessions.rememberDevice(req, res, email, passwordHash);
    return this.me(user);
  }

  /**
   * Khi tài khoản đang trong ván và nơi đang chơi còn kết nối: chặn đăng nhập nơi khác.
   * Nếu nơi cũ đã mất kết nối (máy hỏng, hết pin) thì cho đăng nhập để vào lại ván.
   */
  async ensureNotPlayingElsewhere(userId: string): Promise<void> {
    const matchId = await this.live.activeMatchOf(userId);
    if (!matchId) return;
    const s = await this.live.load(matchId);
    if (!s || s.status !== 'playing') return;
    const color = this.live.colorOf(s, userId);
    if (color === null) return;
    const att = s.attached[color];
    if (att && (await this.presence.isSocketAlive(userId, att.socketId))) {
      throw new ConflictException(
        'Tài khoản này đang chơi dở một ván ở nơi khác (tab hoặc máy khác). Bạn đăng nhập ở đây sau khi ván đó kết thúc nhé.',
      );
    }
  }

  /**
   * Số lần kiểm tra mật khẩu đăng nhập đang chạy (xem LOGIN_INFLIGHT_PER_NET): 'u:<IP / dải /48>' = trình duyệt lạ,
   * 'k:<IP / dải /48>' và 'e:<email>' = trình duyệt quen
   */
  private readonly loginInflight = new Map<string, number>();
  /** Quyền "trình duyệt quen" theo IP / dải /48 (xem KNOWN_PRIVILEGE_RULE) */
  private readonly knownLimiter = new TokenBucketLimiter({ known: KNOWN_PRIVILEGE_RULE });

  /** 429 login_limit kèm thời gian chờ thật (từ PTTL của khoá) */
  private loginLimit(message: string, pttl: number): GameError {
    return new GameError(message, 'login_limit', { status: 429, retryAfterSec: secondsLeft(pttl) });
  }

  async login(body: unknown, req: Request, res: Response, ip: string): Promise<MeDto> {
    const b = (body ?? {}) as Record<string, unknown>;
    if (typeof b.email !== 'string' || typeof b.password !== 'string') {
      throw new BadRequestException('Nhập email và mật khẩu');
    }
    // Email sai định dạng / quá dài: trả lỗi như sai mật khẩu, KHÔNG tạo khoá Redis nào (khoá dựng từ chuỗi người dùng
    // gửi lên — chuỗi 100 KB × nhiều yêu cầu từng làm phình bộ nhớ Redis)
    if (validateEmail(b.email) || b.password.length > 1024) {
      throw new UnauthorizedException('Email hoặc mật khẩu không đúng');
    }
    const email = normalizeEmail(b.email);
    const ipb = ipBucket(ip);
    const netb = ipNetBucket(ip);
    // Trình duyệt có dấu "quen" của email này (chưa tra DB nên dấu có thể đã cũ — xét lại sau khi có tài khoản): được
    // xếp trước trong hàng chờ kiểm tra mật khẩu, trong giới hạn KNOWN_PRIVILEGE_RULE của IP / dải /48 này
    const claimsKnown = this.sessions.claimsKnownDevice(req, email) && this.knownLimiter.take(netb, 'known');
    const priority = claimsKnown ? 'high' : 'low';
    // Bận (hàng chờ kiểm tra mật khẩu đầy, hoặc IP / dải /48 / email này đang có quá nhiều lần kiểm tra cùng lúc): từ
    // chối NGAY, trước mọi việc tốn kém (Redis, cơ sở dữ liệu) và không tính vào giới hạn nào
    const slots = claimsKnown ? [`k:${netb}`, `e:${email}`] : [`u:${netb}`];
    const caps = claimsKnown ? [LOGIN_INFLIGHT_PER_NET, KNOWN_INFLIGHT_PER_EMAIL] : [LOGIN_INFLIGHT_PER_NET];
    if (passwords.saturated(priority) || slots.some((k, i) => (this.loginInflight.get(k) ?? 0) >= caps[i])) {
      throw passwordBusyError();
    }
    for (const k of slots) this.loginInflight.set(k, (this.loginInflight.get(k) ?? 0) + 1);
    let user: User | null;
    let passOk: boolean;
    // Chỉ tính lần đăng nhập SAI (xem LOGIN_*). Giữ chỗ (cộng) TRƯỚC khi kiểm tra mật khẩu để các yêu cầu gửi đồng thời
    // không vượt giới hạn; đúng thì trả lại. Xét IP trước: IP đã vượt giới hạn thì không tạo thêm khoá theo email.
    const ipKey = `rl:login-ip:${ipb}`;
    const netKey = netb !== ipb ? `rl:login-net:${netb}` : null;
    let emailKey = `rl:login:${email}`;
    const counted = [ipKey];
    try {
      if ((await this.redis.hit(ipKey, LOGIN_WINDOW_SEC)) > LOGIN_PER_IP) {
        const pttl = await this.redis.client.pttl(ipKey);
        throw this.loginLimit(`Bạn đăng nhập sai quá nhiều lần, hãy thử lại sau ${minutesLeft(pttl)} phút`, pttl);
      }
      if (netKey) {
        counted.push(netKey);
        if ((await this.redis.hit(netKey, LOGIN_WINDOW_SEC)) > LOGIN_PER_NET) {
          const pttl = await this.redis.client.pttl(netKey);
          throw this.loginLimit(`Mạng của bạn đăng nhập sai quá nhiều lần, hãy thử lại sau ${minutesLeft(pttl)} phút`, pttl);
        }
      }
      user = await this.prisma.user.findUnique({ where: { email } });
      // Trình duyệt quen THẬT (dấu khớp cả mật khẩu hiện tại): không bị khoá theo email (người lạ nhập sai để khoá), có
      // giới hạn riêng theo (email, IP). Dấu cũ (mật khẩu đã được đặt lại) → như trình duyệt lạ
      const known = claimsKnown && !!user && this.sessions.isKnownDevice(req, email, user.passwordHash);
      if (known) emailKey = `rl:login-known:${email}:${ipb}`;
      counted.push(emailKey);
      if ((await this.redis.hit(emailKey, LOGIN_WINDOW_SEC)) > (known ? LOGIN_PER_KNOWN_DEVICE : LOGIN_PER_EMAIL)) {
        const pttl = await this.redis.client.pttl(emailKey);
        throw this.loginLimit(
          `Email này bị nhập sai mật khẩu quá nhiều lần. Bạn thử lại sau ${minutesLeft(pttl)} phút, hoặc dùng “Quên mật khẩu”` +
            `${this.socialHint(' / đăng nhập bằng ')} nhé`,
          pttl,
        );
      }
      // Luôn chạy bcrypt (kể cả khi không có tài khoản) để thời gian phản hồi không lộ email nào đã đăng ký. bcrypt chạy
      // ở luồng phụ, hàng chờ giới hạn (PasswordService)
      try {
        passOk = await passwords.compare(b.password, user?.passwordHash ?? DUMMY_HASH, priority);
      } catch (e) {
        // Máy chủ bận (hàng chờ vừa đầy) / lỗi băm: lần này chưa kiểm tra được mật khẩu → không tính vào giới hạn nào
        await this.redis.giveBack(...counted).catch(() => undefined);
        throw e;
      }
    } finally {
      for (const k of slots) {
        const left = (this.loginInflight.get(k) ?? 1) - 1;
        if (left > 0) this.loginInflight.set(k, left);
        else this.loginInflight.delete(k);
      }
    }
    // Tài khoản máy chơi / khách: báo y như sai mật khẩu
    if (!user || !passOk || user.isBot || user.isGuest) {
      throw new UnauthorizedException('Email hoặc mật khẩu không đúng');
    }
    // Đúng mật khẩu: không tính lần này
    await this.redis.client.del(emailKey);
    await this.redis.giveBack(...counted.filter((k) => k !== emailKey));
    if (user.isBanned) throw new ForbiddenException('Tài khoản này đã bị khoá. Nếu bạn nghĩ đây là nhầm lẫn, hãy liên hệ người quản trị.');
    await this.ensureNotPlayingElsewhere(user.id);
    const { sid, token } = await this.sessions.create(user.id);
    // Mật khẩu vừa được đặt lại / tài khoản vừa bị khoá trong lúc đăng nhập (sau khi đã huỷ mọi phiên): huỷ phiên này
    const fresh = await this.prisma.user.findUnique({ where: { id: user.id }, select: { passwordHash: true, isBanned: true } });
    if (!fresh || fresh.passwordHash !== user.passwordHash || fresh.isBanned) {
      await this.sessions.revoke(user.id, sid);
      throw new UnauthorizedException('Email hoặc mật khẩu không đúng');
    }
    this.sessions.setCookie(res, token);
    this.sessions.rememberDevice(req, res, email, user.passwordHash);
    return this.me(user);
  }

  /**
   * Đăng xuất — thành viên HOẶC khách ("Thoát chế độ khách": máy dùng chung thì người sau không dùng tiếp được danh tính
   * khách, ván đang chơi, phòng chờ). Không có phiên hợp lệ thì chỉ xoá cookie. Trình duyệt cũng thôi là "trình duyệt
   * quen" (máy dùng chung: người sau không được miễn khoá "nhập sai quá nhiều lần").
   */
  async logout(user: AuthUser | null, res: Response): Promise<void> {
    if (user) {
      await this.sessions.revoke(user.id, user.sid);
      this.realtime.disconnectSession(user.sid);
    }
    this.sessions.clearCookie(res);
    this.sessions.forgetDevice(res);
  }

  /**
   * Xác thực email. Tài khoản tạo bằng Google/Facebook mà email chưa được xác minh: chỉ xác thực khi người bấm liên kết
   * đang đăng nhập ĐÚNG tài khoản đó — nếu không, kẻ dùng tài khoản mạng xã hội khai email của người khác sẽ được chính
   * chủ email "xác thực hộ" rồi giữ quyền vào tài khoản. Chủ email thật dùng "Quên mật khẩu" (gỡ liên kết lạ — xem
   * resetPassword).
   */
  async verifyEmail(token: unknown, currentUserId: string | null = null): Promise<void> {
    const t = this.sessions.verifyPurposeToken(token, 'verify');
    if (!t) throw new BadRequestException('Liên kết xác thực không hợp lệ hoặc đã hết hạn');
    const user = await this.prisma.user.findUnique({ where: { id: t.userId } });
    if (!user || user.email !== t.fp) throw new BadRequestException('Liên kết xác thực không hợp lệ hoặc đã hết hạn');
    if (!user.emailVerifiedAt && currentUserId !== user.id) {
      const linked = await this.prisma.oAuthAccount.count({ where: { userId: user.id } });
      if (linked > 0) {
        throw new BadRequestException(
          'Tài khoản này được tạo bằng đăng nhập Google/Facebook. Hãy đăng nhập vào tài khoản đó trên trình duyệt này rồi mở lại liên kết. ' +
            'Nếu bạn không tạo tài khoản này, hãy dùng "Quên mật khẩu" với email của bạn để lấy lại quyền.',
        );
      }
    }
    if (!user.emailVerifiedAt) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { emailVerifiedAt: new Date(), emailVerifiedVia: 'email' satisfies EmailVerifiedVia },
      });
    }
  }

  async resendVerification(user: AuthUser): Promise<void> {
    if (user.emailVerifiedAt) throw new BadRequestException('Email đã được xác thực');
    // Thời gian chờ 1 phút giữ nguyên cả khi gửi thất bại: không để bấm liên tục vào SMTP đang lỗi
    if (!(await this.redis.rateLimitOnce(`rl:verify:${user.id}`, 60_000))) {
      throw tooMany('Vui lòng chờ 1 phút trước khi gửi lại');
    }
    const r = await this.sendVerification(user);
    if (r === 'quota') throw tooMany('Hôm nay đã gửi quá nhiều email tới địa chỉ này, hãy thử lại vào ngày mai');
    if (!r.ok) {
      if (r.reason === 'cap') throw this.mailCapError('xác thực', r.retryAfterSec);
      throw new GameError('Chưa gửi được email xác thực. Bạn thử lại sau ít phút nhé', 'mail_unavailable', { status: 503 });
    }
  }

  async forgotPassword(body: unknown, ip: string): Promise<void> {
    const b = (body ?? {}) as Record<string, unknown>;
    const err = validateEmail(b.email);
    if (err) throw new BadRequestException(err);
    const ipb = ipBucket(ip);
    const netb = ipNetBucket(ip);
    if ((await this.redis.hit(`rl:forgot-ip:${ipb}`, 3600)) > FORGOT_PER_IP_HOUR) throw tooMany('Bạn yêu cầu quá nhiều lần, hãy thử lại sau');
    if (netb !== ipb && (await this.redis.hit(`rl:forgot-net:${netb}`, 3600)) > FORGOT_PER_NET_HOUR) {
      throw tooMany('Bạn yêu cầu quá nhiều lần, hãy thử lại sau');
    }
    const email = normalizeEmail(b.email as string);
    const user = await this.prisma.user.findUnique({ where: { email } });
    // Luôn trả về thành công để không lộ email nào đã đăng ký
    if (!user || user.isBanned || user.isBot || user.isGuest) return;
    // Theo (tài khoản, IP): người khác gửi yêu cầu liên tục không làm chủ tài khoản mất lượt nhận thư
    if (!(await this.redis.rateLimitOnce(`rl:forgot:${user.id}:${ipb}`, 60_000))) return;
    const quota = await this.underResetMailQuota(user.email, ip);
    if (!quota) return;
    const { counted, firstToday } = quota;
    const token = this.sessions.signPurposeToken(user.id, 'reset', this.fingerprint(user.passwordHash), RESET_TTL_SEC);
    const link = `${this.cfg.appUrl}/reset-password?token=${encodeURIComponent(token)}`;
    const r = await this.mail.sendPasswordReset(user.email, user.username, link, { overflow: firstToday });
    if (!r.ok) {
      // Vẫn trả "thành công" cho người gọi (không lộ email nào có tài khoản); chỉ ghi log và trả lại lượt thư vừa tính
      this.logger.warn(
        `Chưa gửi được thư đặt lại mật khẩu cho tài khoản ${user.id}` +
          (r.reason === 'cap' ? ` (hết phần thư đặt lại mật khẩu của trang, còn ${r.retryAfterSec} giây)` : ''),
      );
      await this.redis.giveBack(...counted).catch(() => undefined);
    }
  }

  /**
   * Đặt lại mật khẩu bằng liên kết trong thư — chứng minh người làm là CHỦ HỘP THƯ: email được coi là đã xác thực
   * ('email'), khoá "nhập sai quá nhiều lần" của email được gỡ, trình duyệt này thành trình duyệt quen.
   * Liên kết Google/Facebook có thể do người khác tạo bằng email này (vd tài khoản Facebook khai email của người khác,
   * hoặc tài khoản Google chưa xác minh email) → khi email CHƯA được chủ hộp thư / Google chứng minh (emailProven) thì gỡ
   * MỌI liên kết; chủ email thật đăng nhập lại rồi liên kết từ trang hồ sơ. Trả về các dịch vụ vừa bị gỡ liên kết (để
   * trang web báo cho người dùng — vd tài khoản tự tạo bằng Facebook cũng bị gỡ liên kết Facebook).
   */
  async resetPassword(body: unknown, req: Request, res: Response): Promise<OAuthProvider[]> {
    const b = (body ?? {}) as Record<string, unknown>;
    const t = this.sessions.verifyPurposeToken(b.token, 'reset');
    if (!t) throw new BadRequestException('Liên kết đặt lại mật khẩu không hợp lệ hoặc đã hết hạn');
    const err = validatePassword(b.password);
    if (err) throw new BadRequestException(err);
    const user = await this.prisma.user.findUnique({ where: { id: t.userId } });
    // Dấu vân tay mật khẩu cũ: link chỉ dùng được một lần
    if (!user || user.isBot || user.isGuest || this.fingerprint(user.passwordHash) !== t.fp) {
      throw new BadRequestException('Liên kết đặt lại mật khẩu không hợp lệ hoặc đã được sử dụng');
    }
    const passwordHash = await passwords.hash(b.password as string, 'high');
    const proven = await this.emailProven(user);
    const removedLinks = await this.prisma.$transaction(async (tx) => {
      // Chỉ đổi khi mật khẩu vẫn là mật khẩu cũ: hai yêu cầu đồng thời với cùng liên kết chỉ một cái thành công
      const { count } = await tx.user.updateMany({
        where: { id: user.id, passwordHash: user.passwordHash },
        data: { passwordHash, emailVerifiedAt: user.emailVerifiedAt ?? new Date(), emailVerifiedVia: 'email' satisfies EmailVerifiedVia },
      });
      if (count !== 1) throw new BadRequestException('Liên kết đặt lại mật khẩu không hợp lệ hoặc đã được sử dụng');
      if (proven) return [];
      const links = await tx.oAuthAccount.findMany({ where: { userId: user.id }, select: { provider: true } });
      if (links.length) await tx.oAuthAccount.deleteMany({ where: { userId: user.id } });
      return links.map((l) => l.provider);
    });
    if (removedLinks.length) {
      this.logger.log(`Đặt lại mật khẩu: gỡ liên kết ${removedLinks.join(', ')} chưa được chứng minh của tài khoản ${user.id}`);
    }
    // Chủ hộp thư vừa chứng minh quyền: gỡ khoá "nhập sai quá nhiều lần" (người lạ có thể đã cố tình gây ra)
    await this.redis.client.del(`rl:login:${user.email}`).catch(() => undefined);
    const sids = await this.sessions.revokeAll(user.id);
    for (const sid of sids) this.realtime.disconnectSession(sid);
    this.sessions.rememberDevice(req, res, user.email, passwordHash);
    return [...new Set(removedLinks)].filter((p): p is OAuthProvider => p === 'google' || p === 'facebook');
  }
}
