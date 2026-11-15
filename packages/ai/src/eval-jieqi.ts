import { jq, xq } from '@cotuong/game-core';
import { XQ_PST, XQ_VALUE } from './eval-xiangqi';

/**
 * Đánh giá thế Cờ úp (heuristic khởi điểm, chưa tinh chỉnh độ mạnh):
 * - Quân đã lật: giá trị + bảng vị trí như cờ tướng (Sĩ, Tượng đã lật không có thưởng/phạt vị trí ngoài cung / sông).
 * - Quân úp: giá trị KỲ VỌNG của kho quân chưa lộ của bên đó (tính từ thông tin công khai lúc bắt đầu tìm), không
 *   phụ thuộc danh tính trong "mẫu" đang tìm — nên ăn một quân úp được tính như ăn quân trung bình của kho.
 */

/** Giá trị kỳ vọng (centipawn) của một quân úp bên `color`: trung bình giá trị kho quân chưa lộ */
export function hiddenExpectedValue(b: jq.JieqiBoard, color: 0 | 1): number {
  let n = 0;
  let sum = 0;
  for (const t of jq.JQ_HIDDEN_TYPES) {
    const k = b.pool[color * 8 + t];
    n += k;
    sum += k * XQ_VALUE[t];
  }
  return n ? Math.round(sum / n) : 0;
}

/** Điểm theo góc nhìn bên được đi. `hidden` = [giá trị một quân úp Đỏ, giá trị một quân úp Đen] */
export function evaluateJieqi(b: jq.JieqiBoard, hidden: ArrayLike<number>): number {
  const sq = b.sq;
  let score = 0;
  for (let s = 0; s < 90; s++) {
    const p = sq[s];
    if (p === 0) continue;
    if (p & jq.HIDDEN) score += p & 8 ? -hidden[1] : hidden[0];
    else score += XQ_PST[p][s];
  }
  // Điểm nhỏ cho bên được đi (tempo)
  return (b.turn === 0 ? score : -score) + 6;
}

/** Bên `color` còn quân tấn công (Xe / Mã / Pháo đã lật, hoặc quân úp) — để quyết định null move */
export function jqHasAttackers(b: jq.JieqiBoard, color: 0 | 1): boolean {
  for (let s = 0; s < 90; s++) {
    const p = b.sq[s];
    if (p === 0 || ((p >> 3) & 1) !== color) continue;
    if (p & jq.HIDDEN) return true;
    const t = p & 7;
    if (t === xq.HORSE || t === xq.ROOK || t === xq.CANNON) return true;
  }
  return false;
}
