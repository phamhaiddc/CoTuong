import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';
import { AppConfig } from '../config';
import { RedisService } from './redis.service';

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Loại thư — mỗi loại có phần riêng trong trần gửi thư của trang (xem MAIL_SHARE_PCT) */
export type MailKind = 'register-code' | 'reset' | 'verify';

/**
 * Phần trần chung (MAIL_MAX_PER_HOUR / MAIL_MAX_PER_DAY, theo %) dành cho từng loại thư. Cộng lại 100%: một loại bị
 * dùng hết (vd ai đó xin mã đăng ký liên tục) KHÔNG lấn sang phần của loại khác — thư đặt lại mật khẩu và thư xác thực
 * vẫn đi được. Ngoại lệ duy nhất: thư đặt lại mật khẩu ĐẦU TIÊN trong 24 giờ tới một địa chỉ được dùng phần còn trống của
 * loại khác (xem sendPasswordReset).
 */
export const MAIL_SHARE_PCT: Record<MailKind, number> = { 'register-code': 70, reset: 20, verify: 10 };
/**
 * Một loại thư đã dùng quá chừng này % phần của nó (trong giờ HOẶC trong 24 giờ) → "đang bận": nơi gọi siết giới hạn
 * theo IP (vd mỗi IP chỉ còn được vài thư / giờ) để một người có vài IP không dùng hết phần còn lại của mọi người.
 */
export const MAIL_BUSY_PCT = 50;
const KIND_LABEL: Record<MailKind, string> = {
  'register-code': 'mã đăng ký',
  reset: 'đặt lại mật khẩu',
  verify: 'liên kết xác thực email',
};

/** Bộ đếm trần gửi thư toàn trang (mọi instance dùng chung): tổng mọi loại + từng loại */
const GLOBAL_HOUR_KEY = 'rl:mail-global:hour';
const GLOBAL_DAY_KEY = 'rl:mail-global:day';
const kindHourKey = (kind: MailKind) => `rl:mail-kind:${kind}:hour`;
const kindDayKey = (kind: MailKind) => `rl:mail-kind:${kind}:day`;
const HOUR_SEC = 3_600;
const DAY_SEC = 86_400;
/** Báo lỗi "chạm trần gửi thư" tối đa một lần mỗi 10 phút cho MỖI loại thư (mỗi instance) để không làm ngập log */
const CAP_ALERT_EVERY_MS = 10 * 60_000;

/**
 * Phần của một loại thư trong trần `n` (làm tròn xuống, tối thiểu 1 — trần tổng vẫn chặn khi trần rất nhỏ).
 * Xuất ra để smoke test (cli/smoke-test.ts) tính đúng trần từng loại như server.
 */
export const shareOf = (n: number, kind: MailKind) => Math.max(1, Math.floor((n * MAIL_SHARE_PCT[kind]) / 100));

/** Kết quả gửi thư */
export type MailResult =
  | { ok: true }
  /** Hết phần thư của trang cho loại này — retryAfterSec: còn bao lâu cửa sổ đếm mới mở lại */
  | { ok: false; reason: 'cap'; retryAfterSec: number }
  /** Không gửi được vì lý do khác (SMTP lỗi / chưa cấu hình, tên miền thử nghiệm…) — đã ghi log */
  | { ok: false; reason: 'error' };

/**
 * Giữ chỗ 1 thư, NGUYÊN TỬ (nhiều yêu cầu đồng thời không vượt trần): còn chỗ thì cộng cả 4 bộ đếm; hết chỗ thì không
 * cộng gì. KEYS: tổng / giờ, tổng / ngày, loại / giờ, loại / ngày. ARGV: 4 trần tương ứng, cửa sổ giờ (giây), cửa sổ
 * ngày (giây). Trả về {0, 0} = được gửi; {i, pttl} = khoá thứ i đã đầy, còn pttl ms. Cửa sổ cố định tính từ thư đầu
 * tiên (như RedisService.hit).
 */
const RESERVE_SCRIPT = `
local function win(i) if i % 2 == 1 then return ARGV[5] end return ARGV[6] end
for i = 1, 4 do
  local n = tonumber(redis.call('GET', KEYS[i]) or '0')
  if n >= tonumber(ARGV[i]) then
    local t = redis.call('PTTL', KEYS[i])
    -- Khoá lỡ không có hạn thì đặt lại hạn, để không chặn mãi
    if t == -1 then redis.call('EXPIRE', KEYS[i], win(i)); t = tonumber(win(i)) * 1000 end
    return {i, t}
  end
end
for i = 1, 4 do
  redis.call('INCR', KEYS[i])
  if redis.call('TTL', KEYS[i]) < 0 then redis.call('EXPIRE', KEYS[i], win(i)) end
end
return {0, 0}
`;

