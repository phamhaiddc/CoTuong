import { Logger } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { availableParallelism, cpus } from 'os';
import { Worker } from 'worker_threads';
import { GameError } from '../common/errors';

/** Số vòng bcrypt (2^10) — đổi số này thì mọi băm mới đổi theo; băm cũ vẫn kiểm tra được (số vòng nằm trong băm) */
export const BCRYPT_ROUNDS = 10;
/** Số luồng phụ băm mật khẩu: chừa ít nhất một lõi cho luồng chính (ván cờ, socket); tối đa 2 */
const WORKERS = Math.min(2, Math.max(1, (typeof availableParallelism === 'function' ? availableParallelism() : cpus().length) - 1));
/**
 * Số việc được xếp hàng chờ (ngoài các việc đang chạy), riêng cho từng hàng; hàng đầy → 503 "máy chủ đang bận" ngay,
 * không xếp thêm. Một lần băm ~0,1 giây → 16 việc chờ ≈ chờ thêm tối đa ~1 giây.
 */
const MAX_QUEUE = 16;
/** Việc chờ trong hàng quá chừng này (máy chủ quá tải) → trả 503 "bận" thay vì để yêu cầu treo */
const MAX_WAIT_MS = 5_000;
/**
 * Công bằng giữa hai hàng: hàng 'high' được ưu tiên, nhưng cứ chừng này việc 'high' liên tiếp mà hàng 'low' có việc chờ
 * thì lấy một việc 'low' — hàng 'high' bị dồn đầy (vd ai đó dùng nhiều trình duyệt quen) không làm hàng 'low' chờ mãi.
 */
const HIGH_BURST = 3;
/** Báo "hàng chờ đầy" vào log tối đa một lần mỗi phút cho mỗi hàng */
const FULL_ALERT_EVERY_MS = 60_000;
/** Một việc chạy quá lâu (luồng phụ treo): huỷ luồng đó, tạo luồng mới */
const JOB_TIMEOUT_MS = 15_000;
/** Luồng phụ hỏng liên tục (quá chừng này lần trong 1 phút) → thôi tạo lại, chạy trên luồng chính */
const MAX_CRASHES_PER_MIN = 5;
/** Bảng chữ base64 riêng của bcrypt */
const BCRYPT_ALPHABET = './ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Hàng ưu tiên: 'high' = người đã chứng minh được gì đó (trình duyệt quen của tài khoản, phiếu đăng ký đã nhập đúng mã,
 * liên kết đặt lại mật khẩu) — được xử lý trước (cứ HIGH_BURST việc thì nhường hàng 'low' một việc); 'low' = yêu cầu ẩn
 * danh (đăng nhập từ trình duyệt lạ…). Ai đó gửi hàng loạt yêu cầu đăng nhập chỉ làm đầy hàng 'low', không chặn được
 * người dùng quen; việc chờ quá MAX_WAIT_MS bị trả 503 "bận" (không có yêu cầu nào treo mãi).
 */
export type PasswordPriority = 'high' | 'low';

/** Mã chạy trong luồng phụ: nhận việc, băm / so sánh bằng bcryptjs (đồng bộ — chỉ chặn luồng phụ), trả kết quả */
const WORKER_SOURCE = `
const { parentPort, workerData } = require('worker_threads');
const bcrypt = require(workerData.bcryptPath);
parentPort.on('message', (m) => {
  try {
    const r = m.op === 'hash' ? bcrypt.hashSync(m.pw, m.rounds) : bcrypt.compareSync(m.pw, m.hash);
    parentPort.postMessage({ id: m.id, r });
  } catch (e) {
    parentPort.postMessage({ id: m.id, err: String((e && e.message) || e) });
  }
});
`;

/** `at` = thời điểm vào hàng chờ (ms) */
type Job = { id: number; at?: number } & (
  | { op: 'hash'; pw: string; rounds: number; resolve: (v: string) => void; reject: (e: Error) => void }
  | { op: 'compare'; pw: string; hash: string; resolve: (v: boolean) => void; reject: (e: Error) => void }
);

