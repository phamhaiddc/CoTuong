/**
 * Kiểm thử đầu-cuối trên server đang chạy (cần docker-compose + server GỬI THƯ TỚI MAILPIT).
 *   npm run smoke -w @cotuong/server            (nhanh)
 *   npm run smoke -w @cotuong/server -- --slow  (thêm luật 30 giây nước đầu và 60 giây mất kết nối)
 * Biến môi trường:
 *   SMOKE_BASE    địa chỉ server (mặc định http://localhost:3000 — server dev đọc cùng apps/server/.env)
 *   REDIS_URL     Redis của CHÍNH server đó (smoke xoá khoá chờ "Gửi lại mã", đọc bộ đếm). BẮT BUỘC khi đặt SMOKE_BASE;
 *                 không đặt SMOKE_BASE thì lấy từ apps/server/.env
 *   MAILPIT_URL   Mailpit để đọc thư (mặc định http://localhost:8025)
 *   DATABASE_URL  (tuỳ chọn) PostgreSQL của server; thiếu thì lấy từ apps/server/.env (dùng chung DB thì không cần đặt)
 * An toàn: KHÔNG chạy vào server gửi thư thật (Gmail…). Trước mọi kiểm tra, smoke gửi một mã tới địa chỉ @test.local và
 * dừng nếu server trả 503 mail_unavailable hoặc thư không tới Mailpit trong ~10 giây. Nhắm server mặc định mà SMTP_HOST
 * trong apps/server/.env không phải máy này thì từ chối chạy ngay (chưa gửi gì).
 * Mỗi lần chạy dùng IP giả mới (X-Forwarded-For, dải địa chỉ dành cho tài liệu) → giới hạn theo IP không dồn qua các lần
 * chạy; server phải tin header này (mặc định TRUST_PROXY=loopback khi smoke chạy cùng máy). Server không tin thì các kiểm
 * tra cần nhiều IP bị bỏ qua và mọi yêu cầu tính cho một IP (chỉ chạy được vài lần mỗi giờ).
 * Tạo nhanh tài khoản thử bằng POST /api/auth/register kiểu cũ → server cần ALLOW_LEGACY_REGISTER bật (mặc định bật khi
 * NODE_ENV khác production).
 */
import { io, type Socket } from 'socket.io-client';
import sharp from 'sharp';
import Redis from 'ioredis';
import { randomBytes, randomInt } from 'crypto';
import { createJieqiGame, randomJieqiSetup } from '@cotuong/game-core';
import { LEADERBOARD_MIN_GAMES, mailboxKey, type MatchEndedDto, type MatchStateDto, type MoveEventDto } from '@cotuong/shared';
import { AppConfig } from '../config';
import { ipBucket } from '../common/net';
import { shareOf, type MailKind } from '../common/mail.service';
// Không import tĩnh @prisma/client: chỉ cần nạp thư viện này là Prisma đã đọc apps/server/.env vào process.env, khi đó
// không còn biết REDIS_URL / DATABASE_URL có được đặt thật trong môi trường hay không → nạp muộn trong main().

const BASE = process.env.SMOKE_BASE || 'http://localhost:3000';
const MAILPIT = process.env.MAILPIT_URL || 'http://localhost:8025';
const SLOW = process.argv.includes('--slow');
/** regId server cấp ở bước 1 đăng ký: 16 byte ngẫu nhiên dạng base64url */
const REG_ID = /^[A-Za-z0-9_-]{22}$/;

let failures = 0;
let passes = 0;
let skipped = 0;
function check(cond: unknown, label: string, extra?: unknown): void {
  if (cond) {
    passes++;
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.log(`  ✗ ${label}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ''}`);
  }
}
/** Kiểm tra cần server tin X-Forwarded-For (nhiều IP khác nhau) — bỏ qua khi server không tin */
function skip(label: string): void {
  skipped++;
  console.log(`  – ${label} (bỏ qua: server không dùng X-Forwarded-For)`);
}
/** Dừng hẳn (lỗi cấu hình / không an toàn để chạy tiếp) */
function stop(msg: string): never {
  console.error(`\n✗ DỪNG: ${msg}`);
  process.exit(1);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * IP giả của người dùng thử (gửi qua X-Forwarded-For), trong các dải dành cho tài liệu và ngẫu nhiên theo lần chạy:
 * IPv6 2001:db8::/32, IPv4 198.51.100.0/24, 203.0.113.0/24. Server gộp IPv6 theo /64 (giới hạn theo IP) VÀ theo /48
 * (giới hạn theo mạng, vd 20 thư mã / giờ mỗi /48, còn 6 khi trang đang bận) → mỗi người một /48 riêng, để các giới
 * hạn theo mạng không làm hỏng những phần thử nhiều IP (trước đây cả lần chạy chung một /48: chạy smoke vài lần trong
 * một giờ trên cùng Redis là phần mã đăng ký "đang bận" và phần thử 6 IP bị từ chối reg_ip_limit).
 */
const IP6_BASE = randomInt(1, 0x10000);
let ipSeq = 0;
const nextIp = () => `2001:db8:${((IP6_BASE + ++ipSeq) % 0x10000).toString(16)}::1`;
const ip4 = (net: '198.51.100' | '203.0.113') => `${net}.${randomInt(1, 255)}`;

/** "máy:cổng/csdl" của một địa chỉ kết nối — KHÔNG in tên đăng nhập / mật khẩu */
function where(url: string, defaultPort: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || defaultPort}${u.pathname.length > 1 ? u.pathname : ''}`;
  } catch {
    return '(không đọc được địa chỉ)';
  }
}
const isLoopbackHost = (h: string) => ['127.0.0.1', '::1', '[::1]', 'localhost'].includes(h.trim().toLowerCase());

interface ApiResult<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

class Player {
  cookie = '';
  socket: Socket | null = null;
  id = '';
  /** true = không trả lời "conn:probe" (giả kết nối treo nửa vời sau khi đổi mạng); mặc định trả lời như trang web */
  ignoreProbe = false;
  constructor(
    readonly username: string,
    readonly email: string,
    readonly password = 'matkhau123',
    /** IP giả của người này (X-Forwarded-For) */
    readonly ip = nextIp(),
  ) {}

  api<T = any>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
    return this.send<T>(method, path, body === undefined ? undefined : JSON.stringify(body));
  }

  /** Gửi thân yêu cầu nguyên văn (dùng thử JSON hỏng / quá lớn) */
  async send<T = any>(method: string, path: string, raw?: string): Promise<ApiResult<T>> {
    const res = await fetch(BASE + path, {
      method,
      headers: { 'content-type': 'application/json', cookie: this.cookie, 'x-forwarded-for': this.ip },
      body: raw,
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const [name, value] = pair.split('=');
      if (name === 'ct_session') this.cookie = value ? `ct_session=${value}` : '';
    }
    const text = await res.text();
    let parsed: any = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* không phải JSON */
    }
    return { status: res.status, body: parsed as T, headers: res.headers };
  }

  connect(): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const s = io(BASE, {
        path: '/socket.io',
        transports: ['websocket'],
        extraHeaders: { cookie: this.cookie, 'x-forwarded-for': this.ip },
        reconnection: false,
      });
      s.once('connect', () => resolve(s));
      s.once('connect_error', reject);
      // Như trang web (apps/web/src/api/socket.ts): trả lời ngay khi máy chủ hỏi "tab này còn đó không"
      s.on('conn:probe', (ack: unknown) => {
        if (!this.ignoreProbe && typeof ack === 'function') ack(true);
      });
      this.socket = s;
    });
  }

  async emit<T = any>(event: string, payload: unknown = {}): Promise<T> {
    return (await this.socket!.timeout(8000).emitWithAck(event, payload)) as T;
  }
}

function waitFor<T = any>(socket: Socket, event: string, pred: (p: T) => boolean = () => true, ms = 8000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`Hết thời gian chờ sự kiện ${event}`));
    }, ms);
    const handler = (p: T) => {
      if (pred(p)) {
        clearTimeout(timer);
        socket.off(event, handler);
        resolve(p);
      }
    };
    socket.on(event, handler);
  });
}

interface MailSummary {
  ID: string;
  To?: Array<{ Address: string }>;
}

/** Thư gửi đúng tới `to` (tìm kiếm của Mailpit không so khớp chính xác địa chỉ) */
const sameTo = (m: MailSummary, to: string) => !!m.To?.some((t) => t.Address.toLowerCase() === to.toLowerCase());

/** Các thư trong Mailpit gửi đúng tới `to`, mới nhất trước */
async function mailsTo(to: string): Promise<MailSummary[]> {
  const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}&limit=200`);
  const list = (await res.json()) as { messages?: MailSummary[] };
  return (list.messages ?? []).filter((m) => sameTo(m, to));
}

