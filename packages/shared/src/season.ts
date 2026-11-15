import { SEASON_UTC_OFFSET_HOURS } from './constants';

const OFFSET_MS = SEASON_UTC_OFFSET_HOURS * 3_600_000;
const DAY_MS = 86_400_000;

export type Quarter = 1 | 2 | 3 | 4;

export interface QuarterRef {
  year: number;
  quarter: Quarter;
}

/** Quý chứa thời điểm `at`, tính theo GMT+7 */
export function quarterOf(at: Date | number): QuarterRef {
  const t = new Date(+at + OFFSET_MS);
  return { year: t.getUTCFullYear(), quarter: (Math.floor(t.getUTCMonth() / 3) + 1) as Quarter };
}

/** Mốc bắt đầu (00:00 GMT+7 ngày đầu quý) và kết thúc (00:00 GMT+7 ngày đầu quý sau, không bao gồm) */
export function quarterBounds(q: QuarterRef): { startAt: Date; endAt: Date } {
  const start = Date.UTC(q.year, (q.quarter - 1) * 3, 1) - OFFSET_MS;
  const end = (q.quarter === 4 ? Date.UTC(q.year + 1, 0, 1) : Date.UTC(q.year, q.quarter * 3, 1)) - OFFSET_MS;
  return { startAt: new Date(start), endAt: new Date(end) };
}

/** Số ngày còn lại của mùa (làm tròn lên) */
export function daysLeft(endAt: Date | number | string, now: Date | number = Date.now()): number {
  return Math.max(0, Math.ceil((+new Date(endAt) - +now) / DAY_MS));
}

export function seasonLabel(q: QuarterRef): string {
  return `Quý ${q.quarter}/${q.year}`;
}
