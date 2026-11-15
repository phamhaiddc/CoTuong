import { existsSync, readFileSync } from 'fs';
import { hostname } from 'os';
import { join, resolve } from 'path';
import { randomBytes } from 'crypto';
import { BOT_FALLBACK_WAIT_MS, BOT_MAX_ONLINE_HUMANS, DEFAULT_TIERS, deserializeTiers, validateTiers, type TierDef } from '@cotuong/shared';

/** Bí mật JWT mẫu (công khai trong mã nguồn): chỉ chấp nhận khi chạy trên localhost, không phải production */
const DEV_JWT_SECRET = 'dev-only-change-me-please-0123456789abcdef';

/** TRUST_PROXY: "true"/"false", số tầng proxy, hoặc chuỗi Express hiểu (vd "loopback", "10.0.0.0/8") */
function parseTrustProxy(raw: string | undefined): boolean | number | string {
  const v = raw?.trim();
  if (!v) return 'loopback';
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^\d+$/.test(v)) return Number(v);
  return v;
}

/** Đọc file .env đơn giản (KEY=VALUE, hỗ trợ "..."), không ghi đè biến đã có */
function loadDotEnv(file: string): void {
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function env(key: string, fallback?: string): string {
  const v = process.env[key];
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`Thiếu biến môi trường ${key}`);
  }
  return v;
}

/**
 * Bật/tắt viết chặt: chỉ nhận true/false/1/0 (không phân biệt hoa thường, vd "True" = true); giá trị khác → lỗi khi
 * khởi động. Để trống / không đặt → giá trị mặc định.
 */
function strictBool(key: string, fallback: boolean): boolean {
  const v = process.env[key]?.trim().toLowerCase();
  if (!v) return fallback;
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  throw new Error(`${key} chỉ nhận true / false (hoặc 1 / 0)`);
}

/** Số nguyên dương (≥ 1); viết sai → lỗi khi khởi động */
function positiveInt(key: string, fallback: number): number {
  const raw = env(key, String(fallback)).trim();
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < 1) throw new Error(`${key} phải là số nguyên >= 1`);
  return n;
}

/** Số dương (có thể lẻ, vd 0.5); viết sai / ≤ 0 → lỗi khi khởi động */
function positiveNumber(key: string, fallback: number): number {
  const raw = env(key, String(fallback)).trim();
  const n = Number(raw);
  if (!/^\d+(\.\d+)?$/.test(raw) || !Number.isFinite(n) || n <= 0) throw new Error(`${key} phải là số > 0`);
  return n;
}

export interface OAuthProviderConfig {
  clientId: string;
  clientSecret: string;
  authUrl: string;
  tokenUrl: string;
  profileUrl: string;
  scope: string;
}