async function mailText(id: string): Promise<string> {
  const full = (await (await fetch(`${MAILPIT}/api/v1/message/${id}`)).json()) as { Text?: string };
  return full.Text ?? '';
}

async function mailLink(to: string, kind: 'verify-email' | 'reset-password'): Promise<string | null> {
  for (let i = 0; i < 20; i++) {
    for (const m of await mailsTo(to)) {
      const match = new RegExp(`/${kind}\\?token=([^\\s"<>]+)`).exec(await mailText(m.ID));
      if (match) return decodeURIComponent(match[1]);
    }
    await sleep(300);
  }
  return null;
}

/** Mã 6 chữ số trong thư mới nhất (chưa có trong `seen`) gửi tới `to`; null nếu không thấy sau `tries` lần hỏi */
async function mailCode(to: string, seen: Set<string>, tries = 20): Promise<string | null> {
  for (let i = 0; i < tries; i++) {
    for (const m of await mailsTo(to)) {
      if (seen.has(m.ID)) continue;
      seen.add(m.ID);
      const match = /:\s*(\d{6})\b/.exec(await mailText(m.ID));
      if (match) return match[1];
    }
    await sleep(300);
  }
  return null;
}

/** Chờ tối đa `ms` cho tới khi Mailpit có thư gửi tới `to` */
async function waitMail(to: string, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  for (;;) {
    if ((await mailsTo(to)).length > 0) return true;
    if (Date.now() >= end) return false;
    await sleep(300);
  }
}

/** Một mã 6 chữ số chắc chắn khác `code` */
const wrongOf = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, '0');

/**
 * Bỏ thời gian chờ "Gửi lại mã" (CHỈ dùng trong kiểm thử): xoá khoá rl:reg-resend:<hộp thư>:<IP>. Trả về số khoá đã xoá.
 * Server không dùng X-Forwarded-For thì không biết server thấy IP nào → xoá mọi khoá chờ của hộp thư thử nghiệm này.
 */
async function clearResendWait(redis: Redis, email: string, ip: string, viaXff: boolean): Promise<number> {
  const prefix = `rl:reg-resend:${mailboxKey(email)}:`;
  if (viaXff) return redis.del(prefix + ipBucket(ip));
  let removed = 0;
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 500);
    cursor = next;
    if (keys.length) removed += await redis.del(...keys);
  } while (cursor !== '0');
  return removed;
}

/** Lấy hai người chơi và bên cầm quân của họ trong ván */
async function joinBoth(a: Player, b: Player, matchId: string) {
  const ja = await a.emit<{ ok: boolean; state: MatchStateDto; error?: string }>('match:join', { matchId });
  const jb = await b.emit<{ ok: boolean; state: MatchStateDto; error?: string }>('match:join', { matchId });
  check(ja.ok && jb.ok, 'cả hai vào được bàn cờ', [ja.error, jb.error]);
  const first = ja.state.myColor === 0 ? a : b;
  const second = first === a ? b : a;
  return { first, second, state: ja.state };
}