/** Tên miền dành cho thử nghiệm / không tồn tại (RFC 2606, RFC 6761, mDNS): không bao giờ nhận thư thật */
const RESERVED_TLDS = ['test', 'example', 'invalid', 'localhost', 'local'];

function isReservedDomain(address: string): boolean {
  const domain = address
    .slice(address.lastIndexOf('@') + 1)
    .trim()
    .toLowerCase()
    .replace(/\.$/, '');
  return RESERVED_TLDS.some((t) => domain === t || domain.endsWith(`.${t}`));
}

function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1');
  return h === '127.0.0.1' || h === '::1' || h === 'localhost';
}

/**
 * Gửi email giao dịch qua SMTP. Dịch vụ cụ thể chưa chốt (mục Review #5) — mọi nhà cung cấp
 * có SMTP đều dùng được. Không cấu hình SMTP_HOST: ở dev email chỉ được ghi ra log; ở production KHÔNG gửi được thư nào.
 *
 * Các hàm gửi trả về { ok: true } khi SMTP đã nhận thư (hoặc ở dev chưa cấu hình SMTP — thư được in ra log);
 * { ok: false, reason: 'cap' } khi loại thư này đã hết phần trong trần gửi thư của trang; { ok: false, reason: 'error' }
 * khi SMTP lỗi / quá thời gian chờ, production thiếu SMTP_HOST, hoặc người nhận thuộc tên miền thử nghiệm (.test,
 * .example…) trong khi SMTP là máy chủ thật.
 */
@Injectable()
export class MailService implements OnModuleInit {
  private readonly logger = new Logger('Mail');
  private readonly transporter: Transporter | null;
  /** SMTP chạy trên chính máy này (vd Mailpit khi phát triển): cho phép gửi tới tên miền thử nghiệm */
  private readonly loopbackSmtp: boolean;
  /** Lần báo "chạm trần" gần nhất và số thư bị chặn từ đó — riêng cho từng loại thư */
  private readonly capAlerts = new Map<MailKind, { at: number; suppressed: number }>();

  constructor(
    private readonly cfg: AppConfig,
    private readonly redis: RedisService,
  ) {
    const s = cfg.smtp;
    this.loopbackSmtp = !!s.host && isLoopbackHost(s.host);
    this.transporter = s.host
      ? nodemailer.createTransport({
          host: s.host,
          port: s.port,
          secure: s.secure,
          auth: s.user ? { user: s.user, pass: s.pass ?? '' } : undefined,
          // Mặc định nodemailer chờ tới 2–10 phút khi SMTP không phản hồi → đăng ký / quên mật khẩu bị treo
          connectionTimeout: 10_000,
          greetingTimeout: 10_000,
          socketTimeout: 20_000,
        })
      : null;
  }

  onModuleInit(): void {
    if (this.cfg.isProd && !this.transporter) {
      this.logger.error(
        'Chưa cấu hình SMTP_HOST: server KHÔNG gửi được email nào — mã đăng ký, liên kết xác thực và đặt lại mật khẩu đều ' +
          'không dùng được (không ai đăng ký được bằng email). Hãy cấu hình SMTP_* trong .env rồi khởi động lại.',
      );
    }
  }

  /** Báo "chạm trần gửi thư" — mỗi loại thư tối đa một lần mỗi CAP_ALERT_EVERY_MS, kèm số thư bị chặn từ lần báo trước */
  private capAlert(kind: MailKind, window: 'giờ' | '24 giờ', limit: number, total: boolean): void {
    const now = Date.now();
    const a = this.capAlerts.get(kind) ?? { at: 0, suppressed: 0 };
    if (now - a.at < CAP_ALERT_EVERY_MS) {
      a.suppressed++;
      this.capAlerts.set(kind, a);
      return;
    }
    const more = a.suppressed ? ` Từ lần báo trước còn ${a.suppressed} thư ${KIND_LABEL[kind]} khác cũng bị chặn.` : '';
    this.capAlerts.set(kind, { at: now, suppressed: 0 });
    const what = total
      ? `trần gửi thư của trang (${limit} thư / ${window}, mọi loại)`
      : `phần trần dành cho thư ${KIND_LABEL[kind]} (${limit} thư / ${window} = ${MAIL_SHARE_PCT[kind]}% trần)`;
    this.logger.error(
      `Chạm ${what} — tạm không gửi thư ${KIND_LABEL[kind]}. Kiểm tra xem có ai đang lạm dụng đăng ký / quên mật khẩu ` +
        `không; lưu lượng thật thì nâng MAIL_MAX_PER_HOUR / MAIL_MAX_PER_DAY (vẫn phải dưới hạn mức của nhà cung cấp SMTP).${more}`,
    );
  }