export class AppConfig {
  readonly isProd: boolean;
  readonly port: number;
  readonly appUrl: string;
  readonly databaseUrl: string;
  readonly redisUrl: string;
  readonly jwtSecret: string;
  readonly sessionTtlSec: number;
  readonly cookieName = 'ct_session';
  readonly cookieSecure: boolean;
  /**
   * Express "trust proxy": tin X-Forwarded-For từ đâu (ảnh hưởng IP dùng để giới hạn số lần thử).
   * Mặc định "loopback" (proxy chạy cùng máy, vd nginx/Vite). Sau load balancer: số tầng proxy (vd 1) hoặc dải IP.
   */
  readonly trustProxy: boolean | number | string;
  /** replyTo: địa chỉ nhận thư trả lời (MAIL_REPLY_TO; null = không đặt, thư trả lời về MAIL_FROM) */
  readonly smtp: {
    host: string | null;
    port: number;
    secure: boolean;
    user: string | null;
    pass: string | null;
    from: string;
    replyTo: string | null;
  };
  /**
   * Trần số thư toàn trang (mọi instance cộng chung qua Redis) — giữ dưới hạn mức của nhà cung cấp SMTP.
   * MAIL_MAX_PER_HOUR (mặc định 100) / MAIL_MAX_PER_DAY (mặc định 400, cửa sổ 24 giờ tính từ thư đầu tiên).
   * Trần chia phần cho từng loại thư (MailService, MAIL_SHARE_PCT): mã đăng ký 70%, đặt lại mật khẩu 20%, liên kết xác
   * thực 10% — loại này dùng hết phần của mình cũng không lấn sang phần của loại khác.
   */
  readonly mailMaxPerHour: number;
  readonly mailMaxPerDay: number;
  /**
   * Mở POST /api/auth/register cũ (tạo tài khoản CHƯA xác thực email trong một bước — smoke test còn dùng).
   * ALLOW_LEGACY_REGISTER=true/false; mặc định bật khi NODE_ENV khác production, tắt ở production.
   */
  readonly allowLegacyRegister: boolean;
  readonly s3: {
    endpoint: string | null;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    forcePathStyle: boolean;
  } | null;
  readonly tiers: TierDef[];
  /**
   * Đăng nhập mạng xã hội (OAuth 2.0). Chỉ bật khi có đủ mã ứng dụng; địa chỉ của nhà cung cấp có thể đổi qua
   * biến môi trường (dùng cho kiểm thử bằng máy chủ OAuth giả).
   */
  readonly oauth: {
    google: OAuthProviderConfig | null;
    facebook: OAuthProviderConfig | null;
  };
  readonly instanceId: string;
  readonly webDistDir: string | null;
  /**
   * Hàng chờ xếp hạng: chờ bao lâu (ms) thì ghép với tài khoản máy; null = tắt.
   * Biến môi trường BOT_FALLBACK_SEC (mặc định 30; 0 = tắt).
   */
  readonly botFallbackMs: number | null;
  /**
   * Có NHIỀU HƠN số thành viên (có tài khoản, không tính khách) đang online này trên toàn hệ thống thì không ghép với
   * tài khoản máy nữa.
   * Biến môi trường BOT_MAX_ONLINE_HUMANS (mặc định 50).
   */
  readonly botMaxOnlineHumans: number;

