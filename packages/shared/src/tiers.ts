export interface TierDef {
  name: string;
  /** Điểm tối thiểu; cấp thấp nhất dùng -Infinity */
  min: number;
}

/**
 * Cấp bậc mặc định (đã chốt). Server có thể ghi đè qua biến môi trường TIERS_JSON
 * để chỉnh lại khi có dữ liệu thật; client nhận danh sách qua /api/config.
 * Thứ tự: từ cao xuống thấp.
 */
export const DEFAULT_TIERS: TierDef[] = [
  { name: 'Kỳ vương', min: 900 },
  { name: 'Đại cao thủ', min: 700 },
  { name: 'Cao thủ', min: 500 },
  { name: 'Cao cấp', min: 350 },
  { name: 'Trung cấp', min: 200 },
  { name: 'Sơ cấp', min: 100 },
  // Điểm đầu mùa là 0 → ai cũng bắt đầu ở Tân thủ (0–99)
  { name: 'Tân thủ', min: -Infinity },
];

export interface TierInfo {
  name: string;
  /** 0 = cấp thấp nhất, tăng dần */
  level: number;
}

export function getTier(rating: number, tiers: readonly TierDef[] = DEFAULT_TIERS): TierInfo {
  const idx = tiers.findIndex((t) => rating >= t.min);
  const i = idx === -1 ? tiers.length - 1 : idx;
  return { name: tiers[i].name, level: tiers.length - 1 - i };
}

export type TierChange = 'promoted' | 'demoted' | null;

export function tierChange(before: number, after: number, tiers: readonly TierDef[] = DEFAULT_TIERS): TierChange {
  const a = getTier(before, tiers).level;
  const b = getTier(after, tiers).level;
  if (b > a) return 'promoted';
  if (b < a) return 'demoted';
  return null;
}

/** Chuyển sang dạng JSON được (-Infinity -> null) */
export function serializeTiers(tiers: readonly TierDef[]): Array<{ name: string; min: number | null }> {
  return tiers.map((t) => ({ name: t.name, min: Number.isFinite(t.min) ? t.min : null }));
}

export function deserializeTiers(raw: Array<{ name: string; min: number | null }>): TierDef[] {
  return raw.map((t) => ({ name: t.name, min: t.min === null ? -Infinity : t.min }));
}

/** Kiểm tra danh sách cấp bậc: tên khác rỗng, mốc giảm dần, cấp cuối không giới hạn dưới */
export function validateTiers(tiers: readonly TierDef[]): string | null {
  if (!tiers.length) return 'Danh sách cấp bậc rỗng';
  for (let i = 0; i < tiers.length; i++) {
    if (!tiers[i].name) return `Cấp bậc #${i + 1} thiếu tên`;
    if (i > 0 && !(tiers[i].min < tiers[i - 1].min)) return 'Mốc điểm phải giảm dần';
  }
  if (tiers[tiers.length - 1].min !== -Infinity) return 'Cấp thấp nhất phải có mốc -Infinity (null)';
  return null;
}
