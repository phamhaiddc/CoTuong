import type { Color } from '../types';
import { seededRandom, zobristTable } from '../zobrist';

/**
 * Bàn cờ tướng mức thấp (dùng cho luật và AI).
 *
 * Ô: sq = rank * 9 + file. file 0..8 (a..i, trái sang phải nhìn từ phía Đỏ),
 * rank 0..9 (0 = hàng cuối của Đỏ). Trùng với toạ độ ICCS: "a0" = góc dưới trái của Đỏ.
 *
 * Quân: (color << 3) | type. Đỏ 1..7, Đen 9..15, 0 = ô trống.
 * Nước đi: from | (to << 7).
 */

export const X_RANKS = 10;
export const X_SQUARES = 90;

export const KING = 1;
export const ADVISOR = 2;
export const ELEPHANT = 3;
export const HORSE = 4;
export const ROOK = 5;
export const CANNON = 6;
export const PAWN = 7;

export const XIANGQI_START_FEN = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1';

export const pieceColor = (p: number): Color => (p >> 3) as Color;
export const pieceType = (p: number): number => p & 7;
export const makePiece = (color: Color, type: number): number => (color << 3) | type;

export const sqOf = (file: number, rank: number): number => rank * 9 + file;
export const fileOf = (s: number): number => s % 9;
export const rankOf = (s: number): number => (s / 9) | 0;

export const encodeMove = (from: number, to: number): number => from | (to << 7);
export const moveFrom = (m: number): number => m & 127;
export const moveTo = (m: number): number => m >> 7;

// ---------------------------------------------------------------------------
// Bảng nước đi tính sẵn
// ---------------------------------------------------------------------------

const onBoard = (f: number, r: number) => f >= 0 && f < 9 && r >= 0 && r < 10;
const inPalace = (f: number, r: number) => f >= 3 && f <= 5 && ((r >= 0 && r <= 2) || (r >= 7 && r <= 9));
const redHalf = (r: number) => r <= 4;

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
const HORSE_DELTAS = [
  [1, 2],
  [-1, 2],
  [1, -2],
  [-1, -2],
  [2, 1],
  [2, -1],
  [-2, 1],
  [-2, -1],
];

/** Ô đích của tướng (trong cung) */
export const KING_MOVES: number[][] = [];
/** Ô đích của sĩ (chéo, trong cung) */
export const ADVISOR_MOVES: number[][] = [];
/** Cặp [đích, mắt tượng] — tượng không qua sông */
export const ELEPHANT_MOVES: number[][] = [];
/** Cặp [đích, chân mã] */
export const HORSE_MOVES: number[][] = [];
/** Cặp [ô mã đứng, chân mã] để mã tấn công ô này */
export const HORSE_ATTACKERS: number[][] = [];
/** RAYS[sq][dir]: dir 0 = lên (rank+1), 1 = xuống, 2 = phải (file+1), 3 = trái */
export const RAYS: number[][][] = [];
/** PAWN_MOVES[color][sq] */
export const PAWN_MOVES: number[][][] = [[], []];
/** PAWN_ATTACKERS[color][sq]: các ô mà tốt bên `color` đứng sẽ tấn công sq */
export const PAWN_ATTACKERS: number[][][] = [[], []];