  constructor() {
    loadDotEnv(join(process.cwd(), '.env'));
    loadDotEnv(join(__dirname, '..', '.env'));
    this.isProd = env('NODE_ENV', 'development') === 'production';
    this.port = parseInt(env('PORT', '3000'), 10);
    this.appUrl = env('APP_URL', 'http://localhost:5173').replace(/\/$/, '');
    this.databaseUrl = env('DATABASE_URL');
    this.redisUrl = env('REDIS_URL', 'redis://localhost:6379');
    this.jwtSecret = env('JWT_SECRET', this.isProd ? undefined : DEV_JWT_SECRET);
    if (this.isProd && this.jwtSecret.length < 32) throw new Error('JWT_SECRET phải dài ít nhất 32 ký tự ở production');
    // Bí mật mẫu (công khai trong mã nguồn / .env.example) chỉ được dùng khi chạy trên máy cá nhân (localhost)
    const appHost = new URL(this.appUrl).hostname;
    const localApp = appHost === 'localhost' || appHost === '127.0.0.1' || appHost === '[::1]';
    if (this.jwtSecret === DEV_JWT_SECRET && (this.isProd || !localApp)) {
      throw new Error('JWT_SECRET đang là giá trị mẫu — đặt một chuỗi ngẫu nhiên dài ≥ 32 ký tự khi chạy ngoài localhost');
    }
    this.trustProxy = parseTrustProxy(process.env.TRUST_PROXY);
    // Hạn phiên đăng nhập (ngày, mặc định 7): 0 / số âm / chữ → lỗi khi khởi động (trước đây server vẫn chạy nhưng
    // không ai giữ được phiên đăng nhập); tối thiểu 1 phút
    this.sessionTtlSec = Math.round(positiveNumber('SESSION_TTL_DAYS', 7) * 86_400);
    if (this.sessionTtlSec < 60) throw new Error('SESSION_TTL_DAYS quá nhỏ (phiên đăng nhập phải dài ít nhất 1 phút)');
    // COOKIE_SECURE=true/false: cookie chỉ gửi qua HTTPS (kèm header HSTS). Mặc định bật khi chạy production HOẶC trang
    // chạy bằng https (kể cả quên đặt NODE_ENV=production); chỉ nên tắt khi thử production qua http://localhost
    this.cookieSecure = strictBool('COOKIE_SECURE', this.isProd || this.appUrl.startsWith('https://'));
    this.smtp = {
      host: process.env.SMTP_HOST || null,
      port: parseInt(env('SMTP_PORT', '587'), 10),
      secure: strictBool('SMTP_SECURE', false),
      user: process.env.SMTP_USER || null,
      pass: process.env.SMTP_PASS || null,
      from: env('MAIL_FROM', 'Xe Pháo Mã <no-reply@cotuong.local>'),
      replyTo: process.env.MAIL_REPLY_TO?.trim() || null,
    };
    this.mailMaxPerHour = positiveInt('MAIL_MAX_PER_HOUR', 100);
    this.mailMaxPerDay = positiveInt('MAIL_MAX_PER_DAY', 400);
    this.allowLegacyRegister = strictBool('ALLOW_LEGACY_REGISTER', !this.isProd);
    this.s3 = process.env.S3_BUCKET
      ? {
          endpoint: process.env.S3_ENDPOINT || null,
          region: env('S3_REGION', 'us-east-1'),
          bucket: env('S3_BUCKET'),
          accessKeyId: env('S3_ACCESS_KEY_ID', ''),
          secretAccessKey: env('S3_SECRET_ACCESS_KEY', ''),
          forcePathStyle: strictBool('S3_FORCE_PATH_STYLE', true),
        }
      : null;
    this.tiers = DEFAULT_TIERS;
    if (process.env.TIERS_JSON) {
      const tiers = deserializeTiers(JSON.parse(process.env.TIERS_JSON));
      const err = validateTiers(tiers);
      if (err) throw new Error(`TIERS_JSON không hợp lệ: ${err}`);
      this.tiers = tiers;
    }
    const google = process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET;
    const facebook = process.env.FACEBOOK_APP_ID && process.env.FACEBOOK_APP_SECRET;
    this.oauth = {
      google: google
        ? {
            clientId: env('GOOGLE_CLIENT_ID'),
            clientSecret: env('GOOGLE_CLIENT_SECRET'),
            authUrl: env('GOOGLE_AUTH_URL', 'https://accounts.google.com/o/oauth2/v2/auth'),
            tokenUrl: env('GOOGLE_TOKEN_URL', 'https://oauth2.googleapis.com/token'),
            profileUrl: env('GOOGLE_USERINFO_URL', 'https://openidconnect.googleapis.com/v1/userinfo'),
            scope: 'openid email profile',
          }
        : null,
      facebook: facebook
        ? {
            clientId: env('FACEBOOK_APP_ID'),
            clientSecret: env('FACEBOOK_APP_SECRET'),
            // Không ghi phiên bản Graph API: Facebook dùng phiên bản mặc định của ứng dụng; có thể ghim bằng biến môi trường
            authUrl: env('FACEBOOK_AUTH_URL', 'https://www.facebook.com/dialog/oauth'),
            tokenUrl: env('FACEBOOK_TOKEN_URL', 'https://graph.facebook.com/oauth/access_token'),
            profileUrl: env('FACEBOOK_PROFILE_URL', 'https://graph.facebook.com/me?fields=id,name,email'),
            scope: 'email,public_profile',
          }
        : null,
    };
    this.instanceId = `${hostname()}-${process.pid}-${randomBytes(3).toString('hex')}`;
    const dist = process.env.WEB_DIST_DIR ? resolve(process.cwd(), process.env.WEB_DIST_DIR) : null;
    this.webDistDir = dist && existsSync(join(dist, 'index.html')) ? dist : null;
    const botSec = parseFloat(env('BOT_FALLBACK_SEC', String(BOT_FALLBACK_WAIT_MS / 1000)));
    if (!Number.isFinite(botSec) || botSec < 0) throw new Error('BOT_FALLBACK_SEC phải là số giây >= 0');
    this.botFallbackMs = botSec === 0 ? null : Math.round(botSec * 1000);
    const maxOnline = parseInt(env('BOT_MAX_ONLINE_HUMANS', String(BOT_MAX_ONLINE_HUMANS)), 10);
    if (!Number.isInteger(maxOnline) || maxOnline < 0) throw new Error('BOT_MAX_ONLINE_HUMANS phải là số nguyên >= 0');
    this.botMaxOnlineHumans = maxOnline;
  }
}
