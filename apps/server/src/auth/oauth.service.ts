import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { createHmac, randomBytes, randomInt } from 'crypto';
import type { User } from '@prisma/client';
import { normalizeEmail, usernameKey, validateEmail, validateUsername, type OAuthProvider } from '@cotuong/shared';
import { AppConfig, type OAuthProviderConfig } from '../config';
import { PrismaService } from '../common/prisma.service';
import { RedisService } from '../common/redis.service';
import { isReservedBotEmail } from '../bots/bot-accounts';
import { AuthService } from './auth.service';
import { SessionService } from './session.service';
import { passwords } from './password.service';
import type { EmailVerifiedVia } from './auth.types';
import { ipBucket } from '../common/net';

/** Mã lỗi gửi về trang đăng nhập (?oauthError=...) — trang web hiển thị câu tiếng Việt tương ứng */
export type OAuthErrorCode =
  | 'disabled'
  | 'state'
  | 'denied'
  | 'exchange'
  | 'no_email'
  | 'email_exists'
  | 'banned'
  | 'in_match'
  | 'rate'
  // Liên kết từ trang hồ sơ
  | 'login_required'
  | 'link_taken'
  | 'already_linked';

class OAuthFailure extends Error {
  constructor(readonly code: OAuthErrorCode, detail?: string) {
    super(detail ?? code);
  }
}

interface OAuthProfile {
  providerUserId: string;
  email: string | null;
  /** Nhà cung cấp xác nhận email đã được xác minh (Google email_verified) — điều kiện để TỰ LIÊN KẾT tài khoản có sẵn */
  emailVerified: boolean;
  /**
   * Coi email là đã xác thực khi TẠO tài khoản mới (theo yêu cầu chủ sản phẩm 11/11/2026: đăng nhập bằng Google /
   * Facebook không phải xác thực email lại). Google: email_verified. Facebook: có trả email — tài liệu Graph API ghi
   * "không trả trường này nếu không có email hợp lệ" (không ghi rõ là đã xác nhận), nên KHÔNG dùng để tự liên kết.
   */
  trustedEmail: boolean;
  name: string;
}

export const OAUTH_STATE_COOKIE = 'ct_oauth';
const STATE_TTL_SEC = 600;
const isProvider = (p: unknown): p is OAuthProvider => p === 'google' || p === 'facebook';

/**
 * Đăng nhập bằng Google / Facebook (OAuth 2.0, "authorization code", trao đổi mã ở server).
 *
 * Liên kết tài khoản:
 *  - Đã liên kết trước đó (provider + mã người dùng phía nhà cung cấp) → đăng nhập.
 *  - Chưa liên kết, email trùng tài khoản có sẵn: CHỈ tự liên kết khi Google xác nhận email đã xác minh
 *    (email_verified) VÀ email của tài khoản có sẵn đã được chủ hộp thư / Google chứng minh (AuthService.emailProven —
 *    không tính email chỉ được tin vì Facebook trả về). Facebook thì không tự liên kết (tránh chiếm tài khoản) — báo
 *    người dùng đăng nhập bằng cách cũ rồi liên kết từ trang hồ sơ.
 *  - Email chưa có tài khoản → tạo tài khoản mới (mật khẩu ngẫu nhiên không dùng được; đặt mật khẩu qua "Quên mật
 *    khẩu" nếu muốn). Email Google đã xác minh / email Facebook trả về → coi như đã xác thực (ghi lại cách xác thực:
 *    'google' / 'facebook'); còn lại → gửi email xác thực như đăng ký thường. Email chỉ được tin nhờ Facebook: chủ hộp
 *    thư thật dùng "Quên mật khẩu" thì mọi liên kết Google/Facebook của tài khoản bị gỡ (AuthService.resetPassword).
 */
