import { xq } from '@cotuong/game-core';

/**
 * Đánh giá thế cờ tướng: giá trị quân + bảng vị trí (piece-square tables).
 * Bảng viết theo góc nhìn của Đỏ, hàng đầu tiên = rank 9 (hàng cuối của Đen).
 * Các con số là heuristic khởi điểm, chỉnh lại khi test độ mạnh.
 */

export const XQ_VALUE = [0, 0, 110, 110, 280, 600, 300, 40];

// prettier-ignore
const PAWN = [
   0,  0,  0,  5, 10,  5,  0,  0,  0,
  30, 40, 55, 70, 80, 70, 55, 40, 30,
  30, 40, 50, 60, 65, 60, 50, 40, 30,
  25, 35, 40, 50, 55, 50, 40, 35, 25,
  15, 20, 25, 30, 35, 30, 25, 20, 15,
   0,  0,  5,  0, 10,  0,  5,  0,  0,
   0,  0,  0,  0,  5,  0,  0,  0,  0,
   0,  0,  0,  0,  0,  0,  0,  0,  0,
   0,  0,  0,  0,  0,  0,  0,  0,  0,
   0,  0,  0,  0,  0,  0,  0,  0,  0,
];
// prettier-ignore
const HORSE = [
   4,  8, 16, 12,  4, 12, 16,  8,  4,
   4, 10, 28, 16,  8, 16, 28, 10,  4,
  12, 14, 16, 20, 18, 20, 16, 14, 12,
   8, 24, 18, 24, 20, 24, 18, 24,  8,
   6, 16, 14, 18, 16, 18, 14, 16,  6,
   4, 12, 16, 14, 12, 14, 16, 12,  4,
   2,  6,  8,  6, 10,  6,  8,  6,  2,
   4,  2,  8,  8,  4,  8,  8,  2,  4,
   0,  2,  4,  4, -2,  4,  4,  2,  0,
   0, -4,  0,  0,  0,  0,  0, -4,  0,
];
// prettier-ignore
const ROOK = [
  14, 14, 12, 18, 16, 18, 12, 14, 14,
  16, 20, 18, 24, 26, 24, 18, 20, 16,
  12, 12, 12, 18, 18, 18, 12, 12, 12,
  12, 18, 16, 22, 22, 22, 16, 18, 12,
  12, 14, 12, 18, 18, 18, 12, 14, 12,
  12, 16, 14, 20, 20, 20, 14, 16, 12,
   6, 10,  8, 14, 14, 14,  8, 10,  6,
   4,  8,  6, 14, 12, 14,  6,  8,  4,
   8,  4,  8, 16,  8, 16,  8,  4,  8,
  -2, 10,  6, 14, 12, 14,  6, 10, -2,
];
// prettier-ignore
const CANNON = [
   6,  4,  0,-10,-12,-10,  0,  4,  6,
   2,  2,  0, -4,-14, -4,  0,  2,  2,
   2,  2,  0,-10, -8,-10,  0,  2,  2,
   0,  0, -2,  4, 10,  4, -2,  0,  0,
   0,  0,  0,  2,  8,  2,  0,  0,  0,
  -2,  0,  4,  2,  6,  2,  4,  0, -2,
   0,  0,  0,  2,  4,  2,  0,  0,  0,
   4,  0,  8,  6, 10,  6,  8,  0,  4,
   0,  2,  4,  6,  6,  6,  4,  2,  0,
   0,  0,  2,  6,  6,  6,  2,  0,  0,
];
// prettier-ignore
const ADVISOR = [
  0,0,0,0,0,0,0,0,0, 0,0,0,0,0,0,0,0,0, 0,0,0,0,0,0,0,0,0, 0,0,0,0,0,0,0,0,0, 0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0, 0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,
  0,0,0,0,3,0,0,0,0,
  0,0,0,0,0,0,0,0,0,
];
// prettier-ignore
const ELEPHANT = [
  0,0,0,0,0,0,0,0,0, 0,0,0,0,0,0,0,0,0, 0,0,0,0,0,0,0,0,0, 0,0,0,0,0,0,0,0,0, 0,0,0,0,0,0,0,0,0,
  0,0,-1,0,0,0,-1,0,0,
  0,0,0,0,0,0,0,0,0,
  -2,0,0,0,3,0,0,0,-2,
  0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,
];
// prettier-ignore
const KING = [
  0,0,0,0,0,0,0,0,0, 0,0,0,0,0,0,0,0,0, 0,0,0,0,0,0,0,0,0, 0,0,0,0,0,0,0,0,0, 0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0, 0,0,0,0,0,0,0,0,0,
  0,0,0,-15,-15,-15,0,0,0,
  0,0,0, -8, -8, -8,0,0,0,
  0,0,0, -2,  0, -2,0,0,0,
];

const TABLES = [null, KING, ADVISOR, ELEPHANT, HORSE, ROOK, CANNON, PAWN];

/** PST[piece][sq]: giá trị (đã gồm giá trị quân), dương cho Đỏ, âm cho Đen */
export const XQ_PST: Int32Array[] = [];
for (let p = 0; p < 16; p++) {
  const arr = new Int32Array(90);
  const type = p & 7;
  const color = p >> 3;
  const table = TABLES[type];
  if (table && type !== 0 && p !== 8) {
    for (let s = 0; s < 90; s++) {
      const f = s % 9;
      const r = (s / 9) | 0;
      // Đỏ: hàng hiển thị = 9 - r. Đen: lật dọc => hàng hiển thị = r
      const idx = color === 0 ? (9 - r) * 9 + f : r * 9 + (8 - f);
      const v = XQ_VALUE[type] + table[idx];
      arr[s] = color === 0 ? v : -v;
    }
  }
  XQ_PST.push(arr);
}

export function evaluateXiangqi(b: xq.XiangqiBoard): number {
  const sq = b.sq;
  let score = 0;
  for (let s = 0; s < 90; s++) {
    const p = sq[s];
    if (p) score += XQ_PST[p][s];
  }
  // Điểm nhỏ cho bên được đi (tempo)
  return (b.turn === 0 ? score : -score) + 6;
}

export function xqHasAttackers(b: xq.XiangqiBoard, color: 0 | 1): boolean {
  for (let s = 0; s < 90; s++) {
    const p = b.sq[s];
    if (p && p >> 3 === color) {
      const t = p & 7;
      if (t === xq.ROOK || t === xq.HORSE || t === xq.CANNON) return true;
    }
  }
  return false;
}
