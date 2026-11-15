/** UUID đúng dạng 8-4-4-4-12 (cột @db.Uuid của Postgres báo lỗi với chuỗi sai dạng → phải chặn trước khi truy vấn) */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

/** Số trang từ query (?page=): số nguyên 1..max; giá trị lạ (Infinity, NaN, mảng…) → 1 */
export function pageParam(raw: unknown, max = 10_000): number {
  const n = Math.floor(Number(typeof raw === 'string' || typeof raw === 'number' ? raw : NaN));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, max) : 1;
}

/** Tham số chuỗi từ query: chỉ nhận chuỗi (?q=a&q=b cho ra mảng → bỏ) */
export const stringParam = (raw: unknown): string => (typeof raw === 'string' ? raw : '');
