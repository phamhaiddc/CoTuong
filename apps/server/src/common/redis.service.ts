import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { randomBytes } from 'crypto';
import { AppConfig } from '../config';
import { GameError } from './errors';

/** Xoá khoá chỉ khi giá trị đúng bằng ARGV[1] — dùng cả để mở khoá (giá trị = token của khoá) */
const DEL_IF_EQUALS_SCRIPT = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;
/** Gia hạn khoá — chỉ khi khoá vẫn đúng là của mình (token) */
const RENEW_SCRIPT = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const HIT_SCRIPT = `
local n = redis.call('INCR', KEYS[1])
if redis.call('TTL', KEYS[1]) < 0 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return n
`;

/**
 * Trả lại một lượt cho mỗi bộ đếm: chỉ giảm khi khoá còn và giá trị > 0 — không tạo khoá mới (khoá không có hạn),
 * không xuống dưới 0. DECR giữ nguyên hạn của khoá.
 */
const GIVE_BACK_SCRIPT = `
for i = 1, #KEYS do
  local raw = redis.call('GET', KEYS[i])
  local v = raw and tonumber(raw)
  if v and v > 0 then redis.call('DECR', KEYS[i]) end
end
return 1
`;

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger('Redis');
  readonly client: Redis;

  constructor(cfg: AppConfig) {
    this.client = new Redis(cfg.redisUrl, { maxRetriesPerRequest: 3, enableReadyCheck: true });
    this.client.on('error', (e) => this.logger.error(e.message));
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit().catch(() => undefined);
  }

  async getJson<T>(key: string): Promise<T | null> {
    const raw = await this.client.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  }

  /** Xoá khoá nếu giá trị đúng bằng `value` (tránh xoá nhầm giá trị mới hơn) */
  async delIfEquals(key: string, value: string): Promise<boolean> {
    const n = (await this.client.eval(DEL_IF_EQUALS_SCRIPT, 1, key, value)) as number;
    return n === 1;
  }

  async tryLock(key: string, ttlMs: number): Promise<string | null> {
    const token = randomBytes(12).toString('hex');
    const ok = await this.client.set(key, token, 'PX', ttlMs, 'NX');
    return ok === 'OK' ? token : null;
  }

  async unlock(key: string, token: string): Promise<void> {
    await this.delIfEquals(key, token);
  }

  /**
   * Giữ khoá đã lấy (tryLock) trong lúc việc còn chạy: cứ ttl/3 gia hạn lại ttl, chỉ khi khoá vẫn là của mình, tối đa
   * `maxHoldMs` kể từ lúc gọi (việc treo hẳn thì khoá vẫn tự hết hạn, không kẹt mãi). Trả về hàm dừng gia hạn.
   */
  keepLock(key: string, token: string, ttlMs: number, maxHoldMs: number): () => void {
    const until = Date.now() + maxHoldMs;
    const timer = setInterval(
      () => {
        if (Date.now() >= until) {
          clearInterval(timer);
          return;
        }
        this.client
          .eval(RENEW_SCRIPT, 1, key, token, String(ttlMs))
          .then((n) => {
            // Khoá đã mất (hết hạn / bị lấy) thì thôi gia hạn
            if (Number(n) !== 1) clearInterval(timer);
          })
          .catch(() => undefined);
      },
      Math.max(500, Math.floor(ttlMs / 3)),
    );
    timer.unref?.();
    return () => clearInterval(timer);
  }

  /**
   * Chạy fn khi giữ khoá phân tán (nhiều instance server). Chờ tối đa waitMs để lấy khoá.
   * `keepAliveMs`: gia hạn khoá trong lúc fn còn chạy (tối đa chừng đó ms) — dùng khi fn có thể chờ DB lâu hơn ttl,
   * không thì khoá hết hạn giữa chừng và nơi khác chen vào xử lý cùng dữ liệu.
   */
  async withLock<T>(
    key: string,
    fn: () => Promise<T>,
    opts: { ttlMs?: number; waitMs?: number; keepAliveMs?: number } = {},
  ): Promise<T> {
    const ttl = opts.ttlMs ?? 10_000;
    const deadline = Date.now() + (opts.waitMs ?? 4_000);
    let token = await this.tryLock(key, ttl);
    while (!token) {
      if (Date.now() > deadline) throw new GameError('Hệ thống đang bận, vui lòng thử lại', 'busy');
      await sleep(15 + Math.random() * 25);
      token = await this.tryLock(key, ttl);
    }
    const stop = opts.keepAliveMs ? this.keepLock(key, token, ttl, opts.keepAliveMs) : null;
    try {
      return await fn();
    } finally {
      stop?.();
      await this.unlock(key, token).catch(() => undefined);
    }
  }

  /** Giới hạn tần suất: trả về false nếu đã gọi trong khoảng windowMs */
  async rateLimitOnce(key: string, windowMs: number): Promise<boolean> {
    return (await this.client.set(key, '1', 'PX', windowMs, 'NX')) === 'OK';
  }

  /**
   * Đếm một lần trong cửa sổ windowSec giây, trả về số lần hiện tại; nguyên tử (Lua) và luôn đảm bảo khoá có hạn (kể
   * cả khi lần trước lỡ đặt hạn)
   */
  async hit(key: string, windowSec: number): Promise<number> {
    const n = await this.client.eval(HIT_SCRIPT, 1, key, String(windowSec));
    return Number(n);
  }

  /** Trả lại lượt đã đếm bằng hit() (vd thư gửi thất bại); khoá đã hết hạn / bằng 0 thì bỏ qua */
  async giveBack(...keys: string[]): Promise<void> {
    if (keys.length) await this.client.eval(GIVE_BACK_SCRIPT, keys.length, ...keys);
  }
}