for (let s = 0; s < X_SQUARES; s++) {
  const f = fileOf(s);
  const r = rankOf(s);

  KING_MOVES[s] = [];
  ADVISOR_MOVES[s] = [];
  if (inPalace(f, r)) {
    for (const [df, dr] of ORTH) {
      if (inPalace(f + df, r + dr) && redHalf(r + dr) === redHalf(r)) KING_MOVES[s].push(sqOf(f + df, r + dr));
    }
    for (const [df, dr] of DIAG) {
      if (inPalace(f + df, r + dr) && redHalf(r + dr) === redHalf(r)) ADVISOR_MOVES[s].push(sqOf(f + df, r + dr));
    }
  }

  ELEPHANT_MOVES[s] = [];
  for (const [df, dr] of DIAG) {
    const tf = f + 2 * df;
    const tr = r + 2 * dr;
    if (onBoard(tf, tr) && redHalf(tr) === redHalf(r)) {
      ELEPHANT_MOVES[s].push(sqOf(tf, tr), sqOf(f + df, r + dr));
    }
  }

  HORSE_MOVES[s] = [];
  HORSE_ATTACKERS[s] = [];
  for (const [df, dr] of HORSE_DELTAS) {
    const tf = f + df;
    const tr = r + dr;
    if (onBoard(tf, tr)) {
      const leg = Math.abs(dr) === 2 ? sqOf(f, r + dr / 2) : sqOf(f + df / 2, r);
      HORSE_MOVES[s].push(sqOf(tf, tr), leg);
    }
    // Mã đứng ở (f - df, r - dr) nhảy tới s
    const hf = f - df;
    const hr = r - dr;
    if (onBoard(hf, hr)) {
      const leg = Math.abs(dr) === 2 ? sqOf(hf, hr + dr / 2) : sqOf(hf + df / 2, hr);
      HORSE_ATTACKERS[s].push(sqOf(hf, hr), leg);
    }
  }

  RAYS[s] = [];
  for (const [df, dr] of ORTH) {
    const ray: number[] = [];
    let tf = f + df;
    let tr = r + dr;
    while (onBoard(tf, tr)) {
      ray.push(sqOf(tf, tr));
      tf += df;
      tr += dr;
    }
    RAYS[s].push(ray);
  }

  // Tốt Đỏ đi lên (rank+1), qua sông (rank >= 5) được đi ngang
  const red: number[] = [];
  if (r + 1 <= 9) red.push(sqOf(f, r + 1));
  if (r >= 5) {
    if (f > 0) red.push(sqOf(f - 1, r));
    if (f < 8) red.push(sqOf(f + 1, r));
  }
  PAWN_MOVES[0][s] = red;
  // Tốt Đen đi xuống (rank-1), qua sông (rank <= 4) được đi ngang
  const black: number[] = [];
  if (r - 1 >= 0) black.push(sqOf(f, r - 1));
  if (r <= 4) {
    if (f > 0) black.push(sqOf(f - 1, r));
    if (f < 8) black.push(sqOf(f + 1, r));
  }
  PAWN_MOVES[1][s] = black;

  const redAtt: number[] = [];
  if (r - 1 >= 0) redAtt.push(sqOf(f, r - 1));
  if (r >= 5) {
    if (f > 0) redAtt.push(sqOf(f - 1, r));
    if (f < 8) redAtt.push(sqOf(f + 1, r));
  }
  PAWN_ATTACKERS[0][s] = redAtt;
  const blackAtt: number[] = [];
  if (r + 1 <= 9) blackAtt.push(sqOf(f, r + 1));
  if (r <= 4) {
    if (f > 0) blackAtt.push(sqOf(f - 1, r));
    if (f < 8) blackAtt.push(sqOf(f + 1, r));
  }
  PAWN_ATTACKERS[1][s] = blackAtt;
}

// ---------------------------------------------------------------------------
// Zobrist
// ---------------------------------------------------------------------------

const Z = zobristTable(16, X_SQUARES, 0x58514731);
const sideRnd = seededRandom(0x51de);
const Z_SIDE_LO = sideRnd();
const Z_SIDE_HI = sideRnd();

const LETTER_TO_TYPE: Record<string, number> = {
  k: KING,
  a: ADVISOR,
  b: ELEPHANT,
  e: ELEPHANT,
  n: HORSE,
  h: HORSE,
  r: ROOK,
  c: CANNON,
  p: PAWN,
};
const TYPE_TO_FEN = ['', 'k', 'a', 'b', 'n', 'r', 'c', 'p'];

/**
 * Quân đứng ở ô mà luật cờ tướng không bao giờ cho tới được: Tướng / Sĩ ngoài các điểm trong cung, Tượng ngoài 7 điểm
 * bên mình, Tốt lùi sau hàng tốt xuất phát. Trả về mô tả lỗi, hoặc null nếu hợp lệ.
 */
