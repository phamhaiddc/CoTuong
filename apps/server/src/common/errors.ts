/** Thông tin thêm gửi kèm thân lỗi JSON của API (AllExceptionsFilter trải các trường này vào thân lỗi) */
export interface GameErrorExtra {
  /** Số giây nên chờ trước khi thử lại — cũng được gửi trong header Retry-After */
  retryAfterSec?: number;
  /** Số lần thử còn lại (vd nhập mã xác thực) */
  attemptsLeft?: number;
}

export interface GameErrorOptions extends GameErrorExtra {
  /** Mã HTTP trả về (mặc định 400) */
  status?: number;
}

/** Lỗi nghiệp vụ có thông báo hiển thị được cho người chơi (tiếng Việt) */
export class GameError extends Error {
  /** Mã HTTP khi lỗi đi ra qua API (WebSocket không dùng) */
  readonly status: number;
  readonly extra: GameErrorExtra;

  constructor(
    message: string,
    readonly code?: string,
    opts: GameErrorOptions = {},
  ) {
    super(message);
    const { status, ...extra } = opts;
    this.status = status ?? 400;
    // Bỏ các trường undefined để thân lỗi gọn
    this.extra = Object.fromEntries(Object.entries(extra).filter(([, v]) => v !== undefined)) as GameErrorExtra;
  }
}