  /** Trần giờ / ngày của tổng và của từng loại (theo thứ tự KEYS của RESERVE_SCRIPT) */
  private limits(kind: MailKind): [number, number, number, number] {
    const h = this.cfg.mailMaxPerHour;
    const d = this.cfg.mailMaxPerDay;
    return [h, d, shareOf(h, kind), shareOf(d, kind)];
  }

  /**
   * Loại thư này đang "bận" chưa: đã dùng ≥ MAIL_BUSY_PCT% phần của nó trong giờ hoặc trong 24 giờ. Nơi gọi dùng để
   * siết giới hạn theo IP. Lỗi Redis → coi như không bận (việc gửi thư vẫn bị reserveSlot chặn đúng trần).
   */
  async isBusy(kind: MailKind): Promise<boolean> {
    try {
      const [, , hourCap, dayCap] = this.limits(kind);
      const [h, d] = await this.redis.client.mget(kindHourKey(kind), kindDayKey(kind));
      const busy = (used: string | null, cap: number) => Number(used ?? 0) * 100 >= cap * MAIL_BUSY_PCT;
      return busy(h, hourCap) || busy(d, dayCap);
    } catch {
      return false;
    }
  }

  /**
   * Giữ chỗ 1 thư trong trần chung; { ok: false, 'cap' } = hết chỗ (đã ghi log); 'error' = không kiểm tra được.
   * `overflow`: được dùng cả phần trần còn trống của loại khác (chỉ bị trần tổng chặn) — xem sendPasswordReset.
   */
  private async reserveSlot(kind: MailKind, overflow = false): Promise<MailResult> {
    const [h, d, kh, kd] = this.limits(kind);
    const limits = overflow ? [h, d, h, d] : [h, d, kh, kd];
    let r: [number, number];
    try {
      r = (await this.redis.client.eval(
        RESERVE_SCRIPT,
        4,
        GLOBAL_HOUR_KEY,
        GLOBAL_DAY_KEY,
        kindHourKey(kind),
        kindDayKey(kind),
        ...limits.map(String),
        String(HOUR_SEC),
        String(DAY_SEC),
      )) as [number, number];
    } catch (e) {
      this.logger.error(`Không kiểm tra được trần gửi thư (Redis): ${(e as Error).message}`);
      return { ok: false, reason: 'error' };
    }
    const [i, pttl] = r.map(Number);
    if (i === 0) return { ok: true };
    this.capAlert(kind, i % 2 === 1 ? 'giờ' : '24 giờ', limits[i - 1], i <= 2);
    return { ok: false, reason: 'cap', retryAfterSec: Number.isFinite(pttl) && pttl > 0 ? Math.ceil(pttl / 1000) : 60 };
  }

  private async send(kind: MailKind, to: string, subject: string, text: string, html: string, overflow = false): Promise<MailResult> {
    if (!this.transporter) {
      // Chưa cấu hình SMTP: ở môi trường dev in cả nội dung (có link) ra log để thử; production KHÔNG in link (log
      // thường được nhiều người / dịch vụ đọc — link đặt lại mật khẩu là chìa khoá vào tài khoản)
      if (this.cfg.isProd) {
        this.logger.error(`Chưa cấu hình SMTP — không gửi được email "${subject}" tới ${to}`);
        return { ok: false, reason: 'error' };
      }
      this.logger.log(`[Email tới ${to}] ${subject}\n${text}`);
      return { ok: true };
    }
    // Tên miền thử nghiệm không bao giờ nhận thư: gửi qua SMTP thật chỉ tốn hạn mức (và có thể bị nhà cung cấp phạt)
    if (!this.loopbackSmtp && isReservedDomain(to)) {
      this.logger.warn(`Không gửi email "${subject}" tới ${to}: tên miền dành cho thử nghiệm, không nhận thư thật`);
      return { ok: false, reason: 'error' };
    }
    const slot = await this.reserveSlot(kind, overflow);
    if (!slot.ok) return slot;
    try {
      // Địa chỉ dạng đối tượng: thư viện không phải tự phân tích chuỗi (tránh hiểu "Tên <địa chỉ khác>")
      await this.transporter.sendMail({
        from: this.cfg.smtp.from,
        to: { name: '', address: to },
        ...(this.cfg.smtp.replyTo ? { replyTo: this.cfg.smtp.replyTo } : {}),
        subject,
        text,
        html,
      });
      return { ok: true };
    } catch (e) {
      this.logger.error(`Gửi email tới ${to} thất bại: ${(e as Error).message}`);
      // Thư không đi: trả lại chỗ trong trần chung
      await this.redis.giveBack(GLOBAL_HOUR_KEY, GLOBAL_DAY_KEY, kindHourKey(kind), kindDayKey(kind)).catch(() => undefined);
      return { ok: false, reason: 'error' };
    }
  }