async function main(): Promise<void> {
  // An toàn 1 — xét TRƯỚC khi đọc apps/server/.env: chạy vào server khác mà dùng Redis ghi trong .env là sai chỗ
  // (xoá khoá / đọc bộ đếm ở một Redis khác với Redis của server đang kiểm thử)
  const redisFromEnv = !!process.env.REDIS_URL;
  const dbFromEnv = !!process.env.DATABASE_URL;
  if (process.env.SMOKE_BASE && !redisFromEnv) {
    stop(
      `Đã đặt SMOKE_BASE=${BASE} nhưng chưa đặt REDIS_URL. Smoke đọc và xoá khoá trong Redis của server đang kiểm thử nên ` +
        `phải chỉ rõ Redis đó (không lấy từ apps/server/.env), ví dụ: SMOKE_BASE=${BASE} REDIS_URL=redis://127.0.0.1:6395 npm run smoke`,
    );
  }
  const cfg = new AppConfig();
  // An toàn 2 — server mặc định đọc cùng apps/server/.env: SMTP ở đó là máy chủ thư thật thì smoke sẽ gửi thư thật
  if (!process.env.SMOKE_BASE && cfg.smtp.host && !isLoopbackHost(cfg.smtp.host)) {
    stop(
      'Server mặc định (http://localhost:3000) dùng apps/server/.env, trong đó SMTP_HOST là máy chủ thư thật (không phải ' +
        'máy này) → không chạy để khỏi gửi thư thật. Hãy chạy một server thử nghiệm gửi thư tới Mailpit (SMTP_HOST=127.0.0.1, ' +
        'SMTP_PORT=1025) rồi đặt SMOKE_BASE và REDIS_URL của server đó.',
    );
  }
  console.log(`Server: ${BASE} · Mailpit: ${MAILPIT}`);
  console.log(
    `Redis: ${where(cfg.redisUrl, '6379')} (${redisFromEnv ? 'biến môi trường REDIS_URL' : 'apps/server/.env'}) · ` +
      `PostgreSQL: ${where(cfg.databaseUrl, '5432')} (${dbFromEnv ? 'biến môi trường DATABASE_URL' : 'apps/server/.env'})`,
  );
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient({ datasources: { db: { url: cfg.databaseUrl } } });
  const redis = new Redis(cfg.redisUrl, { maxRetriesPerRequest: 1, connectTimeout: 5000 });
  redis.on('error', () => undefined); // lỗi kết nối được báo ở lệnh đầu tiên bên dưới

  const run = Date.now().toString(36);
  /** Nhãn riêng cho tài khoản của phần đăng ký 3 bước (không chứa `run` để phần quản trị tìm theo `run` vẫn ra đúng 2 người) */
  const tag = run.split('').reverse().join('');

  console.log('0. Kiểm tra trước khi chạy: server có gửi thư tới Mailpit không');
  try {
    await redis.ping();
  } catch (e) {
    stop(`Không kết nối được Redis ${where(cfg.redisUrl, '6379')}: ${(e as Error).message}`);
  }
  const P = new Player('Preflight', `smoke-p-${tag}@test.local`);
  let pre: ApiResult;
  try {
    pre = await P.api('POST', '/api/auth/register/start', { email: P.email });
  } catch (e) {
    stop(`Không kết nối được server ${BASE}: ${(e as Error).message}`);
  }
  const notMailpit =
    'Server này không gửi thư tới Mailpit (có thể đang dùng SMTP thật, chưa cấu hình SMTP_HOST, SMTP đang lỗi, hoặc đã ' +
    'chạm trần thư MAIL_MAX_PER_HOUR / MAIL_MAX_PER_DAY) → dừng, không kiểm thử tiếp.';
  if (pre.status === 503 || pre.body?.code === 'mail_unavailable') stop(`${notMailpit} Server trả: ${JSON.stringify(pre.body)}`);
  if (pre.status !== 200) stop(`Bước 1 đăng ký không chạy được (HTTP ${pre.status}): ${JSON.stringify(pre.body)}`);
  let arrived = false;
  try {
    arrived = await waitMail(P.email, 10_000);
  } catch (e) {
    stop(`Không đọc được Mailpit tại ${MAILPIT}: ${(e as Error).message}`);
  }
  if (!arrived) stop(`Sau 10 giây Mailpit (${MAILPIT}) vẫn không có thư tới ${P.email}. ${notMailpit}`);
  check(true, `thư thử tới ${P.email} đã vào Mailpit`);
  const preRegId = typeof pre.body?.regId === 'string' && REG_ID.test(pre.body.regId) ? (pre.body.regId as string) : null;
  check(!!preRegId, 'bước 1 trả regId (22 ký tự)', pre.body);
  if (preRegId && !(await redis.exists(`reg:code:${preRegId}`))) {
    stop(
      `Redis ${where(cfg.redisUrl, '6379')} không phải Redis của server ${BASE} (không thấy mã vừa tạo). ` +
        'Đặt REDIS_URL đúng Redis mà server đó đang dùng.',
    );
  }
  // Server tính giới hạn theo IP giả (X-Forwarded-For) không: có bộ đếm theo IP giả của lần gọi vừa rồi là có
  const viaXff = (await redis.exists(`rl:reg-start:${ipBucket(P.ip)}`)) === 1;
  if (viaXff) check(true, 'server tính giới hạn theo IP giả (X-Forwarded-For) — mỗi lần chạy dùng IP mới');
  else {
    const local = await redis.exists(`rl:reg-start:${ipBucket('127.0.0.1')}`, `rl:reg-start:${ipBucket('::1')}`);
    console.log(
      '  – server không dùng X-Forwarded-For (xem TRUST_PROXY): mọi yêu cầu tính cho một IP → bỏ qua các kiểm tra cần ' +
        'nhiều IP; giới hạn theo IP chỉ cho chạy vài lần mỗi giờ' +
        (local ? '' : ` (cũng không thấy bộ đếm rl:reg-start của IP máy này — server ở máy khác hoặc khoá Redis khác tên)`),
    );
  }
  // Trần thư toàn trang (MailService): mỗi loại thư có phần riêng của MAIL_MAX_PER_HOUR / MAIL_MAX_PER_DAY (MAIL_SHARE_PCT:
  // mã đăng ký 70%, đặt lại mật khẩu 20%, liên kết xác thực 10%), kèm trần tổng. Phần còn lại của một lần chạy gửi thêm
  // SMOKE_MAILS_LEFT thư mỗi loại (đếm trong Mailpit) → báo trước thay vì để các phần sau hỏng vì 503 / thiếu thư khó hiểu.
  // Phần nhỏ nhất (liên kết xác thực, 10 thư / giờ với trần mặc định) thường hết trước: khoảng 5 lần chạy mỗi giờ.
  // Chỉ cảnh báo (không dừng): smoke chỉ biết trần theo môi trường / .env của chính nó, server có thể đặt trần khác.
  const SMOKE_MAILS_LEFT: Record<MailKind, number> = { 'register-code': 10, verify: 2, reset: 1 };
  const MAIL_LABEL: Record<MailKind, string> = {
    'register-code': 'thư mã đăng ký',
    verify: 'thư liên kết xác thực',
    reset: 'thư đặt lại mật khẩu',
  };
  const leftTotal = Object.values(SMOKE_MAILS_LEFT).reduce((a, b) => a + b, 0);
  for (const [win, limit, unit] of [
    ['hour', cfg.mailMaxPerHour, 'giờ'],
    ['day', cfg.mailMaxPerDay, '24 giờ'],
  ] as const) {
    const rows: Array<[key: string, label: string, cap: number, left: number]> = [
      [`rl:mail-global:${win}`, 'thư (mọi loại)', limit, leftTotal],
      ...(Object.keys(SMOKE_MAILS_LEFT) as MailKind[]).map(
        (k) => [`rl:mail-kind:${k}:${win}`, MAIL_LABEL[k], shareOf(limit, k), SMOKE_MAILS_LEFT[k]] as [string, string, number, number],
      ),
    ];
    for (const [key, label, cap, left] of rows) {
      const used = Number(await redis.get(key)) || 0;
      if (used + left <= cap) continue;
      const min = Math.max(1, Math.ceil((await redis.pttl(key)) / 60_000));
      console.log(
        `  – cảnh báo: Redis này đã đếm ${used} ${label} trong cửa sổ ${unit} (trần ${cap}); lần chạy này cần thêm ${left} ` +
          `nên có thể hỏng vì 503 mail_unavailable / không nhận được thư. Chờ khoảng ${min} phút hoặc chạy server thử ` +
          `nghiệm với MAIL_MAX_PER_HOUR / MAIL_MAX_PER_DAY lớn hơn.`,
      );
    }
  }

  const A = new Player(`An_${run}`, `smoke-a-${run}@test.local`);
  const B = new Player(`Bình ${run}`, `smoke-b-${run}@test.local`);

  console.log('1. Tài khoản');
  const health = await A.api('GET', '/api/health');
  check(health.status === 200, 'server hoạt động');
  const guest = await A.api('GET', '/api/auth/me');
  check(guest.status === 200 && guest.body.user === null, 'khách: /auth/me trả về user null');
  const lbGuest = await A.api('GET', '/api/leaderboard/xiangqi');
  check(lbGuest.status === 200 && Array.isArray(lbGuest.body.entries) && lbGuest.body.me === null, 'khách xem được Top 10');
  const profGuest = await A.api('GET', `/api/users/00000000-0000-0000-0000-000000000000/profile`);
  check(profGuest.status === 401, 'khách không xem được hồ sơ', profGuest.status);
  // Thân JSON quá giới hạn 100 KB / JSON hỏng: lỗi 4xx rõ ràng, không phải lỗi 500
  const big = await A.api('POST', '/api/auth/login', { email: A.email, password: 'x'.repeat(110 * 1024) });
  check(big.status === 413 && big.body?.message === 'Dữ liệu gửi lên quá lớn', 'dữ liệu JSON quá 100 KB → 413 (không phải lỗi 500)', [big.status, big.body]);
  const broken = await A.send('POST', '/api/auth/login', '{"email": ');
  check(broken.status === 400 && broken.body?.message === 'Dữ liệu gửi lên không hợp lệ', 'JSON hỏng → 400', [broken.status, broken.body]);
  for (const p of [A, B]) {
    const r = await p.api('POST', '/api/auth/register', { username: p.username, email: p.email, password: p.password });
    if (r.status === 404) {
      stop(
        'Server tắt đăng ký kiểu cũ POST /api/auth/register (ALLOW_LEGACY_REGISTER=false). Smoke dùng nó để tạo nhanh tài ' +
          'khoản thử → bật ALLOW_LEGACY_REGISTER=true cho server thử nghiệm.',
      );
    }
    check(r.status === 201 && r.body.user?.emailVerified === false, `đăng ký ${p.username} (kiểu cũ /api/auth/register)`, r.body);
    p.id = r.body.user?.id;
  }
  if (A.id && B.id && (await prisma.user.count({ where: { id: { in: [A.id, B.id] } } })) !== 2) {
    stop(
      `PostgreSQL ${where(cfg.databaseUrl, '5432')} không phải DB của server ${BASE} (không thấy 2 tài khoản vừa tạo). ` +
        'Đặt DATABASE_URL đúng DB mà server đó đang dùng.',
    );
  }
  const dup = await new Player(A.username.toUpperCase(), `x-${run}@test.local`).api('POST', '/api/auth/register', {
    username: A.username.toUpperCase(),
    email: `x-${run}@test.local`,
    password: 'matkhau123',
  });
  check(dup.status === 409, 'tên hiển thị trùng (khác hoa thường) bị từ chối', dup.body);
  const weak = await new Player('ok_name', 'w@test.local').api('POST', '/api/auth/register', {
    username: `weak_${run}`.slice(0, 20),
    email: `w-${run}@test.local`,
    password: '123',
  });
  check(weak.status === 400, 'mật khẩu yếu bị từ chối');

  await A.connect();
  await B.connect();
  const notVerified = await A.emit('queue:join', { game: 'chess' });
  check(!notVerified.ok && notVerified.code === 'email_not_verified', 'chưa xác thực email thì không được tìm trận xếp hạng');

  for (const p of [A, B]) {
    const token = await mailLink(p.email, 'verify-email');
    check(!!token, `nhận email xác thực của ${p.username}`);
    const v = await p.api('POST', '/api/auth/verify-email', { token });
    check(v.status === 200, `xác thực email ${p.username}`, v.body);
  }
  const badToken = await A.api('POST', '/api/auth/verify-email', { token: 'abc' });
  check(badToken.status === 400, 'token xác thực sai bị từ chối');

  console.log('1b. Đăng ký 3 bước (mã 6 chữ số qua email)');
  {
    const R = new Player(`Rg_${tag}`, `smoke-r-${tag}@test.local`, undefined, ip4('198.51.100'));
    const L = new Player(`Lk_${tag}`, `smoke-l-${tag}@test.local`);
    const start = (p: Player, email: string, regId?: string) =>
      p.api('POST', '/api/auth/register/start', regId === undefined ? { email } : { email, regId });
    const verify = (p: Player, body: Record<string, unknown>) => p.api('POST', '/api/auth/register/verify', body);
    const seen = new Set<string>();

    const s1 = await start(R, R.email.toUpperCase());
    const regR = s1.body.regId as string;
    check(
      s1.status === 200 &&
        s1.body.email === R.email &&
        REG_ID.test(regR ?? '') &&
        s1.body.resendAfterSec === 60 &&
        s1.body.expiresInSec === 600,
      'bước 1: gửi mã tới email, nhận regId',
      s1.body,
    );
    // "Gửi lại mã" ngay (cùng IP, kèm regId như trình duyệt): bị chặn và không đổi gì — mã đang có vẫn dùng được (bước 2)
    const again = await start(R, R.email, regR);
    const wait = again.body.retryAfterSec;
    check(
      again.status === 429 &&
        again.body.code === 'reg_resend_wait' &&
        Number.isInteger(wait) &&
        wait >= 1 &&
        wait <= 60 &&
        String(again.body.message).includes(`${wait} giây`) &&
        again.headers.get('retry-after') === String(wait),
      'gửi lại mã ngay lập tức bị chặn (chờ 60 giây; có retryAfterSec và header Retry-After)',
      [again.status, again.body, again.headers.get('retry-after')],
    );
    const code = await mailCode(R.email, seen);
    check(!!code && /^\d{6}$/.test(code), 'nhận thư có mã 6 chữ số (Mailpit)', code);

    if (viaXff) {
      // Người lạ (IP khác, không có regId của R) yêu cầu mã cho cùng email: không bị thời gian chờ của IP R chặn, nhận
      // regId riêng; nhập sai 5 lần trên regId của chính họ → chỉ mã của họ bị khoá (mã của R vẫn dùng được — bước 2)
      const S = new Player(`St_${tag}`, R.email, undefined, ip4('203.0.113'));
      const sS = await start(S, R.email);
      check(
        sS.status === 200 && REG_ID.test(sS.body.regId ?? '') && sS.body.regId !== regR,
        'IP khác không bị chặn bởi thời gian chờ của IP đầu (nhận regId riêng)',
        sS.body,
      );
      const codeS = (await mailCode(R.email, seen)) ?? '000000';
      const sMsgs: string[] = [];
      for (let i = 0; i < 5; i++) {
        const w = await verify(S, { email: R.email, regId: sS.body.regId, code: wrongOf(codeS) });
        sMsgs.push(`${w.status}:${w.body.code}`);
      }
      check(
        sMsgs.slice(0, 4).every((m) => m === '400:reg_code_wrong') && sMsgs[4] === '400:reg_code_locked',
        'người lạ nhập sai 5 lần: chỉ mã của chính họ bị khoá',
        sMsgs,
      );
    } else {
      skip('người lạ (IP khác, không có regId) không khoá / thay được mã của chủ email; IP khác không bị thời gian chờ chặn');
    }

    // regId thiếu / không có thật / sai định dạng / của email khác → báo như mã hết hạn và KHÔNG tính lượt nhập
    const noReg = await verify(R, { email: R.email, code });
    check(noReg.status === 400 && noReg.body.code === 'reg_code_expired', 'thiếu regId → báo hết hạn (mã đúng cũng không được)', noReg.body);
    const ghost = await verify(R, { email: R.email, regId: randomBytes(16).toString('base64url'), code });
    check(ghost.status === 400 && ghost.body.code === 'reg_code_expired', 'regId không có thật → báo hết hạn', ghost.body);
    if (viaXff) {
      const badReg = await verify(R, { email: R.email, regId: 'khong-phai-regid', code });
      check(badReg.status === 400 && badReg.body.code === 'reg_code_expired', 'regId sai định dạng → báo hết hạn', badReg.body);
    }
    const otherEmail = await verify(R, { email: `none-${tag}@test.local`, regId: regR, code });
    check(
      otherEmail.status === 400 && otherEmail.body.code === 'reg_code_expired',
      'email chưa yêu cầu mã (dùng regId của email khác) → báo hết hạn',
      otherEmail.body,
    );
    const wrongR = await verify(R, { email: R.email, regId: regR, code: wrongOf(code ?? '000000') });
    check(
      wrongR.status === 400 && wrongR.body.code === 'reg_code_wrong' && /còn 4 lần/.test(wrongR.body.message) && wrongR.body.attemptsLeft === 4,
      'mã sai: báo còn 4 lần (các lần thử với regId sai ở trên không bị tính)',
      wrongR.body,
    );
    const badFmt = await verify(R, { email: R.email, regId: regR, code: '12ab56' });
    check(badFmt.status === 400 && badFmt.body.message === 'Mã gồm 6 chữ số', 'mã không phải 6 chữ số bị từ chối', badFmt.body);
    const v = await verify(R, { email: R.email, regId: regR, code });
    check(
      v.status === 200 && typeof v.body.ticket === 'string' && v.body.ticket.length === 43 && v.body.expiresInSec === 900,
      'bước 2: mã đúng → nhận phiếu',
      v.body,
    );
    if (viaXff) check(v.status === 200, 'mã của chủ email vẫn dùng được dù người lạ đã yêu cầu mã và nhập sai 5 lần', v.body);
    const vAgain = await verify(R, { email: R.email, regId: regR, code });
    check(vAgain.status === 400 && vAgain.body.code === 'reg_code_expired', 'mã đã dùng không dùng lại được', vAgain.body);
    const ticket = v.body.ticket as string;
    const weakC = await R.api('POST', '/api/auth/register/complete', { ticket, username: R.username, password: '123' });
    check(weakC.status === 400 && !weakC.body.code, 'bước 3: mật khẩu yếu bị từ chối (phiếu vẫn còn)', weakC.body);
    const dupC = await R.api('POST', '/api/auth/register/complete', { ticket, username: A.username.toLowerCase(), password: R.password });
    check(dupC.status === 409 && dupC.body.message === 'Tên hiển thị đã có người dùng', 'bước 3: tên trùng bị từ chối (phiếu vẫn còn)', dupC.body);
    const done = await R.api('POST', '/api/auth/register/complete', { ticket, username: R.username, password: R.password });
    check(
      done.status === 201 && done.body.user?.emailVerified === true && done.body.user?.email === R.email && !!R.cookie,
      'bước 3: tạo tài khoản, email đã xác thực, đã đăng nhập',
      done.body,
    );
    const meR = await R.api('GET', '/api/auth/me');
    check(meR.body.user?.id === done.body.user?.id && meR.body.user?.emailVerified === true, '/auth/me: đã đăng nhập bằng tài khoản mới');
    const reuse = await new Player('x', 'x@test.local').api('POST', '/api/auth/register/complete', {
      ticket,
      username: `Other_${tag}`.slice(0, 20),
      password: 'matkhau123',
    });
    check(reuse.status === 400 && reuse.body.code === 'reg_ticket_expired', 'phiếu chỉ dùng được một lần', reuse.body);
    await sleep(800);
    const mailsR = await mailsTo(R.email);
    const textsR = await Promise.all(mailsR.map((m) => mailText(m.ID)));
    check(
      mailsR.length === (viaXff ? 2 : 1) && textsR.every((t) => /:\s*\d{6}\b/.test(t) && !/verify-email\?token=/.test(t)),
      viaXff ? 'chỉ có thư mã (của chủ email và của người lạ), không gửi thư xác thực liên kết' : 'chỉ một thư (thư mã), không gửi thư xác thực liên kết',
      mailsR.length,
    );
    const loginR = await new Player('y', R.email).api('POST', '/api/auth/login', { email: R.email, password: R.password });
    check(loginR.status === 200, 'đăng nhập bằng tài khoản vừa tạo');
    const exists = await start(L, R.email);
    check(exists.status === 409 && exists.body.message === 'Email đã được sử dụng', 'email đã có tài khoản → 409', exists.body);
    const exists2 = await start(L, A.email);
    check(exists2.status === 409, 'email của người chơi khác → 409');
    const bot = await start(L, 'bot99@bots.invalid');
    check(bot.status === 400, 'email dành cho máy bị từ chối');
    const badEmail = await start(L, 'không phải email');
    check(badEmail.status === 400, 'email sai định dạng bị từ chối');

    // "Gửi lại mã" kèm regId cũ → mã cũ không dùng được nữa; nhập sai 5 lần → mã bị khoá (kể cả mã đúng); gửi lại thì mã
    // mới dùng được. Thời gian chờ 60 giây được bỏ qua bằng cách xoá khoá chờ trong Redis (chỉ trong kiểm thử).
    const seenL = new Set<string>();
    const l1 = await start(L, L.email);
    check(l1.status === 200 && REG_ID.test(l1.body.regId ?? ''), 'gửi mã tới email thứ hai', l1.body);
    const codeL1 = (await mailCode(L.email, seenL)) ?? '000000';
    const cleared1 = await clearResendWait(redis, L.email, L.ip, viaXff);
    const l2 = await start(L, L.email, l1.body.regId);
    check(
      l2.status === 200 && REG_ID.test(l2.body.regId ?? '') && l2.body.regId !== l1.body.regId,
      'gửi lại mã (kèm regId cũ) → nhận regId mới',
      [l2.status, l2.body, `đã xoá ${cleared1} khoá chờ`],
    );
    const codeL2 = (await mailCode(L.email, seenL)) ?? '000000';
    const oldL = await verify(L, { email: L.email, regId: l1.body.regId, code: codeL1 });
    check(oldL.status === 400 && oldL.body.code === 'reg_code_expired', 'sau khi gửi lại, mã cũ (regId cũ) không dùng được nữa', oldL.body);
    const msgs: string[] = [];
    for (let i = 0; i < 5; i++) {
      const w = await verify(L, { email: L.email, regId: l2.body.regId, code: wrongOf(codeL2) });
      msgs.push(`${w.status}:${w.body.code}`);
    }
    check(
      msgs.slice(0, 4).every((m) => m === '400:reg_code_wrong') && msgs[4] === '400:reg_code_locked',
      'sai 5 lần: lần thứ 5 báo khoá mã',
      msgs,
    );
    const lockedRight = await verify(L, { email: L.email, regId: l2.body.regId, code: codeL2 });
    check(
      lockedRight.status === 400 && lockedRight.body.code === 'reg_code_locked' && /Gửi lại mã/.test(lockedRight.body.message),
      'mã đã khoá: nhập đúng cũng không được',
      lockedRight.body,
    );
    const cleared2 = await clearResendWait(redis, L.email, L.ip, viaXff);
    const resend = await start(L, L.email, l2.body.regId);
    check(resend.status === 200 && REG_ID.test(resend.body.regId ?? ''), 'gửi lại mã sau thời gian chờ', [resend.status, resend.body, `đã xoá ${cleared2} khoá chờ`]);
    const codeL3 = await mailCode(L.email, seenL);
    const vL = await verify(L, { email: L.email, regId: resend.body.regId, code: codeL3 });
    check(vL.status === 200 && !!vL.body.ticket, 'mã mới (sau khi bị khoá) dùng được', vL.body);

    if (viaXff) {
      // Các biến thể "+nhãn" của một hộp thư dùng chung giới hạn 5 thư mã / giờ. Mỗi lần gửi từ một IP khác để các giới hạn
      // theo IP (thời gian chờ, 5 thư / 24 giờ cho mỗi hộp thư + IP, 10 thư / giờ mỗi IP — 3 khi trang đang bận) không
      // xen vào.
      const box = `smoke-t-${tag}`;
      const T = Array.from({ length: 6 }, (_, i) => new Player(`t${i}`, `${box}+${i + 1}@test.local`));
      const tRes: ApiResult[] = [];
      for (const p of T) tRes.push(await start(p, p.email));
      check(
        tRes.slice(0, 5).every((r) => r.status === 200),
        '5 lần gửi mã tới các biến thể +nhãn của một hộp thư (5 IP khác nhau) đều được',
        tRes.map((r) => `${r.status}:${r.body?.code ?? ''}`),
      );
      const q6 = tRes[5];
      const q6Wait = q6.body?.retryAfterSec;
      check(
        q6.status === 429 &&
          q6.body.code === 'reg_mail_quota' &&
          /^Đã gửi nhiều mã tới email này/.test(String(q6.body.message)) &&
          Number.isInteger(q6Wait) &&
          q6Wait >= 1 &&
          q6Wait <= 3600 &&
          q6.headers.get('retry-after') === String(q6Wait),
        'lần thứ 6 trong giờ (biến thể khác, IP khác) → hộp thư hết lượt (reg_mail_quota, có thời gian chờ)',
        [q6.status, q6.body, q6.headers.get('retry-after')],
      );
      // Yêu cầu bị từ chối không bật / tăng gì: cùng IP hỏi lại vẫn báo hết lượt, không phải "chờ N giây rồi gửi lại"
      const q7 = await start(T[5], T[5].email);
      check(
        q7.status === 429 && q7.body.code === 'reg_mail_quota',
        'bị từ chối không bật thời gian chờ: hỏi lại vẫn báo hết lượt (không phải "chờ N giây")',
        q7.body,
      );
      const hourCount = await redis.get(`rl:reg-mail-hour:${mailboxKey(`${box}@test.local`)}`);
      check(hourCount === '5', 'lần bị từ chối không tăng bộ đếm thư của hộp thư (vẫn 5)', hourCount);
    } else {
      skip('các biến thể +nhãn dùng chung giới hạn 5 thư mã / giờ của hộp thư; lần bị từ chối không bật thời gian chờ');
    }
  }

  console.log('2. Ghép trận xếp hạng (Cờ vua) và Elo');
  const foundA = waitFor<{ matchId: string }>(A.socket!, 'match:found');
  const foundB = waitFor<{ matchId: string }>(B.socket!, 'match:found');
  const q1 = await A.emit('queue:join', { game: 'chess' });
  check(q1.ok && q1.status.searching && q1.status.range === 100, 'vào hàng chờ, khoảng ±100', q1);
  const q2 = await B.emit('queue:join', { game: 'chess' });
  check(q2.ok, 'người thứ hai vào hàng chờ');
  const [fa, fb] = await Promise.all([foundA, foundB]);
  check(fa.matchId === fb.matchId, 'hai người được ghép cùng một ván');
  const matchId = fa.matchId;

  // Chặn đăng nhập nơi khác khi đang trong ván và nơi cũ còn kết nối
  const { first: white, second: black, state } = await joinBoth(A, B, matchId);
  check(state.ranked && state.clock.initialMs === 900_000 && state.clock.incrementMs === 10_000, 'ván xếp hạng 15 phút + 10 giây');
  check(state.firstMoveDeadline !== null, 'có hạn 30 giây cho nước đầu');
  const otherDevice = new Player(white.username, white.email);
  const blocked = await otherDevice.api('POST', '/api/auth/login', { email: white.email, password: white.password });
  check(blocked.status === 409, 'đăng nhập ở thiết bị khác bị chặn khi đang trong ván', blocked.body);

  // Tab thứ hai của cùng người chơi không được mở ván khi tab đầu còn kết nối
  const tab2 = new Player(white.username, white.email);
  tab2.cookie = white.cookie;
  await tab2.connect();
  const conflict = await tab2.emit('match:join', { matchId });
  check(!conflict.ok && conflict.code === 'session_conflict', 'tab thứ hai bị từ chối khi tab đầu còn kết nối', conflict);
  tab2.socket!.disconnect();

  // Kết nối đang giữ ghế treo nửa vời (vd vừa đổi Wi-Fi sang 4G: máy chủ vẫn tưởng còn kết nối) → không trả lời
  // "conn:probe" → kết nối mới nhận ghế sau ~2,5 giây, kết nối cũ bị máy chủ ngắt
  {
    const tab3 = new Player(white.username, white.email);
    tab3.cookie = white.cookie;
    await tab3.connect();
    white.ignoreProbe = true;
    const oldSocket = white.socket!;
    const oldGone = new Promise<boolean>((resolve) => {
      const t = setTimeout(() => resolve(false), 8000);
      oldSocket.once('disconnect', () => {
        clearTimeout(t);
        resolve(true);
      });
    });
    const t0 = Date.now();
    const takeover = await tab3.emit('match:join', { matchId });
    const took = Date.now() - t0;
    check(
      takeover.ok && takeover.state.myColor === 0 && took >= 2000 && took < 6000,
      'kết nối cũ không trả lời → kết nối mới nhận ghế sau ~2,5 giây',
      { ok: takeover.ok, code: takeover.code, took },
    );
    check(await oldGone, 'kết nối cũ (treo) bị máy chủ ngắt');
    // Trả ghế về kết nối chính để chạy tiếp: đóng tab mới, kết nối lại và vào bàn
    tab3.socket!.disconnect();
    white.ignoreProbe = false;
    await white.connect();
    const back = await white.emit('match:join', { matchId });
    check(back.ok, 'vào lại bàn sau khi kết nối kia đóng', back.error);
  }

  const wrongTurn = await black.emit('match:move', { matchId, move: 'e7e5' });
  check(!wrongTurn.ok, 'không được đi khi chưa tới lượt');
  const illegal = await white.emit('match:move', { matchId, move: 'e2e5' });
  check(!illegal.ok, 'nước không hợp lệ bị từ chối');

  // Chat
  const chatA = await white.emit('chat:send', { matchId, content: 'Chúc bạn chơi vui!' });
  check(chatA.ok && chatA.message.content === 'Chúc bạn chơi vui!', 'gửi tin nhắn chat');
  const chatFast = await white.emit('chat:send', { matchId, content: 'tin thứ hai ngay lập tức' });
  check(!chatFast.ok && chatFast.code === 'rate_limited', 'giới hạn 1 tin / 2 giây');
  const chatLong = await black.emit('chat:send', { matchId, content: 'x'.repeat(201) });
  check(!chatLong.ok, 'tin quá 200 ký tự bị từ chối');
  const report = await black.emit('chat:report', { messageId: chatA.message.id });
  check(report.ok, 'báo cáo tin nhắn');

  const endedP = waitFor<MatchEndedDto>(white.socket!, 'match:ended');
  const lbChanged = waitFor(white.socket!, 'leaderboard:changed');
  for (const [p, mv] of [
    [white, 'f2f3'],
    [black, 'e7e5'],
    [white, 'g2g4'],
    [black, 'd8h4'],
  ] as const) {
    const r = await p.emit('match:move', { matchId, move: mv });
    check(r.ok, `đi ${mv}`, r);
  }
  const ended = await endedP;
  check(ended.result.winner === 1 && ended.result.reason === 'checkmate', 'chiếu hết: Đen thắng');
  const rc = ended.ratingChanges;
  check(rc && rc[1].delta === 24 && rc[1].before === 0 && rc[0].delta === 0 && rc[0].after === 0 && rc[1].rules?.placement === true, 'Elo từ 0 điểm: thắng +24 (16 × 1,5 — 5 ván đầu mùa), thua giữ 0 (sàn điểm)', rc);
  await lbChanged;
  check(true, 'nhận sự kiện cập nhật Top 10 realtime');
  const meLb = await black.api('GET', '/api/leaderboard/chess');
  check(meLb.body.me?.rating === 24 && meLb.body.me?.rank === null && meLb.body.me?.gamesPlayed === 1, `chưa đủ ${LEADERBOARD_MIN_GAMES} ván: chưa xếp hạng`, meLb.body.me);
  const dbMatch = await prisma.match.findUnique({ where: { id: matchId } });
  check(dbMatch?.result === 'p2' && dbMatch.ratingChange === 0 && dbMatch.ratingChange2 === 24 && dbMatch.moves.length === 4, 'lưu kết quả ván vào DB (điểm thay đổi của player1 và player2)', dbMatch);
  const replay = await white.api('GET', `/api/matches/${matchId}`);
  check(replay.status === 200 && replay.body.moves.join(' ') === 'f2f3 e7e5 g2g4 d8h4', 'xem lại nước đi');
  const allowedNow = await otherDevice.api('POST', '/api/auth/login', { email: white.email, password: white.password });
  check(allowedNow.status === 200, 'ván kết thúc: đăng nhập nơi khác được');

  console.log('3. Phòng riêng (Cờ tướng), cầu hoà, mất kết nối');
  const created = await A.emit('room:create', { game: 'xiangqi', minutes: 5, incrementSec: 3 });
  check(created.ok && /^[A-Z0-9]{6}$/.test(created.room.code), 'tạo phòng riêng', created);
  const qWhileRoom = await A.emit('queue:join', { game: 'xiangqi' });
  check(!qWhileRoom.ok, 'đang có phòng thì không tìm trận được');
  const info = await B.emit('room:info', { code: created.room.code });
  check(info.ok && info.room.timeControl.initialMs === 300_000, 'xem thông tin phòng');
  const selfJoin = await A.emit('room:join', { code: created.room.code });
  check(!selfJoin.ok, 'chủ phòng không tự vào phòng mình');
  const roomFound = waitFor<{ matchId: string }>(A.socket!, 'match:found');
  const joined = await B.emit('room:join', { code: created.room.code });
  check(joined.ok, 'người được mời vào phòng', joined);
  const rf = await roomFound;
  const room = await joinBoth(A, B, rf.matchId);
  check(!room.state.ranked && room.state.firstMoveDeadline === null, 'phòng riêng: không tính điểm, không áp dụng luật 30 giây');
  check(room.state.clock.initialMs === 300_000 && room.state.clock.incrementMs === 3_000, 'thời gian theo chủ phòng chọn');
  const mv1 = await room.first.emit('match:move', { matchId: rf.matchId, move: 'h2e2' });
  check(mv1.ok, 'đi nước pháo đầu');
  const clockAfter = await prisma.match.findUnique({ where: { id: rf.matchId } });
  check(clockAfter?.mode === 'pvp' && clockAfter.ranked === false, 'ván phòng riêng ghi vào DB');

  // Mất kết nối: đối thủ nhận thông báo, vào lại thì xoá
  const discNote = waitFor<{ color: number; disconnectedUntil: number | null }>(room.first.socket!, 'match:connection', (p) => p.disconnectedUntil !== null);
  room.second.socket!.disconnect();
  const dn = await discNote;
  check(dn.disconnectedUntil !== null && dn.disconnectedUntil - Date.now() > 50_000, 'đối thủ nhận thông báo mất kết nối (60 giây)');
  const backNote = waitFor<{ disconnectedUntil: number | null }>(room.first.socket!, 'match:connection', (p) => p.disconnectedUntil === null);
  await room.second.connect();
  const rejoin = await room.second.emit('match:join', { matchId: rf.matchId });
  check(rejoin.ok && rejoin.state.moves.length === 1, 'vào lại ván, giữ nguyên nước đi');
  await backNote;
  check(true, 'đối thủ nhận thông báo đã kết nối lại');

  const offerP = waitFor(room.second.socket!, 'match:drawOffer');
  const offer = await room.first.emit('match:offerDraw', { matchId: rf.matchId });
  check(offer.ok, 'gửi lời mời hoà');
  await offerP;
  const decline = await room.second.emit('match:respondDraw', { matchId: rf.matchId, accept: false });
  check(decline.ok, 'từ chối hoà');
  const offer2 = await room.first.emit('match:offerDraw', { matchId: rf.matchId });
  check(offer2.ok, 'mời hoà lần nữa');
  const drawEnded = waitFor<MatchEndedDto>(room.first.socket!, 'match:ended');
  await room.second.emit('match:respondDraw', { matchId: rf.matchId, accept: true });
  const de = await drawEnded;
  check(de.result.winner === null && de.result.reason === 'agreement' && de.ratingChanges === null, 'hoà thoả thuận, không đổi điểm');

  console.log('4. Đấu với máy (lưu lịch sử)');
  const ai = await A.api('POST', '/api/matches/ai', {
    game: 'chess',
    aiLevel: 'easy',
    humanColor: 1,
    timeControl: null,
    moves: ['f2f3', 'e7e5', 'g2g4', 'd8h4'],
    result: { winner: 1, reason: 'checkmate' },
    startedAt: new Date().toISOString(),
  });
  check(ai.status === 201 && ai.body.match.outcome === 'win' && ai.body.match.opponent === null, 'lưu ván thắng máy', ai.body);
  const aiBad = await A.api('POST', '/api/matches/ai', {
    game: 'chess',
    aiLevel: 'easy',
    humanColor: 0,
    timeControl: null,
    moves: ['f2f3', 'e7e5'],
    result: { winner: 0, reason: 'checkmate' },
    startedAt: new Date().toISOString(),
  });
  check(aiBad.status === 400, 'kết quả giả mạo bị từ chối');
  const aiResign = await A.api('POST', '/api/matches/ai', {
    game: 'xiangqi',
    aiLevel: 'hard',
    humanColor: 0,
    timeControl: { initialMs: 600_000, incrementMs: 5_000 },
    moves: ['h2e2', 'h9g7'],
    result: { winner: 1, reason: 'resign' },
    startedAt: new Date().toISOString(),
  });
  check(aiResign.status === 201 && aiResign.body.match.timeControl === '10+5', 'lưu ván đầu hàng máy (có giới hạn thời gian)', aiResign.body);

  console.log('4b. Cờ úp (ghép trận thường, không tính điểm)');
  const jqFoundA = waitFor<{ matchId: string; variant?: string }>(A.socket!, 'match:found');
  const jqFoundB = waitFor<{ matchId: string }>(B.socket!, 'match:found');
  const jqa = await A.emit('queue:join', { game: 'xiangqi', variant: 'jieqi' });
  check(jqa.ok && jqa.status?.variant === 'jieqi' && jqa.status?.range === null, 'vào hàng chờ cờ úp (không xét điểm)', jqa);
  const jqb = await B.emit('queue:join', { game: 'xiangqi', variant: 'jieqi' });
  check(jqb.ok, 'người thứ hai vào hàng chờ cờ úp', jqb);
  const [jqFound] = await Promise.all([jqFoundA, jqFoundB]);
  check(jqFound.variant === 'jieqi', 'ghép được ván cờ úp');
  const jq = await joinBoth(A, B, jqFound.matchId);
  check(jq.state.variant === 'jieqi' && jq.state.ranked === false && jq.state.kind === 'casual', 'ván cờ úp không tính điểm', jq.state);
  check(
    !('setup' in jq.state) && !/[rheacp]{15}\/[rheacp]{15}/.test(JSON.stringify(jq.state)),
    'trạng thái ván gửi cho người chơi không chứa chuỗi xếp quân',
  );
  const jqMove = waitFor<MoveEventDto>(jq.second.socket!, 'match:move');
  const jqR1 = await jq.first.emit('match:move', { matchId: jqFound.matchId, move: 'a3a4' });
  check(jqR1.ok, 'Đỏ đi quân úp ở ô Tốt a3 lên a4', jqR1);
  const jqE1 = await jqMove;
  check(!!jqE1.reveal?.piece && /^[rheacp]$/.test(jqE1.reveal.piece), 'bên kia nhận loại quân vừa lật', jqE1.reveal);
  const jqBad = await jq.second.emit('match:move', { matchId: jqFound.matchId, move: 'a9b7' });
  check(!jqBad.ok, 'quân úp ở ô Xe không được đi như Mã (nước sai bị từ chối)');
  const jqEnded = waitFor<MatchEndedDto>(jq.first.socket!, 'match:ended');
  await jq.second.emit('match:resign', { matchId: jqFound.matchId });
  const jqEnd = await jqEnded;
  check(jqEnd.ratingChanges === null, 'kết thúc ván cờ úp: không đổi điểm hạng');
  const jqDet = await A.api('GET', `/api/matches/${jqFound.matchId}`);
  check(
    jqDet.body.variant === 'jieqi' && /^[rheacp]{15}\/[rheacp]{15}$/.test(jqDet.body.setup ?? ''),
    'xem lại sau khi kết thúc có chuỗi xếp quân',
    jqDet.body.variant,
  );
  const jqSetup = randomJieqiSetup();
  const jqGame = createJieqiGame(jqSetup);
  jqGame.play('a3a4');
  jqGame.play('a6a5');
  const jqAi = await A.api('POST', '/api/matches/ai', {
    game: 'xiangqi',
    variant: 'jieqi',
    setup: jqSetup,
    aiLevel: 'medium',
    humanColor: 0,
    timeControl: null,
    moves: jqGame.history(),
    result: { winner: 1, reason: 'resign' },
    startedAt: new Date().toISOString(),
  });
  check(jqAi.status === 201 && jqAi.body.match.variant === 'jieqi', 'lưu ván cờ úp với máy', jqAi.body);
  const jqAiBad = await A.api('POST', '/api/matches/ai', {
    game: 'xiangqi',
    variant: 'jieqi',
    setup: 'rrrrrrrrrrrrrrr/rrrrrrrrrrrrrrr',
    aiLevel: 'medium',
    humanColor: 0,
    timeControl: null,
    moves: ['a3a4'],
    result: { winner: 1, reason: 'resign' },
    startedAt: new Date().toISOString(),
  });
  check(jqAiBad.status === 400, 'chuỗi xếp quân giả mạo bị từ chối');

  console.log('4c. Khách: chơi không cần đăng nhập (trừ xếp hạng)');
  // Tài khoản khách dùng email nội bộ @guests.invalid (không phải @test.local) → tự xoá cuối phần này
  const guestIds: string[] = [];
  const G = new Player('khach', `khach-${run}@test.local`);
  const G2 = new Player('khach2', `khach2-${run}@test.local`);
  try {
    const g1 = await G.api('POST', '/api/auth/guest');
    check(
      g1.status === 200 && g1.body.user?.isGuest === true && /^Khách \d{6}$/.test(g1.body.user?.username ?? '') && g1.body.user?.email === '' && !!G.cookie,
      'vào chơi với tư cách khách (tên "Khách ……", có cookie phiên)',
      g1.body,
    );
    const gid: string = g1.body.user?.id ?? '';
    if (gid) guestIds.push(gid);
    const g1b = await G.api('POST', '/api/auth/guest');
    check(g1b.status === 200 && g1b.body.user?.id === gid, 'gọi lại khi đã là khách: giữ nguyên danh tính, không tạo khách mới', g1b.body);
    const gMe = await G.api('GET', '/api/auth/me');
    check(gMe.body.user?.id === gid && gMe.body.user?.isGuest === true, '/auth/me nhận ra khách', gMe.body);
    const aGuest = await A.api('POST', '/api/auth/guest');
    check(aGuest.status === 200 && aGuest.body.user?.id === A.id && aGuest.body.user?.isGuest === false, 'thành viên gọi /auth/guest: vẫn là thành viên', aGuest.body);
    const gAi = await G.api('POST', '/api/matches/ai', {
      game: 'xiangqi',
      aiLevel: 'easy',
      humanColor: 0,
      timeControl: null,
      moves: ['h2e2', 'h9g7'],
      result: { winner: 1, reason: 'resign' },
      startedAt: new Date().toISOString(),
    });
    check(gAi.status === 401, 'khách không lưu ván với máy vào lịch sử (cần đăng nhập)', gAi.status);
    const gPz = await G.api('GET', '/api/puzzles/progress');
    check(gPz.status === 401, 'tiến độ cờ thế của khách lưu ở trình duyệt (API cần đăng nhập)', gPz.status);
    const gProf = await A.api('GET', `/api/users/${gid}/profile`);
    check(gProf.status === 404, 'khách không có trang hồ sơ', gProf.status);

    await G.connect();
    const gRanked = await G.emit('queue:join', { game: 'chess' });
    check(!gRanked.ok && gRanked.code === 'login_required', 'khách không vào được hàng chờ xếp hạng', gRanked);
    // Phòng riêng: khách tạo, thành viên vào bằng mã
    const gRoom = await G.emit('room:create', { game: 'xiangqi', minutes: 5, incrementSec: 0 });
    check(gRoom.ok && /^[A-Z0-9]{6}$/.test(gRoom.room?.code ?? ''), 'khách tạo phòng riêng', gRoom);
    const gFound = waitFor<{ matchId: string }>(G.socket!, 'match:found');
    const aJoin = await A.emit('room:join', { code: gRoom.room?.code });
    check(aJoin.ok, 'thành viên vào phòng của khách', aJoin);
    const gMatch = await gFound;
    const gj = await joinBoth(G, A, gMatch.matchId);
    const gp = gj.state.players.find((p) => p.userId === gid);
    const ap = gj.state.players.find((p) => p.userId === A.id);
    check(gp?.isGuest === true && gp.rating === null && !ap?.isGuest, 'trong ván: khách được đánh dấu, không có điểm hạng', gj.state.players);
    const gMv = await gj.first.emit('match:move', { matchId: gMatch.matchId, move: 'h2e2' });
    check(gMv.ok, 'đi nước đầu trong ván có khách', gMv);
    const gChat = await G.emit('chat:send', { matchId: gMatch.matchId, content: 'Chào bạn!' });
    check(gChat.ok, 'khách gửi được tin nhắn trong ván', gChat);
    const gEnded = waitFor<MatchEndedDto>(A.socket!, 'match:ended');
    await G.emit('match:resign', { matchId: gMatch.matchId });
    const gEnd = await gEnded;
    check(gEnd.ratingChanges === null, 'ván với khách không đổi điểm hạng');
    const gHist = await A.api('GET', `/api/users/${A.id}/matches?game=xiangqi`);
    const gRow = gHist.body.items?.find((m: any) => m.id === gMatch.matchId);
    check(gRow?.opponent?.id === gid && gRow.opponent.isGuest === true, 'lịch sử của thành viên: đối thủ khách được đánh dấu', gRow);

    // Cờ úp: hai khách ghép trận thường
    const g2 = await G2.api('POST', '/api/auth/guest');
    if (g2.body.user?.id) guestIds.push(g2.body.user.id);
    await G2.connect();
    const jf1 = waitFor<{ matchId: string; variant?: string }>(G.socket!, 'match:found');
    const jf2 = waitFor<{ matchId: string }>(G2.socket!, 'match:found');
    const gq1 = await G.emit('queue:join', { game: 'xiangqi', variant: 'jieqi' });
    const gq2 = await G2.emit('queue:join', { game: 'xiangqi', variant: 'jieqi' });
    check(gq1.ok && gq2.ok, 'khách vào hàng chờ Cờ úp', [gq1, gq2]);
    const [jf] = await Promise.all([jf1, jf2]);
    check(jf.variant === 'jieqi', 'hai khách được ghép ván Cờ úp');
    const gjq = await joinBoth(G, G2, jf.matchId);
    const gjEnded = waitFor<MatchEndedDto>(gjq.first.socket!, 'match:ended');
    await gjq.second.emit('match:resign', { matchId: jf.matchId });
    const gjEnd = await gjEnded;
    check(gjEnd.ratingChanges === null, 'ván Cờ úp giữa hai khách kết thúc bình thường');

    // Giới hạn tạo khách theo IP (10 / giờ)
    const limIp = ip4('203.0.113');
    let last: ApiResult<any> | null = null;
    for (let i = 0; i < 11; i++) {
      last = await new Player('lim', `lim${i}-${run}@test.local`, 'x', limIp).api('POST', '/api/auth/guest');
      if (last.body?.user?.id) guestIds.push(last.body.user.id);
    }
    check(
      last?.status === 429 && last.body?.code === 'guest_limit' && last.body?.retryAfterSec > 0,
      'tạo quá 10 khách / giờ từ một IP → 429',
      last?.body,
    );
  } finally {
    G.socket?.disconnect();
    G2.socket?.disconnect();
    if (guestIds.length) await prisma.user.deleteMany({ where: { id: { in: guestIds }, isGuest: true } }).catch(() => undefined);
  }

  console.log('5. Hồ sơ, lịch sử, avatar');
  const prof = await A.api('GET', `/api/users/${black.id}/profile`);
  const chessStats = prof.body.games?.find((g: any) => g.game === 'chess');
  check(chessStats?.current?.wins === 1 && chessStats.current.rating === 24 && chessStats.current.tier === 'Tân thủ', 'hồ sơ: điểm, cấp bậc, thắng/thua', chessStats);
  const hist = await A.api('GET', `/api/users/${A.id}/matches?game=chess`);
  check(hist.status === 200 && hist.body.items.length >= 2, 'lịch sử ván đấu (gồm ván với máy)', hist.body.total);
  const ranked = hist.body.items.find((m: any) => m.ranked);
  check(ranked && ranked.ratingChange === (A.id === black.id ? 24 : 0), 'lịch sử có điểm thay đổi đúng phía người chơi', ranked);

  const png = await sharp({ create: { width: 400, height: 300, channels: 3, background: { r: 200, g: 30, b: 30 } } })
    .png()
    .toBuffer();
  const form = new FormData();
  form.append('file', new Blob([png], { type: 'image/png' }), 'a.png');
  const asA = { cookie: A.cookie, 'x-forwarded-for': A.ip };
  const up = await fetch(`${BASE}/api/me/avatar`, { method: 'POST', headers: asA, body: form });
  const upBody = (await up.json()) as { avatarUrl?: string };
  check(up.status === 201 && upBody.avatarUrl?.startsWith('/api/avatars/'), 'upload avatar', upBody);
  const img = await fetch(BASE + upBody.avatarUrl, { headers: { 'x-forwarded-for': A.ip } });
  const imgBuf = Buffer.from(await img.arrayBuffer());
  const meta = await sharp(imgBuf).metadata();
  check(img.status === 200 && meta.width === 256 && meta.height === 256 && meta.format === 'webp', 'avatar được cắt vuông 256px WebP', meta);
  const bigForm = new FormData();
  bigForm.append('file', new Blob([Buffer.alloc(2 * 1024 * 1024 + 10)], { type: 'image/png' }), 'big.png');
  const bigUp = await fetch(`${BASE}/api/me/avatar`, { method: 'POST', headers: asA, body: bigForm });
  const bigUpBody = (await bigUp.json().catch(() => null)) as { message?: string } | null;
  check(
    bigUp.status === 413 && bigUpBody?.message === 'Tệp quá lớn (ảnh tối đa 2 MB)',
    'ảnh quá 2 MB bị từ chối ("Tệp quá lớn (ảnh tối đa 2 MB)")',
    [bigUp.status, bigUpBody],
  );
  const txtForm = new FormData();
  txtForm.append('file', new Blob([Buffer.from('hello')], { type: 'text/plain' }), 'a.txt');
  const txt = await fetch(`${BASE}/api/me/avatar`, { method: 'POST', headers: asA, body: txtForm });
  check(txt.status === 400, 'tệp không phải ảnh bị từ chối');

  console.log('6. Quản trị');
  const notAdmin = await A.api('GET', '/api/admin/users');
  check(notAdmin.status === 403, 'người thường không vào được /admin');
  await prisma.user.update({ where: { id: A.id }, data: { role: 'admin' } });
  const users = await A.api('GET', `/api/admin/users?q=${encodeURIComponent(run)}`);
  check(users.status === 200 && users.body.total === 2, 'admin: tìm tài khoản', users.body.total);
  const reports = await A.api('GET', '/api/admin/reports');
  const rep = reports.body.items?.find((r: any) => r.message.id === chatA.message.id);
  check(!!rep, 'admin: thấy tin nhắn bị báo cáo');
  const del = await A.api('POST', `/api/admin/messages/${chatA.message.id}/delete`);
  check(del.status === 200, 'admin: xoá tin nhắn');
  const delRow = await prisma.chatMessage.findUnique({ where: { id: chatA.message.id } });
  check(delRow?.isDeleted === true, 'tin nhắn đã bị ẩn');
  const avatarDel = await A.api('DELETE', `/api/admin/users/${A.id}/avatar`);
  const afterDel = await prisma.user.findUnique({ where: { id: A.id } });
  check(avatarDel.status === 200 && afterDel?.avatarUrl === null, 'admin: xoá avatar, về ảnh mặc định');
  const kicked = waitFor(B.socket!, 'disconnect', () => true, 5000).catch(() => null);
  const ban = await A.api('POST', `/api/admin/users/${B.id}/ban`);
  check(ban.status === 200, 'admin: khoá tài khoản');
  await kicked;
  const meBanned = await B.api('GET', '/api/auth/me');
  check(meBanned.body.user === null, 'tài khoản bị khoá mất phiên đăng nhập');
  const loginBanned = await B.api('POST', '/api/auth/login', { email: B.email, password: B.password });
  check(loginBanned.status === 403, 'tài khoản bị khoá không đăng nhập được');
  await A.api('POST', `/api/admin/users/${B.id}/unban`);
  const loginAgain = await B.api('POST', '/api/auth/login', { email: B.email, password: B.password });
  check(loginAgain.status === 200, 'mở khoá: đăng nhập lại được');

  console.log('7. Quên mật khẩu');
  await B.api('POST', '/api/auth/forgot-password', { email: B.email });
  const resetToken = await mailLink(B.email, 'reset-password');
  check(!!resetToken, 'nhận email đặt lại mật khẩu');
  const reset = await B.api('POST', '/api/auth/reset-password', { token: resetToken, password: 'matkhaumoi456' });
  check(reset.status === 200, 'đặt lại mật khẩu');
  const reuse = await B.api('POST', '/api/auth/reset-password', { token: resetToken, password: 'matkhaukhac789' });
  check(reuse.status === 400, 'link đặt lại chỉ dùng một lần');
  const oldPw = await B.api('POST', '/api/auth/login', { email: B.email, password: B.password });
  check(oldPw.status === 401, 'mật khẩu cũ không còn dùng được');
  const newPw = await B.api('POST', '/api/auth/login', { email: B.email, password: 'matkhaumoi456' });
  check(newPw.status === 200, 'đăng nhập bằng mật khẩu mới');
  const logout = await B.api('POST', '/api/auth/logout');
  const afterLogout = await B.api('GET', '/api/auth/me');
  check(logout.status === 200 && afterLogout.body.user === null, 'đăng xuất huỷ phiên');

  if (SLOW) {
    console.log('8. (chậm) Luật 30 giây nước đầu');
    await B.api('POST', '/api/auth/login', { email: B.email, password: 'matkhaumoi456' });
    B.socket?.disconnect();
    await B.connect();
    A.socket?.disconnect();
    await A.connect();
    const f1 = waitFor<{ matchId: string }>(A.socket!, 'match:found');
    await A.emit('queue:join', { game: 'xiangqi' });
    await B.emit('queue:join', { game: 'xiangqi' });
    const m = await f1;
    const g = await joinBoth(A, B, m.matchId);
    const endP = waitFor<MatchEndedDto>(g.first.socket!, 'match:ended', () => true, 40_000);
    const t0 = Date.now();
    const e = await endP;
    const dt = Date.now() - t0;
    check(e.result.reason === 'no_first_move' && e.result.winner === 1, 'Đỏ không đi nước đầu trong 30 giây: xử thua', e.result);
    check(dt > 25_000 && dt < 33_000, `kết thúc sau ~30 giây (${dt} ms)`);
    check(e.ratingChanges !== null, 'vẫn trừ điểm như thường');

    console.log('9. (chậm) Mất kết nối quá 60 giây');
    const f2 = waitFor<{ matchId: string }>(A.socket!, 'match:found');
    await A.emit('queue:join', { game: 'chess' });
    await B.emit('queue:join', { game: 'chess' });
    const m2 = await f2;
    const g2 = await joinBoth(A, B, m2.matchId);
    await g2.first.emit('match:move', { matchId: m2.matchId, move: 'e2e4' });
    await g2.second.emit('match:move', { matchId: m2.matchId, move: 'e7e5' });
    const end2 = waitFor<MatchEndedDto>(g2.first.socket!, 'match:ended', () => true, 70_000);
    g2.second.socket!.disconnect();
    const e2 = await end2;
    check(e2.result.reason === 'disconnect' && e2.result.winner === 0, 'mất kết nối quá 60 giây: xử thua', e2.result);
  }

  A.socket?.disconnect();
  B.socket?.disconnect();
  redis.disconnect();
  await prisma.$disconnect();
  console.log(`\nKết quả: ${passes} đạt, ${failures} lỗi${skipped ? `, ${skipped} bỏ qua` : ''}`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