function placementError(color: Color, type: number, file: number, rank: number): string | null {
  // Toạ độ tính từ phía bên `color` (0 = hàng cuối của bên đó)
  const r = color === 0 ? rank : 9 - rank;
  const at = `${'abcdefghi'[file]}${rank}`;
  if (type === KING && !(file >= 3 && file <= 5 && r <= 2)) return `tướng nằm ngoài cung (${at})`;
  if (type === ADVISOR && !(file >= 3 && file <= 5 && r <= 2 && (file + r) % 2 === 1)) return `sĩ đứng sai chỗ (${at})`;
  if (type === ELEPHANT && !(r <= 4 && r % 2 === 0 && file % 2 === 0 && (r / 2 + file / 2) % 2 === 1)) {
    return `tượng đứng sai chỗ (${at})`;
  }
  if (type === PAWN && r < 3) return `tốt đứng sau hàng tốt (${at})`;
  return null;
}

export class XiangqiBoard {
  readonly sq = new Int8Array(X_SQUARES);
  turn: Color = 0;
  fullmove = 1;
  readonly kingSq = new Int16Array([-1, -1]);
  hashLo = 0;
  hashHi = 0;
  /** Ngăn xếp huỷ nước: [move, captured, hashLo, hashHi] */
  private readonly undoStack: number[] = [];

  constructor(fen: string = XIANGQI_START_FEN) {
    this.setFen(fen);
  }

  setFen(fen: string): void {
    const parts = fen.trim().split(/\s+/);
    const rows = (parts[0] ?? '').split('/');
    if (rows.length !== X_RANKS) throw new Error('FEN cờ tướng không hợp lệ: cần 10 hàng');
    this.sq.fill(0);
    this.kingSq[0] = -1;
    this.kingSq[1] = -1;
    for (let i = 0; i < X_RANKS; i++) {
      const rank = 9 - i;
      let file = 0;
      for (const ch of rows[i]) {
        if (ch >= '1' && ch <= '9') {
          file += ch.charCodeAt(0) - 48;
          continue;
        }
        const type = LETTER_TO_TYPE[ch.toLowerCase()];
        if (!type || file > 8) throw new Error(`FEN cờ tướng không hợp lệ: "${ch}"`);
        const color: Color = ch === ch.toUpperCase() ? 0 : 1;
        const s = sqOf(file, rank);
        const where = placementError(color, type, file, rank);
        if (where) throw new Error(`FEN cờ tướng không hợp lệ: ${where}`);
        this.sq[s] = makePiece(color, type);
        if (type === KING) {
          if (this.kingSq[color] >= 0) throw new Error('FEN cờ tướng không hợp lệ: nhiều hơn 1 tướng');
          this.kingSq[color] = s;
        }
        file++;
      }
      if (file !== 9) throw new Error('FEN cờ tướng không hợp lệ: hàng không đủ 9 cột');
    }
    if (this.kingSq[0] < 0 || this.kingSq[1] < 0) throw new Error('FEN cờ tướng không hợp lệ: thiếu tướng');
    this.turn = parts[1] === 'b' ? 1 : 0;
    // Bên vừa đi không thể còn bị chiếu / lộ mặt tướng (nếu không, bên được đi sẽ "ăn tướng")
    if (this.isKingAttacked((1 - this.turn) as Color)) throw new Error('FEN cờ tướng không hợp lệ: bên vừa đi đang bị chiếu');
    const fm = parseInt(parts[5] ?? '1', 10);
    this.fullmove = Number.isFinite(fm) && fm > 0 ? fm : 1;
    this.undoStack.length = 0;
    this.recomputeHash();
  }

  private recomputeHash(): void {
    let lo = 0;
    let hi = 0;
    for (let s = 0; s < X_SQUARES; s++) {
      const p = this.sq[s];
      if (p) {
        lo ^= Z.lo[p * X_SQUARES + s];
        hi ^= Z.hi[p * X_SQUARES + s];
      }
    }
    if (this.turn === 1) {
      lo ^= Z_SIDE_LO;
      hi ^= Z_SIDE_HI;
    }
    this.hashLo = lo;
    this.hashHi = hi;
  }

