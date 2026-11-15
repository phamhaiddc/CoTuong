import type { Color } from '../types';
import { ADVISOR, CANNON, ELEPHANT, KING, PAWN, ROOK, fileOf, rankOf } from './board';

/**
 * Ký hiệu nước đi cờ tướng kiểu Việt Nam (sách cờ, biên bản giải đấu), ví dụ "P2-5", "M8.7", "X1/1", "Xt.1".
 *
 * Nguồn đối chiếu:
 *  - Wikipedia tiếng Việt "Cờ tướng", mục "Cách ghi nước đi" → Hệ thống 2 ("hệ thống ghi chép được dùng phổ biến
 *    ở Việt Nam"): https://vi.wikipedia.org/wiki/C%E1%BB%9D_t%C6%B0%E1%BB%9Bng
 *  - Biên bản 79 ván của Giải cờ tướng Các danh thủ quốc tế – Cúp Phương Trang lần VI (2023), bulletin trên trang
 *    Liên đoàn Cờ Việt Nam: https://vietnamchess.vn/document/2023/futa6-bulletin-full.pdf
 *
 * Quy tắc đã xác minh (hai nguồn trên):
 *  - Quân: Tg (Tướng), S (Sĩ), T (Tượng), M (Mã), X (Xe), P (Pháo), B (Tốt / Binh).
 *  - Cột 1–9 đếm từ phải sang trái theo hướng nhìn của bên đi (mỗi bên tự đếm).
 *  - "." = tấn (tiến), "/" = thoái (lùi), "-" = bình (đi ngang).
 *  - Quân đi thẳng (Tg, X, P, B): tấn / thoái ghi số bước; bình ghi cột mới.
 *  - Quân đi chéo (S, T, M): ghi cột mới.
 *  - Hai Xe / Mã / Pháo cùng bên trên một cột: luôn thay số cột bằng t (trước) / s (sau), ví dụ "Pt-5", "Xs.3".
 *    "Trước" = gần phía đối phương hơn (theo hướng tiến của bên đi).
 *  - Hai Sĩ / Tượng trên một cột: vẫn ghi số cột (bulletin: 27 nước, không nước nào dùng t / s) — cờ tướng thường
 *    không bao giờ nhầm vì quân trước chỉ lùi được, quân sau chỉ tiến được.
 *  - Không ghi dấu chiếu tướng / ăn quân (biên bản của Liên đoàn không dùng; Hệ thống 2 không nêu).
 *
 * Tốt cùng cột: bulletin ghi "Bt.1" / "Bs.1" khi cả hai Tốt cùng tiến được (7 nước) nhưng ghi số cột khi Tốt đi ngang
 * (5 nước, ví dụ "B7-6"). Ở đây: chỉ dùng chữ vị trí khi ghi số cột sẽ nhầm với quân kia — khớp 11/12 nước của bulletin
 * (nước còn lại, "B4-5", chính bulletin cũng ghi nhầm được hai cách).
 *
 * Chưa xác minh (chọn cách dễ đọc, không nhầm — đánh dấu "chưa xác minh" ở từng chỗ):
 *  - Ba Tốt trên một cột (t, g, s) và bốn Tốt (t, tg, sg, s); năm Tốt t, tg, g, sg, s theo Wikipedia.
 *  - Hai cột cùng có từ hai Tốt trở lên: thêm số cột sau chữ vị trí, ví dụ "Bt7.1".
 *  - Cờ úp: Sĩ / Tượng đã lật đi tự do nên hai quân cùng cột có thể cho cùng ký hiệu → khi đó mới dùng t / s.
 */

/** Ký hiệu viết tắt tiếng Việt của loại quân (index = loại quân của game-core) */
export const XQ_TYPE_ABBR_VI = ['', 'Tg', 'S', 'T', 'M', 'X', 'P', 'B'] as const;

/** Mã quân dùng để nhóm "cùng loại": bit úp (16, Cờ úp) + màu (8) + loại (0..7) */
const GROUP_MASK = 31;