interface Slot {
  worker: Worker | null;
  job: Job | null;
  timer: NodeJS.Timeout | null;
}

/** 503 'busy': máy chủ đang bận kiểm tra mật khẩu — thử lại sau vài giây */
export const passwordBusyError = () =>
  new GameError('Máy chủ đang bận, bạn thử lại sau vài giây nhé', 'busy', { status: 503, retryAfterSec: 5 });
const busyError = passwordBusyError;

/**
 * Băm / kiểm tra mật khẩu (bcrypt) NGOÀI luồng chính. bcryptjs là JavaScript thuần: chạy trên luồng chính thì mỗi lần
 * kiểm tra chặn server ~100 ms — hàng loạt yêu cầu đăng nhập (kể cả email không tồn tại) làm đứng mọi ván cờ và socket,
 * và thời gian đứng bị tính vào đồng hồ của người đang chơi. Ở đây việc chạy trong 1–2 luồng phụ (worker_threads), có
 * hàng chờ GIỚI HẠN: quá tải thì trả 503 ngay thay vì dồn việc. Không tạo được luồng phụ (hiếm) thì chạy bcryptjs bất
 * đồng bộ trên luồng chính, vẫn qua cùng số chỗ + hàng chờ giới hạn.
 *
 * Không phải provider của Nest: dùng chung một bộ cho cả tiến trình (`passwords`); luồng phụ chỉ tạo khi cần lần đầu và
 * không giữ tiến trình sống khi rảnh.
 */
export class PasswordService {
  private readonly logger = new Logger('Password');
  private readonly slots: Slot[] = [];
  private readonly queues: Record<PasswordPriority, Job[]> = { high: [], low: [] };
  private seq = 0;
  private started = false;
  private closed = false;
  /** Các lần luồng phụ hỏng gần đây (ms) — hỏng liên tục thì chuyển hẳn sang luồng chính */
  private crashes: number[] = [];
  private noWorkers = false;
  /** Số việc 'high' vừa chạy liên tiếp trong khi hàng 'low' có việc chờ (xem HIGH_BURST) */
  private highStreak = 0;
  /** Lần báo "hàng chờ đầy" gần nhất của từng hàng, và số yêu cầu bị từ chối từ đó */
  private readonly fullAlerts: Record<PasswordPriority, { at: number; rejected: number }> = {
    high: { at: 0, rejected: 0 },
    low: { at: 0, rejected: 0 },
  };

  /** Kiểm tra mật khẩu; ném GameError 503 'busy' khi hàng chờ đầy */
  compare(password: string, hash: string, priority: PasswordPriority = 'low'): Promise<boolean> {
    return new Promise((resolve, reject) =>
      this.enqueue({ id: ++this.seq, op: 'compare', pw: password, hash, resolve, reject }, priority),
    );
  }

  /** Băm mật khẩu mới; ném GameError 503 'busy' khi hàng chờ đầy */
  hash(password: string, priority: PasswordPriority = 'low'): Promise<string> {
    return new Promise((resolve, reject) =>
      this.enqueue({ id: ++this.seq, op: 'hash', pw: password, rounds: BCRYPT_ROUNDS, resolve, reject }, priority),
    );
  }

  /**
   * Băm "không dùng được": đúng định dạng bcrypt ($2a$10$ + 53 ký tự ngẫu nhiên) nhưng không phải băm của mật khẩu
   * nào (không ai tìm được mật khẩu khớp) — cho khách / tài khoản tạo từ Google, Facebook. Không tốn CPU để tạo; kiểm
   * tra với nó tốn đúng như một tài khoản thật (dùng làm băm giả khi email không tồn tại).
   */
  unusableHash(): string {
    const bytes = randomBytes(53);
    let s = '';
    for (const b of bytes) s += BCRYPT_ALPHABET[b & 63];
    return `$2a$${String(BCRYPT_ROUNDS).padStart(2, '0')}$${s}`;
  }

