import { cb } from '@cotuong/game-core';

/**
 * Đánh giá thế cờ vua: giá trị quân + bảng vị trí theo "Simplified Evaluation Function".
 * Bảng viết theo góc nhìn của Trắng, hàng đầu tiên = rank 8.
 */

export const CHESS_VALUE = [0, 100, 320, 330, 500, 900, 0];

// prettier-ignore
const PAWN = [
   0,  0,  0,  0,  0,  0,  0,  0,
  50, 50, 50, 50, 50, 50, 50, 50,
  10, 10, 20, 30, 30, 20, 10, 10,
   5,  5, 10, 25, 25, 10,  5,  5,
   0,  0,  0, 20, 20,  0,  0,  0,
   5, -5,-10,  0,  0,-10, -5,  5,
   5, 10, 10,-20,-20, 10, 10,  5,
   0,  0,  0,  0,  0,  0,  0,  0,
];
// prettier-ignore
const KNIGHT = [
  -50,-40,-30,-30,-30,-30,-40,-50,
  -40,-20,  0,  0,  0,  0,-20,-40,
  -30,  0, 10, 15, 15, 10,  0,-30,
  -30,  5, 15, 20, 20, 15,  5,-30,
  -30,  0, 15, 20, 20, 15,  0,-30,
  -30,  5, 10, 15, 15, 10,  5,-30,
  -40,-20,  0,  5,  5,  0,-20,-40,
  -50,-40,-30,-30,-30,-30,-40,-50,
];
// prettier-ignore
const BISHOP = [
  -20,-10,-10,-10,-10,-10,-10,-20,
  -10,  0,  0,  0,  0,  0,  0,-10,
  -10,  0,  5, 10, 10,  5,  0,-10,
  -10,  5,  5, 10, 10,  5,  5,-10,
  -10,  0, 10, 10, 10, 10,  0,-10,
  -10, 10, 10, 10, 10, 10, 10,-10,
  -10,  5,  0,  0,  0,  0,  5,-10,
  -20,-10,-10,-10,-10,-10,-10,-20,
];
// prettier-ignore
const ROOK = [
   0,  0,  0,  0,  0,  0,  0,  0,
   5, 10, 10, 10, 10, 10, 10,  5,
  -5,  0,  0,  0,  0,  0,  0, -5,
  -5,  0,  0,  0,  0,  0,  0, -5,
  -5,  0,  0,  0,  0,  0,  0, -5,
  -5,  0,  0,  0,  0,  0,  0, -5,
  -5,  0,  0,  0,  0,  0,  0, -5,
   0,  0,  0,  5,  5,  0,  0,  0,
];
// prettier-ignore
const QUEEN = [
  -20,-10,-10, -5, -5,-10,-10,-20,
  -10,  0,  0,  0,  0,  0,  0,-10,
  -10,  0,  5,  5,  5,  5,  0,-10,
   -5,  0,  5,  5,  5,  5,  0, -5,
    0,  0,  5,  5,  5,  5,  0, -5,
  -10,  5,  5,  5,  5,  5,  0,-10,
  -10,  0,  5,  0,  0,  0,  0,-10,
  -20,-10,-10, -5, -5,-10,-10,-20,
];
// prettier-ignore
const KING_MID = [
  -30,-40,-40,-50,-50,-40,-40,-30,
  -30,-40,-40,-50,-50,-40,-40,-30,
  -30,-40,-40,-50,-50,-40,-40,-30,
  -30,-40,-40,-50,-50,-40,-40,-30,
  -20,-30,-30,-40,-40,-30,-30,-20,
  -10,-20,-20,-20,-20,-20,-20,-10,
   20, 20,  0,  0,  0,  0, 20, 20,
   20, 30, 10,  0,  0, 10, 30, 20,
];
// prettier-ignore
const KING_END = [
  -50,-40,-30,-20,-20,-30,-40,-50,
  -30,-20,-10,  0,  0,-10,-20,-30,
  -30,-10, 20, 30, 30, 20,-10,-30,
  -30,-10, 30, 40, 40, 30,-10,-30,
  -30,-10, 30, 40, 40, 30,-10,-30,
  -30,-10, 20, 30, 30, 20,-10,-30,
  -30,-30,  0,  0,  0,  0,-30,-30,
  -50,-30,-30,-30,-30,-30,-30,-50,
];

const TABLES = [null, PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING_MID];

function build(tableFor: (type: number) => number[] | null): Int32Array[] {
  const out: Int32Array[] = [];
  for (let p = 0; p < 16; p++) {
    const arr = new Int32Array(64);
    const type = p & 7;
    const color = p >> 3;
    const table = type >= 1 && type <= 6 && p !== 8 ? tableFor(type) : null;
    if (table) {
      for (let s = 0; s < 64; s++) {
        const f = s & 7;
        const r = s >> 3;
        const idx = color === 0 ? (7 - r) * 8 + f : r * 8 + f;
        const v = CHESS_VALUE[type] + table[idx];
        arr[s] = color === 0 ? v : -v;
      }
    }
    out.push(arr);
  }
  return out;
}

export const CHESS_PST_MID = build((t) => TABLES[t]);
export const CHESS_PST_END = build((t) => (t === 6 ? KING_END : TABLES[t]));

export function evaluateChess(b: cb.ChessBoard): number {
  const sq = b.sq;
  // Tàn cuộc: tổng quân (trừ tốt, vua) của hai bên <= 1 hậu + 1 xe + ...
  let material = 0;
  for (let s = 0; s < 64; s++) {
    const p = sq[s];
    if (p) {
      const t = p & 7;
      if (t !== cb.PAWN && t !== cb.KING) material += CHESS_VALUE[t];
    }
  }
  const pst = material <= 1600 ? CHESS_PST_END : CHESS_PST_MID;
  let score = 0;
  for (let s = 0; s < 64; s++) {
    const p = sq[s];
    if (p) score += pst[p][s];
  }
  return (b.turn === 0 ? score : -score) + 10;
}

export function chessHasPieces(b: cb.ChessBoard, color: 0 | 1): boolean {
  for (let s = 0; s < 64; s++) {
    const p = b.sq[s];
    if (p && p >> 3 === color) {
      const t = p & 7;
      if (t !== cb.PAWN && t !== cb.KING) return true;
    }
  }
  return false;
}