@Injectable()
export class OAuthService {
  private readonly logger = new Logger('OAuth');

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly sessions: SessionService,
    private readonly auth: AuthService,
    private readonly cfg: AppConfig,
  ) {}

  enabled(): Record<OAuthProvider, boolean> {
    return { google: !!this.cfg.oauth.google, facebook: !!this.cfg.oauth.facebook };
  }

  private provider(p: unknown): { name: OAuthProvider; c: OAuthProviderConfig } {
    if (!isProvider(p)) throw new OAuthFailure('disabled');
    const c = this.cfg.oauth[p];
    if (!c) throw new OAuthFailure('disabled');
    return { name: p, c };
  }

  private redirectUri(p: OAuthProvider): string {
    return `${this.cfg.appUrl}/api/auth/oauth/${p}/callback`;
  }

  /** Đường dẫn quay về sau khi đăng nhập: chỉ đường dẫn nội bộ (chống chuyển hướng ra ngoài) */
  private safeFrom(from: unknown): string {
    if (typeof from !== 'string' || !from.startsWith('/') || from.startsWith('//') || from.includes('\\')) return '/';
    if (from.startsWith('/login') || from.startsWith('/register') || from.startsWith('/api/')) return '/';
    return from.slice(0, 300);
  }

  private fail(res: Response, code: OAuthErrorCode): void {
    res.redirect(302, `${this.cfg.appUrl}/login?oauthError=${code}`);
  }

  /** Quay về trang nội bộ `path` kèm tham số (dùng cho luồng liên kết từ trang hồ sơ) */
  private back(res: Response, path: string, params: Record<string, string>): void {
    const u = new URL(this.cfg.appUrl + this.safeFrom(path));
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    res.redirect(302, u.toString());
  }

  /** Bước 1: chuyển người dùng sang trang đồng ý của nhà cung cấp */
  async start(provider: unknown, from: unknown, req: Request, res: Response, mode?: unknown): Promise<void> {
    const linking = mode === 'link';
    try {
      const { name, c } = this.provider(provider);
      if ((await this.redis.hit(`rl:oauth:${ipBucket(req.ip)}`, 600)) > 30) throw new OAuthFailure('rate');
      // Liên kết từ trang hồ sơ: phải đang đăng nhập; ghi nhớ tài khoản cần liên kết
      let linkUserId: string | null = null;
      if (linking) {
        const me = await this.auth.memberFromRequest(req);
        if (!me) throw new OAuthFailure('login_required');
        linkUserId = me.id;
      }
      const state = randomBytes(24).toString('base64url');
      await this.redis.client.set(
        `oauth:state:${state}`,
        JSON.stringify({ provider: name, from: this.safeFrom(from), ...(linkUserId ? { linkUserId } : {}) }),
        'EX',
        STATE_TTL_SEC,
      );
      res.cookie(OAUTH_STATE_COOKIE, state, {
        httpOnly: true,
        sameSite: 'lax',
        secure: this.cfg.cookieSecure,
        path: '/api/auth/oauth',
        maxAge: STATE_TTL_SEC * 1000,
      });
      const url = new URL(c.authUrl);
      url.searchParams.set('client_id', c.clientId);
      url.searchParams.set('redirect_uri', this.redirectUri(name));
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('scope', c.scope);
      url.searchParams.set('state', state);
      this.logger.log(`${name}: bắt đầu ${linking ? 'liên kết' : 'đăng nhập'} → chuyển sang ${url.host}`);
      res.redirect(302, url.toString());
    } catch (e) {
      const code = e instanceof OAuthFailure ? e.code : 'exchange';
      this.logger.warn(`${String(provider).slice(0, 20)}: không bắt đầu được (${code}) ${e instanceof OAuthFailure ? '' : (e as Error).message}`);
      if (linking && code !== 'login_required') this.back(res, typeof from === 'string' ? from : '/', { oauthError: code });
      else this.fail(res, code);
    }
  }

  /** Bước 2: nhà cung cấp chuyển về với mã; đổi mã lấy thông tin người dùng, đăng nhập */
  async callback(provider: unknown, query: Record<string, unknown>, req: Request, res: Response): Promise<void> {
    const cookies = (req as Request & { cookies?: Record<string, string> }).cookies ?? {};
    res.clearCookie(OAUTH_STATE_COOKIE, { httpOnly: true, sameSite: 'lax', secure: this.cfg.cookieSecure, path: '/api/auth/oauth' });
    try {
      const { name, c } = this.provider(provider);
      const state = typeof query.state === 'string' ? query.state : '';
      if (!state || cookies[OAUTH_STATE_COOKIE] !== state) throw new OAuthFailure('state');
      const raw = await this.redis.client.getdel(`oauth:state:${state}`);
      const saved = raw ? (JSON.parse(raw) as { provider: string; from: string; linkUserId?: string }) : null;
      if (!saved || saved.provider !== name) throw new OAuthFailure('state');
      if (saved.linkUserId) {
        await this.finishLink(name, c, { from: saved.from, linkUserId: saved.linkUserId }, query, req, res);
        return;
      }
      if (typeof query.error === 'string') throw new OAuthFailure('denied', query.error);
      const code = typeof query.code === 'string' ? query.code : '';
      if (!code) throw new OAuthFailure('denied');
      const profile = await this.fetchProfile(name, c, code);
      const user = await this.resolveUser(name, profile);
      // Tài khoản máy chơi không đăng nhập được (resolveUser cũng không liên kết với máy)
      if (user.isBot) throw new OAuthFailure('email_exists');
      if (user.isBanned) throw new OAuthFailure('banned');
      try {
        await this.auth.ensureNotPlayingElsewhere(user.id);
      } catch {
        throw new OAuthFailure('in_match');
      }
      const { sid, token } = await this.sessions.create(user.id);
      // Liên kết vừa bị gỡ (đặt lại mật khẩu huỷ mọi phiên + gỡ liên kết) / tài khoản vừa bị khoá trong lúc đăng nhập:
      // huỷ phiên vừa tạo — như kiểm tra sau khi tạo phiên của đăng nhập bằng mật khẩu
      const still = await this.prisma.oAuthAccount.findUnique({
        where: { provider_providerUserId: { provider: name, providerUserId: profile.providerUserId } },
        include: { user: { select: { isBanned: true } } },
      });
      if (!still || still.userId !== user.id || still.user.isBanned) {
        await this.sessions.revoke(user.id, sid);
        throw new OAuthFailure(still?.user.isBanned ? 'banned' : 'state');
      }
      this.sessions.setCookie(res, token);
      this.logger.log(`${name}: đăng nhập thành công (tài khoản ${user.id})`);
      res.redirect(302, `${this.cfg.appUrl}${saved.from}`);
    } catch (e) {
      // Ghi lý do thất bại để chẩn đoán (không ghi email / mã); nhà cung cấp có thể gửi kèm error_reason / error_description
      const failCode = e instanceof OAuthFailure ? e.code : 'exchange';
      const clip = (v: unknown) => (typeof v === 'string' ? v.replace(/[\r\n]+/g, ' ').slice(0, 200) : '');
      const detail = [clip(e instanceof Error ? e.message : ''), clip(query.error_reason), clip(query.error_description)]
        .filter(Boolean)
        .join(' | ');
      this.logger.warn(`callback ${String(provider).slice(0, 20)}: thất bại (${failCode})${detail ? ` — ${detail}` : ''}`);
      this.fail(res, failCode);
    }
  }

  /** Kết thúc liên kết Google/Facebook vào tài khoản đang đăng nhập (bắt đầu từ trang hồ sơ) */
  private async finishLink(
    name: OAuthProvider,
    c: OAuthProviderConfig,
    saved: { from: string; linkUserId: string },
    query: Record<string, unknown>,
    req: Request,
    res: Response,
  ): Promise<void> {
    try {
      // Vẫn phải là đúng người đã bấm "Liên kết" (cùng trình duyệt, còn đăng nhập)
      const me = await this.auth.memberFromRequest(req);
      if (!me || me.id !== saved.linkUserId) throw new OAuthFailure('login_required');
      if (typeof query.error === 'string') throw new OAuthFailure('denied', query.error);
      const code = typeof query.code === 'string' ? query.code : '';
      if (!code) throw new OAuthFailure('denied');
      const profile = await this.fetchProfile(name, c, code);
      const taken = await this.prisma.oAuthAccount.findUnique({
        where: { provider_providerUserId: { provider: name, providerUserId: profile.providerUserId } },
      });
      if (taken && taken.userId !== me.id) throw new OAuthFailure('link_taken');
      if (!taken) {
        const mine = await this.prisma.oAuthAccount.findFirst({ where: { userId: me.id, provider: name } });
        if (mine) throw new OAuthFailure('already_linked');
        await this.prisma.oAuthAccount.create({ data: { provider: name, providerUserId: profile.providerUserId, userId: me.id } });
        this.logger.log(`Liên kết ${name} vào tài khoản ${me.id}`);
      }
      this.back(res, saved.from, { oauthLinked: name });
    } catch (e) {
      const code = e instanceof OAuthFailure ? e.code : 'exchange';
      if (!(e instanceof OAuthFailure) || code === 'exchange') this.logger.warn(`liên kết ${name}: ${(e as Error).message}`);
      if (code === 'login_required') this.fail(res, code);
      else this.back(res, saved.from, { oauthError: code });
    }
  }

  /** Các nhà cung cấp đã liên kết với tài khoản */
  async links(userId: string): Promise<Record<OAuthProvider, boolean>> {
    const rows = await this.prisma.oAuthAccount.findMany({ where: { userId }, select: { provider: true } });
    return { google: rows.some((r) => r.provider === 'google'), facebook: rows.some((r) => r.provider === 'facebook') };
  }

  /** Huỷ liên kết; không cho huỷ cách đăng nhập cuối cùng khi email chưa xác thực (tránh tự khoá mình ngoài tài khoản) */
  async unlink(userId: string, provider: unknown): Promise<void> {
    if (!isProvider(provider)) throw new BadRequestException('Không rõ là Google hay Facebook');
    const user = await this.prisma.user.findUnique({ where: { id: userId }, include: { oauthAccounts: true } });
    const link = user?.oauthAccounts.find((a) => a.provider === provider);
    if (!user || !link) throw new BadRequestException('Tài khoản chưa liên kết với dịch vụ này');
    if (!user.emailVerifiedAt && user.oauthAccounts.length === 1) {
      throw new BadRequestException(
        'Bạn cần xác thực email trước khi huỷ liên kết này — nếu không, bạn có thể không đăng nhập lại được.',
      );
    }
    await this.prisma.oAuthAccount.delete({ where: { id: link.id } });
  }

  private async fetchJson(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
    const text = await r.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    if (!r.ok || !body || typeof body !== 'object') throw new OAuthFailure('exchange', `HTTP ${r.status} từ ${new URL(url).host}`);
    return body as Record<string, unknown>;
  }

  private async fetchProfile(name: OAuthProvider, c: OAuthProviderConfig, code: string): Promise<OAuthProfile> {
    const form = {
      code,
      client_id: c.clientId,
      client_secret: c.clientSecret,
      redirect_uri: this.redirectUri(name),
      grant_type: 'authorization_code',
    };
    let accessToken: unknown;
    if (name === 'google') {
      const tok = await this.fetchJson(c.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form).toString(),
      });
      accessToken = tok.access_token;
    } else {
      const url = new URL(c.tokenUrl);
      for (const [k, v] of Object.entries(form)) if (k !== 'grant_type') url.searchParams.set(k, v);
      accessToken = (await this.fetchJson(url.toString())).access_token;
    }
    if (typeof accessToken !== 'string' || !accessToken) throw new OAuthFailure('exchange', 'không có access_token');
    let profileUrl = c.profileUrl;
    if (name === 'facebook') {
      // Graph API nhận access_token qua tham số; appsecret_proof = HMAC-SHA256(access_token, app secret)
      // để chạy được cả khi ứng dụng bật "Require App Secret"
      const u = new URL(c.profileUrl);
      u.searchParams.set('access_token', accessToken);
      u.searchParams.set('appsecret_proof', createHmac('sha256', c.clientSecret).update(accessToken).digest('hex'));
      profileUrl = u.toString();
    }
    const p = await this.fetchJson(profileUrl, { headers: { authorization: `Bearer ${accessToken}` } });
    const id = name === 'google' ? p.sub : p.id;
    if (typeof id !== 'string' && typeof id !== 'number') throw new OAuthFailure('exchange', 'thiếu mã người dùng');
    // Email sai định dạng hoặc thuộc tên miền dành riêng cho tài khoản máy: coi như không có email dùng được
    const email =
      typeof p.email === 'string' && !validateEmail(p.email) && !isReservedBotEmail(p.email) ? normalizeEmail(p.email) : null;
    return {
      providerUserId: String(id).slice(0, 191),
      email,
      // Google: email_verified; Facebook: không dựa vào để tự liên kết tài khoản có sẵn
      emailVerified: name === 'google' && (p.email_verified === true || p.email_verified === 'true'),
      trustedEmail: email !== null && (name === 'facebook' || p.email_verified === true || p.email_verified === 'true'),
      name: typeof p.name === 'string' ? p.name : '',
    };
  }

  private async resolveUser(provider: OAuthProvider, profile: OAuthProfile): Promise<User> {
    const linked = await this.prisma.oAuthAccount.findUnique({
      where: { provider_providerUserId: { provider, providerUserId: profile.providerUserId } },
      include: { user: true },
    });
    // Cách xác thực ghi lại khi tin email này: Google xác minh = 'google'; còn lại (Facebook trả email) = 'facebook'
    const via: EmailVerifiedVia = profile.emailVerified ? 'google' : 'facebook';
    if (linked) {
      // Tài khoản tạo từ mạng xã hội trước đây còn chưa xác thực: đăng nhập lại bằng đúng email đó thì coi là đã xác thực.
      // Ghi rõ cách xác thực — nếu là nhờ Facebook (vd liên kết Facebook khai email người khác vào tài khoản Google chưa
      // xác minh), chủ hộp thư thật đặt lại mật khẩu vẫn gỡ được mọi liên kết lạ
      const u = linked.user;
      if (!u.emailVerifiedAt && profile.trustedEmail && profile.email === u.email && !u.isBot && !u.isGuest) {
        return this.prisma.user.update({ where: { id: u.id }, data: { emailVerifiedAt: new Date(), emailVerifiedVia: via } });
      }
      return u;
    }
    if (!profile.email) throw new OAuthFailure('no_email');
    const existing = await this.prisma.user.findUnique({ where: { email: profile.email } });
    if (existing) {
      // Chỉ tự liên kết khi CẢ HAI phía đã chứng minh email: Google xác minh + email của tài khoản có sẵn đã được chủ hộp
      // thư / Google chứng minh. Tài khoản chưa xác thực có thể do người khác đăng ký trước bằng email này (họ vẫn biết
      // mật khẩu, còn phiên); tài khoản chỉ được tin nhờ Facebook có thể do người khác tạo — người dùng Google này (chủ
      // hộp thư) dùng "Quên mật khẩu" trước (gỡ liên kết lạ), sau đó Google tự liên kết được.
      if (!profile.emailVerified || existing.isBot || existing.isGuest || !(await this.auth.emailProven(existing))) {
        throw new OAuthFailure('email_exists');
      }
      await this.prisma.oAuthAccount.create({ data: { provider, providerUserId: profile.providerUserId, userId: existing.id } });
      return existing;
    }
    const username = await this.uniqueUsername(profile.name);
    // Mật khẩu "không dùng được" (đặt mật khẩu thật qua "Quên mật khẩu") — không tốn CPU như băm thật
    const passwordHash = passwords.unusableHash();
    const user = await this.prisma.user.create({
      data: {
        username,
        usernameKey: usernameKey(username),
        email: profile.email,
        passwordHash,
        emailVerifiedAt: profile.trustedEmail ? new Date() : null,
        emailVerifiedVia: profile.trustedEmail ? via : null,
        oauthAccounts: { create: { provider, providerUserId: profile.providerUserId } },
      },
    });
    if (!profile.trustedEmail) await this.auth.sendVerificationTo(user).catch(() => undefined);
    return user;
  }

  /** Tên hiển thị hợp lệ, chưa ai dùng, dựng từ tên ở mạng xã hội */
  private async uniqueUsername(raw: string): Promise<string> {
    let base = raw
      .normalize('NFC')
      .replace(/[^\p{L}\p{N} _.-]/gu, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 20)
      .trim();
    if (validateUsername(base)) base = 'Người chơi';
    for (let i = 0; i < 20; i++) {
      const sfx = String(randomInt(100, 100_000));
      const name = i === 0 ? base : `${base.slice(0, 19 - sfx.length).trim()} ${sfx}`;
      if (validateUsername(name)) continue;
      const taken = await this.prisma.user.findUnique({ where: { usernameKey: usernameKey(name) } });
      if (!taken) return name;
    }
    return `Người chơi ${randomInt(100_000, 1_000_000)}`;
  }
}
