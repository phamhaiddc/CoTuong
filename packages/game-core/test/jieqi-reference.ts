/**
 * Bộ sinh nước Cờ úp "tham chiếu" viết thẳng từ luật (chậm nhưng dễ kiểm), chỉ dùng trong test để đối chiếu
 * với JieqiBoard (bản nhanh dùng bảng tính sẵn). Chỉ đọc thông tin công khai qua `pieces()`.
 */
import type { JieqiGame } from '../src';

export interface RefPiece {
  color: 0 | 1;
  /** Loại để đi: loại thật (quân ngửa) hoặc loại gốc của ô (quân úp) */
  type: string;
  hidden: boolean;
}
export type Grid = Array<Array<RefPiece | null>>; // [file][rank]

const on = (f: number, r: number) => f >= 0 && f < 9 && r >= 0 && r < 10;
const inPalace = (c: 0 | 1, f: number, r: number) => f >= 3 && f <= 5 && (c === 0 ? r >= 0 && r <= 2 : r >= 7 && r <= 9);
const ownHalf = (c: 0 | 1, r: number) => (c === 0 ? r <= 4 : r >= 5);
const name = (f: number, r: number) => 'abcdefghi'[f] + r;
const ORTH = [
  [0, 1],
  [0, -1],
  [1, 0],
  [-1, 0],
];
const DIAG = [
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

export function gridOf(g: JieqiGame): Grid {
  const grid: Grid = Array.from({ length: 9 }, () => Array<RefPiece | null>(10).fill(null));
  for (const p of g.pieces()) {
    grid[p.square.charCodeAt(0) - 97][Number(p.square[1])] = { color: p.color, type: p.type, hidden: !!p.hidden };
  }
  return grid;
}

/** Nước giả hợp lệ [f, r, tf, tr] của bên `color` */
export function pseudoMoves(grid: Grid, color: 0 | 1): Array<[number, number, number, number]> {
  const out: Array<[number, number, number, number]> = [];
  for (let f = 0; f < 9; f++) {
    for (let r = 0; r < 10; r++) {
      const p = grid[f][r];
      if (!p || p.color !== color) continue;
      const push = (tf: number, tr: number) => {
        if (!on(tf, tr)) return;
        const q = grid[tf][tr];
        if (q && q.color === color) return;
        out.push([f, r, tf, tr]);
      };
      switch (p.type) {
        case 'k':
          for (const [df, dr] of ORTH) if (inPalace(color, f + df, r + dr)) push(f + df, r + dr);
          break;
        case 'a':
          for (const [df, dr] of DIAG) {
            // Quân úp ở ô Sĩ: Sĩ thường (trong cung); Sĩ đã lật: đi chéo ở bất kỳ đâu
            if (p.hidden && !inPalace(color, f + df, r + dr)) continue;
            push(f + df, r + dr);
          }
          break;
        case 'e':
          for (const [df, dr] of DIAG) {
            const tf = f + 2 * df;
            const tr = r + 2 * dr;
            if (!on(tf, tr) || grid[f + df][r + dr]) continue;
            if (p.hidden && !ownHalf(color, tr)) continue;
            push(tf, tr);
          }
          break;
        case 'h':
          for (const [df, dr] of [
            [1, 2],
            [-1, 2],
            [1, -2],
            [-1, -2],
            [2, 1],
            [2, -1],
            [-2, 1],
            [-2, -1],
          ]) {
            const tf = f + df;
            const tr = r + dr;
            if (!on(tf, tr)) continue;
            const [lf, lr] = Math.abs(dr) === 2 ? [f, r + dr / 2] : [f + df / 2, r];
            if (grid[lf][lr]) continue;
            push(tf, tr);
          }
          break;
        case 'r':
          for (const [df, dr] of ORTH) {
            let tf = f + df;
            let tr = r + dr;
            while (on(tf, tr)) {
              const q = grid[tf][tr];
              if (!q) out.push([f, r, tf, tr]);
              else {
                if (q.color !== color) out.push([f, r, tf, tr]);
                break;
              }
              tf += df;
              tr += dr;
            }
          }
          break;
        case 'c':
          for (const [df, dr] of ORTH) {
            let tf = f + df;
            let tr = r + dr;
            while (on(tf, tr) && !grid[tf][tr]) {
              out.push([f, r, tf, tr]);
              tf += df;
              tr += dr;
            }
            // (tf, tr) = ngòi (nếu có)
            tf += df;
            tr += dr;
            while (on(tf, tr) && !grid[tf][tr]) {
              tf += df;
              tr += dr;
            }
            if (on(tf, tr) && grid[tf][tr]!.color !== color) out.push([f, r, tf, tr]);
          }
          break;
        case 'p': {
          const fwd = color === 0 ? 1 : -1;
          push(f, r + fwd);
          const crossed = color === 0 ? r >= 5 : r <= 4;
          if (crossed) {
            push(f - 1, r);
            push(f + 1, r);
          }
          break;
        }
        default:
          throw new Error(`loại quân lạ ${p.type}`);
      }
    }
  }
  return out;
}

function kingOf(grid: Grid, color: 0 | 1): [number, number] {
  for (let f = 0; f < 9; f++) for (let r = 0; r < 10; r++) if (grid[f][r]?.type === 'k' && grid[f][r]!.color === color) return [f, r];
  throw new Error('không thấy tướng');
}

/** Tướng bên `color` có bị chiếu không: có nước giả hợp lệ của đối phương tới ô tướng, hoặc lộ mặt tướng */
export function kingAttacked(grid: Grid, color: 0 | 1): boolean {
  const [kf, kr] = kingOf(grid, color);
  const [ef, er] = kingOf(grid, color === 0 ? 1 : 0);
  if (kf === ef) {
    let clear = true;
    for (let r = Math.min(kr, er) + 1; r < Math.max(kr, er); r++) if (grid[kf][r]) clear = false;
    if (clear) return true;
  }
  return pseudoMoves(grid, color === 0 ? 1 : 0).some(([, , tf, tr]) => tf === kf && tr === kr);
}

/** Danh sách nước hợp lệ (đã sắp xếp) theo bộ tham chiếu */
export function refLegalMoves(g: JieqiGame): string[] {
  const grid = gridOf(g);
  const us = g.turn();
  const out: string[] = [];
  for (const [f, r, tf, tr] of pseudoMoves(grid, us)) {
    const p = grid[f][r];
    const q = grid[tf][tr];
    grid[tf][tr] = p;
    grid[f][r] = null;
    if (!kingAttacked(grid, us)) out.push(name(f, r) + name(tf, tr));
    grid[f][r] = p;
    grid[tf][tr] = q;
  }
  return out.sort();
}

export function refInCheck(g: JieqiGame): boolean {
  return kingAttacked(gridOf(g), g.turn());
}