/** Chữ vị trí khi nhiều quân cùng loại đứng trên một cột, xếp từ trước ra sau */
const POSITION_NAMES: Readonly<Record<number, readonly string[]>> = {
  2: ['t', 's'],
  3: ['t', 'g', 's'], // chưa xác minh (suy từ danh sách 5 Tốt của Wikipedia)
  4: ['t', 'tg', 'sg', 's'], // chưa xác minh
  5: ['t', 'tg', 'g', 'sg', 's'],
};

/** Số cột 1–9 theo hướng nhìn của bên `color` (cột đếm từ phải sang trái); `file` 0..8 = a..i */
export function xqFileNumberVi(file: number, color: Color): number {
  return color === 0 ? 9 - file : file + 1;
}

const isStraightMover = (type: number) => type === KING || type === ROOK || type === CANNON || type === PAWN;

/** Phần hướng đi + số: ".1", "/2", "-5" */
function motionOf(piece: number, from: number, to: number): string {
  const color = ((piece >> 3) & 1) as Color;
  const fr = rankOf(from);
  const tr = rankOf(to);
  if (tr === fr) return `-${xqFileNumberVi(fileOf(to), color)}`;
  const forward = color === 0 ? tr > fr : tr < fr;
  const n = isStraightMover(piece & 7) ? Math.abs(tr - fr) : xqFileNumberVi(fileOf(to), color);
  return `${forward ? '.' : '/'}${n}`;
}

/**
 * Ký hiệu tiếng Việt của nước `from` → `to` (toạ độ ô 0..89 của game-core), tính trên thế cờ TRƯỚC khi đi.
 *
 * @param sq mảng 90 ô mã quân (XiangqiBoard.sq hoặc JieqiBoard.sq): (màu << 3) | loại; Cờ úp có thể kèm bit úp 16 —
 *           quân úp đi theo loại gốc của ô nên được ký hiệu theo loại đó.
 * @param legal các nước hợp lệ của thế này (from | to << 7, như board.legalMoves()) — để biết Tốt / Sĩ / Tượng
 *              cùng cột có cần chữ t / s không.
 */
export function xqMoveNotationVi(sq: ArrayLike<number>, from: number, to: number, legal: ArrayLike<number>): string {
  const piece = sq[from];
  if (!piece) return '';
  const color = ((piece >> 3) & 1) as Color;
  const type = piece & 7;
  const group = piece & GROUP_MASK;
  const file = fileOf(from);
  const abbr = XQ_TYPE_ABBR_VI[type];
  const motion = motionOf(piece, from, to);
  const fileNo = String(xqFileNumberVi(file, color));

  // Các quân cùng nhóm trên cột này, xếp từ trước ra sau theo hướng tiến của bên đi
  const stacked: number[] = [];
  for (let r = 0; r < 10; r++) {
    const s = r * 9 + file;
    if (sq[s] && (sq[s] & GROUP_MASK) === group) stacked.push(s);
  }
  if (color === 0) stacked.reverse();
  if (stacked.length < 2) return abbr + fileNo + motion;

  if (type === PAWN || type === ADVISOR || type === ELEPHANT) {
    // Chỉ dùng chữ vị trí khi một quân khác cùng cột có nước hợp lệ cho đúng cùng ký hiệu
    let ambiguous = false;
    for (let i = 0; i < legal.length && !ambiguous; i++) {
      const f2 = legal[i] & 127;
      if (f2 !== from && fileOf(f2) === file && sq[f2] && (sq[f2] & GROUP_MASK) === group) {
        ambiguous = motionOf(sq[f2], f2, legal[i] >> 7) === motion;
      }
    }
    if (!ambiguous) return abbr + fileNo + motion;
  }

  const pos = POSITION_NAMES[stacked.length]?.[stacked.indexOf(from)];
  if (!pos) return abbr + fileNo + motion;
  // Chưa xác minh: cột khác cũng có từ hai quân cùng nhóm (chỉ xảy ra với Tốt) → thêm số cột cho khỏi nhầm
  let otherStack = false;
  for (let f = 0; f < 9 && !otherStack; f++) {
    if (f === file) continue;
    let n = 0;
    for (let r = 0; r < 10; r++) {
      const v = sq[r * 9 + f];
      if (v && (v & GROUP_MASK) === group) n++;
    }
    otherStack = n >= 2;
  }
  return abbr + pos + (otherStack ? fileNo : '') + motion;
}
