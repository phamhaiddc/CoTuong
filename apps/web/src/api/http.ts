import type { ApiErrorBody, AppConfigDto } from '@cotuong/shared';

/** Thông tin thêm trong thân lỗi JSON của máy chủ (xem ApiErrorBody) */
export interface ApiErrorExtra {
  /** Số giây nên chờ trước khi thử lại (429) */
  retryAfterSec?: number;
  /** Số lần nhập mã còn lại (reg_code_wrong) */
  attemptsLeft?: number;
}

export class ApiError extends Error {
  readonly retryAfterSec?: number;
  readonly attemptsLeft?: number;
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    extra: ApiErrorExtra = {},
  ) {
    super(message);
    this.retryAfterSec = extra.retryAfterSec;
    this.attemptsLeft = extra.attemptsLeft;
  }
}

/** Số nguyên không âm trong thân lỗi; giá trị lạ thì bỏ qua */
function count(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.ceil(v) : undefined;
}

/** Gọi khi máy chủ báo phiên không còn hợp lệ (401) — AuthProvider đăng ký để tải lại trạng thái đăng nhập */
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  onUnauthorized = fn;
}
/** Các API mà 401 là kết quả bình thường (sai mật khẩu…), không phải phiên hết hạn */
const AUTH_FLOW = /^\/api\/auth\/(login|register|me|forgot-password|reset-password|verify-email)(\/|\?|$)/;

/** Lỗi mạng (không gửi được yêu cầu / không nhận được trả lời) */
export const NETWORK_ERROR_MESSAGE = 'Không kết nối được. Bạn kiểm tra mạng rồi thử lại nhé.';

/**
 * Một số thông báo của máy chủ còn dùng từ kỹ thuật — đổi sang lời dễ hiểu cho người chơi.
 * (Nên sửa luôn ở máy chủ; giữ bảng này để giao diện không phụ thuộc vào việc đó.)
 */
const FRIENDLY: Record<string, string> = {
  'Mật khẩu quá dài (tối đa 72 byte)': 'Mật khẩu quá dài: tối đa 72 ký tự (mỗi chữ có dấu tính là 2–3 ký tự).',
  'Bạn cần đăng nhập': 'Bạn cần đăng nhập để làm việc này.',
  'Không tìm thấy': 'Không tìm thấy nội dung bạn cần.',
  'Lỗi hệ thống, vui lòng thử lại sau': 'Có lỗi xảy ra. Bạn thử lại sau ít phút nhé.',
};

/** Câu báo lỗi dễ hiểu khi máy chủ không gửi kèm lời nhắn (vd trang đang khởi động lại, mạng chập chờn) */
function statusMessage(status: number): string {
  if (status === 401) return 'Bạn cần đăng nhập để làm việc này.';
  if (status === 403) return 'Bạn không có quyền làm việc này.';
  if (status === 404) return 'Không tìm thấy nội dung bạn cần.';
  if (status === 413) return 'Tệp quá lớn.';
  if (status === 429) return 'Bạn thao tác quá nhanh. Đợi một chút rồi thử lại nhé.';
  if (status >= 500) return 'Xe Pháo Mã đang gặp trục trặc. Bạn thử lại sau ít phút nhé.';
  return 'Có lỗi xảy ra. Bạn thử lại nhé.';
}

/**
 * Tra lời nhắn theo mã (vd. ?oauthError= trên đường dẫn — ai cũng gửi được đường dẫn tuỳ ý). Chỉ lấy khoá của chính
 * bảng: mã lạ như "__proto__", "constructor" trả về đồ vật / hàm của Object chứ không phải chữ, vẽ ra làm hỏng trang.
 * Mã không có trong bảng thì dùng `fallback`.
 */
export function messageFor(table: Record<string, string>, code: string, fallback: string): string {
  return Object.prototype.hasOwnProperty.call(table, code) ? table[code] : fallback;
}

export function friendlyMessage(message: string | undefined | null, status: number): string {
  if (!message) return statusMessage(status);
  return messageFor(FRIENDLY, message, message);
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined || isForm ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(NETWORK_ERROR_MESSAGE, 0);
  }
  let text = '';
  try {
    text = await res.text();
  } catch {
    throw new ApiError(NETWORK_ERROR_MESSAGE, 0);
  }
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    if (res.status === 401 && !AUTH_FLOW.test(path)) onUnauthorized?.();
    const d = data !== null && typeof data === 'object' ? (data as Partial<Record<keyof ApiErrorBody, unknown>>) : null;
    const msg = typeof d?.message === 'string' ? d.message : null;
    const code = typeof d?.code === 'string' ? d.code : undefined;
    // Lỗi 5xx do máy chủ tự sinh có lời nhắn chung; lỗi do proxy/mạng (502–504, trang HTML…) thì không có
    throw new ApiError(friendlyMessage(msg, res.status), res.status, code, {
      retryAfterSec: count(d?.retryAfterSec),
      attemptsLeft: count(d?.attemptsLeft),
    });
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  del: <T>(path: string) => request<T>('DELETE', path),
  upload: <T>(path: string, form: FormData) => request<T>('POST', path, form),
};

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/** Lỗi do mạng / máy chủ tạm thời (đáng thử lại), không phải do người dùng nhập sai */
export function isTransientError(e: unknown): boolean {
  return e instanceof ApiError ? e.status === 0 || e.status === 408 || e.status === 429 || e.status >= 500 : true;
}

/** Cấu hình công khai (/api/config) — tải một lần, dùng chung (cấp bậc, nút đăng nhập mạng xã hội…) */
let configPromise: Promise<AppConfigDto> | null = null;
export function loadAppConfig(): Promise<AppConfigDto> {
  configPromise ??= api.get<AppConfigDto>('/api/config').catch((e) => {
    configPromise = null; // lần sau thử lại
    throw e;
  });
  return configPromise;
}