  private layout(title: string, body: string, link: string, button: string): string {
    return `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;color:#2b2118">
<h2 style="color:#a3251c">${escapeHtml(title)}</h2>
<p>${body}</p>
<p><a href="${escapeHtml(link)}" style="display:inline-block;background:#a3251c;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">${escapeHtml(button)}</a></p>
<p style="font-size:12px;color:#7a6a5a">Nếu nút không hoạt động, mở liên kết sau: ${escapeHtml(link)}</p>
</div>`;
  }

  /** Liên kết xác thực email (xem MailResult) */
  async sendVerification(to: string, username: string, link: string): Promise<MailResult> {
    const text = `Chào ${username},\n\nXác thực email để chơi xếp hạng: ${link}\n\nLiên kết có hiệu lực trong 24 giờ.`;
    return this.send(
      'verify',
      to,
      'Xác thực email tài khoản Xe Pháo Mã',
      text,
      this.layout(
        'Xác thực email',
        `Chào ${escapeHtml(username)}, bấm nút bên dưới để xác thực email và bắt đầu chơi xếp hạng. Liên kết có hiệu lực trong 24 giờ.`,
        link,
        'Xác thực email',
      ),
    );
  }

  /**
   * Mã 6 chữ số cho bước 2 của đăng ký (không đưa mã vào tiêu đề: tiêu đề hiện ra cả trên màn hình khoá / thông báo).
   * Xem MailResult
   */
  async sendRegisterCode(to: string, code: string, minutes: number): Promise<MailResult> {
    const text = `Mã xác thực đăng ký Xe Pháo Mã của bạn: ${code}\n\nMã có hiệu lực trong ${minutes} phút. Đừng chia sẻ mã này với ai. Nếu bạn không đăng ký, hãy bỏ qua email này.`;
    const html = `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;color:#2b2118">
<h2 style="color:#a3251c">Mã xác thực đăng ký</h2>
<p>Nhập mã dưới đây vào trang đăng ký Xe Pháo Mã để xác thực email của bạn:</p>
<p style="font-size:32px;font-weight:bold;letter-spacing:8px;font-family:'Courier New',monospace;background:#f6efe4;color:#2b2118;border-radius:8px;padding:14px 18px;display:inline-block;margin:6px 0">${escapeHtml(code)}</p>
<p>Mã có hiệu lực trong ${escapeHtml(String(minutes))} phút. Đừng chia sẻ mã này với ai.</p>
<p style="font-size:12px;color:#7a6a5a">Nếu bạn không đăng ký tài khoản Xe Pháo Mã, hãy bỏ qua email này.</p>
</div>`;
    return this.send('register-code', to, 'Mã xác thực đăng ký Xe Pháo Mã', text, html);
  }

  /**
   * Liên kết đặt lại mật khẩu (xem MailResult). `overflow` (nơi gọi đặt khi đây là thư đầu tiên tới địa chỉ này trong 24
   * giờ): hết phần thư đặt lại mật khẩu của trang thì vẫn được gửi bằng phần trần còn trống của loại thư khác — ai đó
   * xin thư liên tục cho vài địa chỉ không chặn được người khác lấy lại mật khẩu (trừ khi cả trần chung đã đầy).
   */
  async sendPasswordReset(to: string, username: string, link: string, opts: { overflow?: boolean } = {}): Promise<MailResult> {
    const text = `Chào ${username},\n\nĐặt lại mật khẩu: ${link}\n\nLiên kết có hiệu lực trong 1 giờ và chỉ dùng được một lần. Nếu bạn không yêu cầu, hãy bỏ qua email này.`;
    return this.send(
      'reset',
      to,
      'Đặt lại mật khẩu Xe Pháo Mã',
      text,
      this.layout(
        'Đặt lại mật khẩu',
        `Chào ${escapeHtml(username)}, bấm nút bên dưới để đặt mật khẩu mới. Liên kết có hiệu lực trong 1 giờ và chỉ dùng được một lần. Nếu bạn không yêu cầu, hãy bỏ qua email này.`,
        link,
        'Đặt lại mật khẩu',
      ),
      opts.overflow === true,
    );
  }
}