  placement(): string {
    let out = '';
    for (let rank = 9; rank >= 0; rank--) {
      let empty = 0;
      for (let file = 0; file < 9; file++) {
        const p = this.sq[sqOf(file, rank)];
        if (!p) {
          empty++;
          continue;
        }
        if (empty) {
          out += empty;
          empty = 0;
        }
        const letter = TYPE_TO_FEN[pieceType(p)];
        out += pieceColor(p) === 0 ? letter.toUpperCase() : letter;
      }
      if (empty) out += empty;
      if (rank > 0) out += '/';
    }
    return out;
  }

  fen(): string {
    return `${this.placement()} ${this.turn === 0 ? 'w' : 'b'} - - 0 ${this.fullmove}`;
  }

  /** Khoá thế cờ chính xác (vị trí quân + bên đi) để xét lặp nước */
  positionKey(): string {
    return `${this.placement()} ${this.turn === 0 ? 'w' : 'b'}`;
  }

  /** Tướng bên `color` có đang bị chiếu không (kể cả lộ mặt tướng) */
  isKingAttacked(color: Color): boolean {
    const k = this.kingSq[color];
    if (k < 0) return false;
    const by = (1 - color) as Color;
    const b = this.sq;
    const rays = RAYS[k];
    for (let dir = 0; dir < 4; dir++) {
      const ray = rays[dir];
      const n = ray.length;
      let i = 0;
      while (i < n && b[ray[i]] === 0) i++;
      if (i === n) continue;
      let p = b[ray[i]];
      if (p >> 3 === by) {
        const t = p & 7;
        if (t === ROOK) return true;
        // Lộ mặt tướng: hai tướng cùng cột, không có quân ở giữa
        if (t === KING && dir < 2) return true;
      }
      i++;
      while (i < n && b[ray[i]] === 0) i++;
      if (i < n) {
        p = b[ray[i]];
        if (p >> 3 === by && (p & 7) === CANNON) return true;
      }
    }
    const horse = makePiece(by, HORSE);
    const ha = HORSE_ATTACKERS[k];
    for (let i = 0; i < ha.length; i += 2) {
      if (b[ha[i]] === horse && b[ha[i + 1]] === 0) return true;
    }
    const pawn = makePiece(by, PAWN);
    const pa = PAWN_ATTACKERS[by][k];
    for (let i = 0; i < pa.length; i++) {
      if (b[pa[i]] === pawn) return true;
    }
    return false;
  }

  inCheck(): boolean {
    return this.isKingAttacked(this.turn);
  }

  /** Sinh nước giả hợp lệ (chưa kiểm tra tự để tướng bị chiếu). */
  generateMoves(capturesOnly = false): number[] {
    const out: number[] = [];
    const us = this.turn;
    const b = this.sq;
    const add = (from: number, to: number) => {
      const q = b[to];
      if (q === 0) {
        if (!capturesOnly) out.push(from | (to << 7));
      } else if (q >> 3 !== us) {
        out.push(from | (to << 7));
      }
    };
    for (let s = 0; s < X_SQUARES; s++) {
      const p = b[s];
      if (p === 0 || p >> 3 !== us) continue;
      switch (p & 7) {
        case KING: {
          const t = KING_MOVES[s];
          for (let i = 0; i < t.length; i++) add(s, t[i]);
          break;
        }
        case ADVISOR: {
          const t = ADVISOR_MOVES[s];
          for (let i = 0; i < t.length; i++) add(s, t[i]);
          break;
        }
        case ELEPHANT: {
          const t = ELEPHANT_MOVES[s];
          for (let i = 0; i < t.length; i += 2) if (b[t[i + 1]] === 0) add(s, t[i]);
          break;
        }
        case HORSE: {
          const t = HORSE_MOVES[s];
          for (let i = 0; i < t.length; i += 2) if (b[t[i + 1]] === 0) add(s, t[i]);
          break;
        }
        case ROOK: {
          const rays = RAYS[s];
          for (let d = 0; d < 4; d++) {
            const ray = rays[d];
            for (let i = 0; i < ray.length; i++) {
              const t = ray[i];
              const q = b[t];
              if (q === 0) {
                if (!capturesOnly) out.push(s | (t << 7));
              } else {
                if (q >> 3 !== us) out.push(s | (t << 7));
                break;
              }
            }
          }
          break;
        }
        case CANNON: {
          const rays = RAYS[s];
          for (let d = 0; d < 4; d++) {
            const ray = rays[d];
            const n = ray.length;
            let i = 0;
            while (i < n && b[ray[i]] === 0) {
              if (!capturesOnly) out.push(s | (ray[i] << 7));
              i++;
            }
            i++; // bỏ qua ngòi
            while (i < n && b[ray[i]] === 0) i++;
            if (i < n && b[ray[i]] >> 3 !== us) out.push(s | (ray[i] << 7));
          }
          break;
        }
        case PAWN: {
          const t = PAWN_MOVES[us][s];
          for (let i = 0; i < t.length; i++) add(s, t[i]);
          break;
        }
      }
    }
    return out;
  }

