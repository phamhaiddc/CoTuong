/**
 * Giới hạn tốc độ kiểu "xô token" trong bộ nhớ (mỗi instance), theo người dùng + loại thao tác.
 * Dùng cho sự kiện realtime: rẻ, không gọi Redis mỗi sự kiện. Người dùng nối vào nhiều instance thì mỗi nơi giới hạn
 * riêng — đủ để chặn spam từ một kết nối.
 */
export interface BucketRule {
  /** Số thao tác tối đa dồn một lúc */
  capacity: number;
  /** Số thao tác được nạp lại mỗi giây */
  perSecond: number;
}

interface Bucket {
  tokens: number;
  at: number;
}

export class TokenBucketLimiter<K extends string> {
  private readonly buckets = new Map<string, Bucket>();
  private lastSweep = Date.now();

  constructor(private readonly rules: Record<K, BucketRule>) {}

  /** Lấy một lượt; false nếu đã hết lượt (bỏ thao tác này) */
  take(userId: string, kind: K, now = Date.now()): boolean {
    const rule = this.rules[kind];
    const key = `${kind}:${userId}`;
    const b = this.buckets.get(key) ?? { tokens: rule.capacity, at: now };
    b.tokens = Math.min(rule.capacity, b.tokens + ((now - b.at) / 1000) * rule.perSecond);
    b.at = now;
    const ok = b.tokens >= 1;
    if (ok) b.tokens -= 1;
    this.buckets.set(key, b);
    if (now - this.lastSweep > 60_000) this.sweep(now);
    return ok;
  }

  /** Bỏ các xô đã đầy lại lâu (không giữ bộ nhớ cho người đã rời đi) */
  private sweep(now: number): void {
    this.lastSweep = now;
    for (const [key, b] of this.buckets) if (now - b.at > 120_000) this.buckets.delete(key);
  }
}
