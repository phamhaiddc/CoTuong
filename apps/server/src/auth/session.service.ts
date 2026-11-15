import { Injectable } from '@nestjs/common';
import type { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { createHash, createHmac, randomBytes } from 'crypto';
import { AppConfig } from '../config';
import { RealtimeService } from '../common/realtime.service';
import { RedisService } from '../common/redis.service';

interface SessionClaims {
  sub: string;
  sid: string;
  typ: 'session';
}

interface PurposeClaims {
  sub: string;
  typ: 'verify' | 'reset';
  /** verify: email cần xác thực; reset: dấu vân tay mật khẩu hiện tại (link dùng 1 lần) */
  fp: string;
}

const sessKey = (sid: string) => `sess:${sid}`;
/** Các phiên của một người: sorted set (điểm = thời điểm tạo, ms) — biết phiên nào cũ nhất để bỏ khi quá nhiều */
const userSessionsKey = (userId: string) => `u:sessions:${userId}`;
/** Khoá cũ (set, trước khi có giới hạn số phiên): chỉ còn đọc / dọn — phiên cũ vẫn huỷ được khi đổi mật khẩu, bị khoá… */
const legacyUserSessKey = (userId: string) => `u:sess:${userId}`;
/** Mỗi người giữ tối đa chừng này phiên đăng nhập cùng lúc; đăng nhập thêm thì phiên CŨ NHẤT bị huỷ */
export const MAX_SESSIONS_PER_USER = 20;

/**
 * Cookie "trình duyệt quen" (chỉ gửi tới /api/auth): đánh dấu trình duyệt đã từng đăng nhập thành công / đặt lại mật
 * khẩu cho một email. Người lạ nhập sai mật khẩu nhiều lần làm khoá email đó (10 lần / 15 phút) thì trình duyệt quen của
 * chủ tài khoản vẫn đăng nhập được (có giới hạn riêng). Giá trị: tối đa KNOWN_MAX dấu, không chứa email; không ai làm giả
 * được khi không có JWT_SECRET. Mỗi dấu 22 ký tự = 11 ký tự theo email (KNOWN_HALF — biết ngay, chưa cần tra DB) + 11 ký
 * tự theo email VÀ mật khẩu hiện tại (băm mật khẩu trong DB): đặt lại mật khẩu thì mọi dấu cũ thôi được tin — trình duyệt
 * từng đăng nhập bằng mật khẩu cũ (người lạ, máy dùng chung) không còn được miễn khoá theo email.
 */
export const KNOWN_DEVICE_COOKIE = 'ct_known';
const KNOWN_MAX = 5;
const KNOWN_TTL_MS = 180 * 86_400_000;
const KNOWN_HALF = 11;
const KNOWN_TAG_RE = /^[A-Za-z0-9_-]{22}$/;

/**
 * Phiên đăng nhập: JWT trong cookie httpOnly, kèm sid lưu ở Redis để có thể huỷ phiên
 * (đăng xuất, khoá tài khoản, đổi mật khẩu).
 */
@Injectable()
export class SessionService {
  constructor(
    private readonly cfg: AppConfig,
    private readonly redis: RedisService,
    private readonly realtime: RealtimeService,
  ) {}

  async create(userId: string): Promise<{ sid: string; token: string }> {
    const sid = randomBytes(18).toString('base64url');
    const ttl = this.cfg.sessionTtlSec;
    const now = Date.now();
    const zkey = userSessionsKey(userId);
    const res = await this.redis.client
      .multi()
      .set(sessKey(sid), userId, 'EX', ttl)
      .zadd(zkey, now, sid)
      // Phiên đã hết hạn tự nhiên: bỏ khỏi danh sách
      .zremrangebyscore(zkey, '-inf', now - ttl * 1000)
      .expire(zkey, ttl)
      .zcard(zkey)
      .exec();
    // MULTI không báo lỗi của từng lệnh: kiểm tra từng kết quả (vd SET … EX 0 bị từ chối thì phiên không tồn tại)
    const failed = !res ? new Error('giao dịch bị huỷ') : res.find(([e]) => e)?.[0];
    if (failed) throw new Error(`Không tạo được phiên đăng nhập: ${failed.message}`);
    const count = Number(res![4][1]);
    if (count > MAX_SESSIONS_PER_USER) await this.evictOldest(userId, sid, count - MAX_SESSIONS_PER_USER);
    const claims: SessionClaims = { sub: userId, sid, typ: 'session' };
    const token = jwt.sign(claims, this.cfg.jwtSecret, { expiresIn: ttl, algorithm: 'HS256' });
    return { sid, token };
  }

  /** Quá MAX_SESSIONS_PER_USER phiên: huỷ `n` phiên cũ nhất (không bao giờ huỷ phiên vừa tạo) và ngắt socket của chúng */
  private async evictOldest(userId: string, keepSid: string, n: number): Promise<void> {
    const zkey = userSessionsKey(userId);
    const popped = await this.redis.client.zpopmin(zkey, n);
    const sids = popped.filter((_, i) => i % 2 === 0);
    const old = sids.filter((s) => s !== keepSid);
    // Lệch đồng hồ giữa các instance (hiếm): phiên vừa tạo bị lấy ra thì ghi lại
    if (old.length !== sids.length) await this.redis.client.zadd(zkey, Date.now(), keepSid);
    if (!old.length) return;
    await this.redis.client.del(...old.map(sessKey));
    for (const sid of old) this.realtime.disconnectSession(sid);
  }

  async verify(token: string | undefined | null): Promise<{ userId: string; sid: string } | null> {
    if (!token) return null;
    let claims: SessionClaims;
    try {
      claims = jwt.verify(token, this.cfg.jwtSecret, { algorithms: ['HS256'] }) as SessionClaims;
    } catch {
      return null;
    }
    if (claims.typ !== 'session' || !claims.sid || !claims.sub) return null;
    const owner = await this.redis.client.get(sessKey(claims.sid));
    if (owner !== claims.sub) return null;
    return { userId: claims.sub, sid: claims.sid };
  }

  async revoke(userId: string, sid: string): Promise<void> {
    await this.redis.client
      .multi()
      .del(sessKey(sid))
      .zrem(userSessionsKey(userId), sid)
      .srem(legacyUserSessKey(userId), sid)
      .exec();
  }

  /** Huỷ mọi phiên của người chơi; trả về danh sách sid đã huỷ */
  async revokeAll(userId: string): Promise<string[]> {
    const [current, legacy] = await Promise.all([
      this.redis.client.zrange(userSessionsKey(userId), 0, -1),
      this.redis.client.smembers(legacyUserSessKey(userId)),
    ]);
    const sids = [...new Set([...current, ...legacy])];
    const multi = this.redis.client.multi();
    for (const sid of sids) multi.del(sessKey(sid));
    multi.del(userSessionsKey(userId), legacyUserSessKey(userId));
    await multi.exec();
    return sids;
  }

  setCookie(res: Response, token: string): void {
    res.cookie(this.cfg.cookieName, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.cfg.cookieSecure,
      path: '/',
      maxAge: this.cfg.sessionTtlSec * 1000,
    });
  }

  clearCookie(res: Response): void {
    res.clearCookie(this.cfg.cookieName, { httpOnly: true, sameSite: 'lax', secure: this.cfg.cookieSecure, path: '/' });
  }

  /* ---- Trình duyệt quen (xem KNOWN_DEVICE_COOKIE) ---- */

  /** Nửa đầu của dấu: theo email (đã chuẩn hoá) — HMAC với khoá tách từ JWT_SECRET */
  private knownEmailHalf(email: string): string {
    const key = createHash('sha256').update(`known-device:${this.cfg.jwtSecret}`).digest();
    return createHmac('sha256', key).update(email).digest('base64url').slice(0, KNOWN_HALF);
  }

  /** Cả dấu: nửa theo email + nửa theo (email, băm mật khẩu hiện tại) */
  private knownTag(email: string, passwordHash: string): string {
    const key = createHash('sha256').update(`known-device-pw:${this.cfg.jwtSecret}`).digest();
    const pw = createHmac('sha256', key).update(`${email}\n${passwordHash}`).digest('base64url').slice(0, KNOWN_HALF);
    return this.knownEmailHalf(email) + pw;
  }

  private knownTags(req: Request): string[] {
    const raw = (req as Request & { cookies?: Record<string, string> }).cookies?.[KNOWN_DEVICE_COOKIE];
    if (typeof raw !== 'string' || raw.length > 200) return [];
    return raw.split('.').filter((t) => KNOWN_TAG_RE.test(t)).slice(0, KNOWN_MAX);
  }

  /**
   * Trình duyệt có dấu của email này không (chỉ xét nửa theo email — chưa cần tra DB; dấu có thể đã cũ). Dùng để xếp
   * hàng ưu tiên lúc đăng nhập; được miễn khoá theo email thì phải qua isKnownDevice.
   */
  claimsKnownDevice(req: Request, email: string): boolean {
    const half = this.knownEmailHalf(email);
    return this.knownTags(req).some((t) => t.startsWith(half));
  }

  /** Trình duyệt này đã từng đăng nhập thành công bằng email này, với ĐÚNG mật khẩu hiện tại của tài khoản chưa */
  isKnownDevice(req: Request, email: string, passwordHash: string): boolean {
    return this.knownTags(req).includes(this.knownTag(email, passwordHash));
  }

  /**
   * Ghi nhớ trình duyệt này cho email với mật khẩu hiện tại (đưa lên đầu danh sách, thay dấu cũ của cùng email, giữ
   * KNOWN_MAX email gần nhất)
   */
  rememberDevice(req: Request, res: Response, email: string, passwordHash: string): void {
    const tag = this.knownTag(email, passwordHash);
    const half = this.knownEmailHalf(email);
    const tags = [tag, ...this.knownTags(req).filter((t) => !t.startsWith(half))].slice(0, KNOWN_MAX);
    res.cookie(KNOWN_DEVICE_COOKIE, tags.join('.'), {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.cfg.cookieSecure,
      path: '/api/auth',
      maxAge: KNOWN_TTL_MS,
    });
  }

  /** Quên mọi email đã ghi nhớ ở trình duyệt này (đăng xuất — máy dùng chung) */
  forgetDevice(res: Response): void {
    res.clearCookie(KNOWN_DEVICE_COOKIE, { httpOnly: true, sameSite: 'lax', secure: this.cfg.cookieSecure, path: '/api/auth' });
  }

  signPurposeToken(userId: string, typ: PurposeClaims['typ'], fp: string, expiresInSec: number): string {
    const claims: PurposeClaims = { sub: userId, typ, fp };
    return jwt.sign(claims, this.cfg.jwtSecret, { expiresIn: expiresInSec, algorithm: 'HS256' });
  }

  verifyPurposeToken(token: unknown, typ: PurposeClaims['typ']): { userId: string; fp: string } | null {
    if (typeof token !== 'string' || !token) return null;
    try {
      const c = jwt.verify(token, this.cfg.jwtSecret, { algorithms: ['HS256'] }) as PurposeClaims;
      if (c.typ !== typ || !c.sub) return null;
      return { userId: c.sub, fp: c.fp };
    } catch {
      return null;
    }
  }
}