  /**
   * Đi nước m. Trả về false (và tự huỷ nước) nếu nước này để tướng mình bị chiếu.
   */
  makeMove(m: number): boolean {
    const from = m & 127;
    const to = m >> 7;
    const b = this.sq;
    const piece = b[from];
    const cap = b[to];
    this.undoStack.push(m, cap, this.hashLo, this.hashHi);
    b[to] = piece;
    b[from] = 0;
    const us = this.turn;
    if ((piece & 7) === KING) this.kingSq[us] = to;
    let lo = this.hashLo ^ Z.lo[piece * X_SQUARES + from] ^ Z.lo[piece * X_SQUARES + to] ^ Z_SIDE_LO;
    let hi = this.hashHi ^ Z.hi[piece * X_SQUARES + from] ^ Z.hi[piece * X_SQUARES + to] ^ Z_SIDE_HI;
    if (cap) {
      lo ^= Z.lo[cap * X_SQUARES + to];
      hi ^= Z.hi[cap * X_SQUARES + to];
    }
    this.hashLo = lo;
    this.hashHi = hi;
    this.turn = (1 - us) as Color;
    if (us === 1) this.fullmove++;
    if (this.isKingAttacked(us)) {
      this.unmakeMove();
      return false;
    }
    return true;
  }

  unmakeMove(): void {
    const st = this.undoStack;
    if (st.length === 0) return;
    const hi = st.pop()!;
    const lo = st.pop()!;
    const cap = st.pop()!;
    const m = st.pop()!;
    const from = m & 127;
    const to = m >> 7;
    const b = this.sq;
    const piece = b[to];
    b[from] = piece;
    b[to] = cap;
    this.turn = (1 - this.turn) as Color;
    if (this.turn === 1) this.fullmove--;
    if ((piece & 7) === KING) this.kingSq[this.turn] = from;
    this.hashLo = lo;
    this.hashHi = hi;
  }

  /** Nước "bỏ lượt" cho AI (null-move pruning). */
  makeNullMove(): void {
    this.undoStack.push(-1, 0, this.hashLo, this.hashHi);
    this.hashLo ^= Z_SIDE_LO;
    this.hashHi ^= Z_SIDE_HI;
    this.turn = (1 - this.turn) as Color;
  }

  unmakeNullMove(): void {
    const st = this.undoStack;
    this.hashHi = st.pop()!;
    this.hashLo = st.pop()!;
    st.pop();
    st.pop();
    this.turn = (1 - this.turn) as Color;
  }

  legalMoves(): number[] {
    const pseudo = this.generateMoves(false);
    const out: number[] = [];
    for (const m of pseudo) {
      if (this.makeMove(m)) {
        this.unmakeMove();
        out.push(m);
      }
    }
    return out;
  }
}