  /** Việc mới ở hàng `priority` lúc này có bị từ chối (503) không — để nơi gọi từ chối sớm, trước khi làm việc khác */
  saturated(priority: PasswordPriority = 'low'): boolean {
    if (this.closed) return true;
    if (!this.started || this.slots.some((s) => !s.job)) return false;
    this.dropExpired(Date.now());
    if (this.queues[priority].length < MAX_QUEUE) return false;
    this.noteFull(priority);
    return true;
  }

  /** Bỏ các việc đã chờ quá MAX_WAIT_MS (trả 503 "bận") — hàng chờ theo thứ tự vào nên việc quá hạn nằm ở đầu */
  private dropExpired(now: number): void {
    for (const q of [this.queues.high, this.queues.low]) {
      while (q.length && now - (q[0].at ?? now) > MAX_WAIT_MS) q.shift()!.reject(busyError());
    }
  }

  /** Hàng chờ đầy: ghi cảnh báo (tối đa một lần mỗi phút cho mỗi hàng, kèm số yêu cầu bị từ chối từ lần báo trước) */
  private noteFull(priority: PasswordPriority): void {
    const a = this.fullAlerts[priority];
    const now = Date.now();
    a.rejected++;
    if (now - a.at < FULL_ALERT_EVERY_MS) return;
    this.logger.warn(
      `Hàng chờ kiểm tra mật khẩu '${priority}' đầy — đã từ chối ${a.rejected} yêu cầu (503 "bận") từ lần báo trước. ` +
        'Có thể có người gửi dồn yêu cầu đăng nhập; xem giới hạn trong auth.service.ts.',
    );
    a.at = now;
    a.rejected = 0;
  }

  /** Số việc đang chạy / đang chờ (để kiểm thử, theo dõi) */
  stats(): { running: number; high: number; low: number; workers: number } {
    return {
      running: this.slots.filter((s) => s.job).length,
      high: this.queues.high.length,
      low: this.queues.low.length,
      workers: this.slots.filter((s) => s.worker).length,
    };
  }

  /** Dừng mọi luồng phụ, từ chối việc đang chờ (kiểm thử / tắt tiến trình) */
  async close(): Promise<void> {
    this.closed = true;
    for (const j of [...this.queues.high.splice(0), ...this.queues.low.splice(0)]) j.reject(busyError());
    await Promise.all(
      this.slots.map(async (s) => {
        if (s.timer) clearTimeout(s.timer);
        const w = s.worker;
        s.worker = null;
        w?.removeAllListeners();
        await w?.terminate().catch(() => undefined);
      }),
    );
  }

  private enqueue(job: Job, priority: PasswordPriority): void {
    if (this.closed) return job.reject(busyError());
    this.start();
    const free = this.slots.find((s) => !s.job);
    if (free) return this.run(free, job);
    const now = Date.now();
    this.dropExpired(now);
    const q = this.queues[priority];
    if (q.length >= MAX_QUEUE) {
      this.noteFull(priority);
      return job.reject(busyError());
    }
    job.at = now;
    q.push(job);
  }

  /** Việc kế tiếp: ưu tiên hàng 'high', nhưng cứ HIGH_BURST việc 'high' liên tiếp thì nhường một việc 'low' đang chờ */
  private nextJob(): Job | undefined {
    this.dropExpired(Date.now());
    const { high, low } = this.queues;
    if (!low.length) {
      this.highStreak = 0;
      return high.shift();
    }
    if (high.length && this.highStreak < HIGH_BURST) {
      this.highStreak++;
      return high.shift();
    }
    this.highStreak = 0;
    return low.shift();
  }

  private start(): void {
    if (this.started) return;
    this.started = true;
    for (let i = 0; i < WORKERS; i++) this.slots.push({ worker: this.spawn(), job: null, timer: null });
  }

  private spawn(): Worker | null {
    if (this.noWorkers || this.closed) return null;
    try {
      const w = new Worker(WORKER_SOURCE, { eval: true, workerData: { bcryptPath: require.resolve('bcryptjs') } });
      // Luồng phụ rảnh không giữ tiến trình sống (CLI, tắt server); khi đang có việc thì ref() lại (xem run)
      w.unref();
      w.on('message', (m: { id: number; r?: unknown; err?: string }) => this.onResult(w, m));
      w.on('error', (e) => this.onCrash(w, e));
      w.on('exit', (code) => this.onCrash(w, new Error(`luồng băm mật khẩu dừng (mã ${code})`)));
      return w;
    } catch (e) {
      this.logger.error(`Không tạo được luồng phụ băm mật khẩu, chạy trên luồng chính: ${(e as Error).message}`);
      return null;
    }
  }

  private run(slot: Slot, job: Job): void {
    slot.job = job;
    if (!slot.worker) {
      // Dự phòng: bcryptjs bất đồng bộ trên luồng chính (chia nhỏ việc, vẫn bị giới hạn bởi số chỗ + hàng chờ)
      const p: Promise<unknown> = job.op === 'hash' ? bcrypt.hash(job.pw, job.rounds) : bcrypt.compare(job.pw, job.hash);
      p.then(
        (r) => this.finish(slot, job, r, null),
        (e: unknown) => this.finish(slot, job, null, e instanceof Error ? e : new Error(String(e))),
      );
      return;
    }
    const w = slot.worker;
    w.ref();
    slot.timer = setTimeout(() => {
      this.logger.error('Băm mật khẩu quá lâu — khởi động lại luồng phụ');
      this.onCrash(w, new Error('quá thời gian'));
      void w.terminate().catch(() => undefined);
    }, JOB_TIMEOUT_MS);
    const msg = job.op === 'hash' ? { id: job.id, op: 'hash', pw: job.pw, rounds: job.rounds } : { id: job.id, op: 'compare', pw: job.pw, hash: job.hash };
    w.postMessage(msg);
  }

  private onResult(w: Worker, m: { id: number; r?: unknown; err?: string }): void {
    const slot = this.slots.find((s) => s.worker === w);
    if (!slot?.job || slot.job.id !== m.id) return;
    this.finish(slot, slot.job, m.r, m.err === undefined ? null : new Error(m.err));
  }

  /** Luồng phụ lỗi / dừng: báo lỗi cho việc đang chạy, thay bằng luồng mới (hỏng liên tục → chạy trên luồng chính) */
  private onCrash(w: Worker, e: Error): void {
    const slot = this.slots.find((s) => s.worker === w);
    if (!slot) return;
    w.removeAllListeners();
    if (!this.closed) {
      const now = Date.now();
      this.crashes = [...this.crashes.filter((t) => now - t < 60_000), now];
      if (this.crashes.length > MAX_CRASHES_PER_MIN && !this.noWorkers) {
        this.noWorkers = true;
        this.logger.error(`Luồng phụ băm mật khẩu hỏng liên tục (${e.message}) — chuyển sang chạy trên luồng chính`);
      }
    }
    slot.worker = this.spawn();
    if (slot.job) this.finish(slot, slot.job, null, e);
  }

  private finish(slot: Slot, job: Job, r: unknown, err: Error | null): void {
    if (slot.job !== job) return;
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = null;
    slot.job = null;
    if (err) {
      this.logger.error(`Băm / kiểm tra mật khẩu lỗi: ${err.message}`);
      job.reject(err);
    } else if (job.op === 'hash') {
      if (typeof r === 'string') job.resolve(r);
      else job.reject(new Error('kết quả băm không hợp lệ'));
    } else job.resolve(r === true);
    const next = this.nextJob();
    if (next) this.run(slot, next);
    else slot.worker?.unref();
  }
}

/** Bộ băm mật khẩu dùng chung cho cả tiến trình */
export const passwords = new PasswordService();
