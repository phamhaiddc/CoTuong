import type { Color } from '../types';
import { seededRandom, zobristTable } from '../zobrist';

/**
 * Bàn cờ vua mức thấp (dùng cho luật và AI).
 *
 * Ô: sq = rank * 8 + file, a1 = 0, h8 = 63.
 * Quân: (color << 3) | type. Trắng 1..6, Đen 9..14.
 * Nước đi: from | to << 6 | promo << 12 | flag << 15.
 */

export const PAWN = 1;
export const KNIGHT = 2;
export const BISHOP = 3;
export const ROOK = 4;
export const QUEEN = 5;
export const KING = 6;

export const FLAG_EP = 1;
export const FLAG_CASTLE = 2;
export const FLAG_DOUBLE = 4;

export const CASTLE_WK = 1;
export const CASTLE_WQ = 2;
export const CASTLE_BK = 4;
export const CASTLE_BQ = 8;

export const CHESS_START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

export const cPieceColor = (p: number): Color => (p >> 3) as Color;
export const cPieceType = (p: number): number => p & 7;
export const cMakePiece = (color: Color, type: number): number => (color << 3) | type;

export const encodeChessMove = (from: number, to: number, promo = 0, flag = 0): number =>
  from | (to << 6) | (promo << 12) | (flag << 15);
export const cMoveFrom = (m: number): number => m & 63;
export const cMoveTo = (m: number): number => (m >> 6) & 63;
export const cMovePromo = (m: number): number => (m >> 12) & 7;
export const cMoveFlag = (m: number): number => (m >> 15) & 7;

const onBoard = (f: number, r: number) => f >= 0 && f < 8 && r >= 0 && r < 8;

export const KNIGHT_MOVES: number[][] = [];
export const KING_MOVES: number[][] = [];
/** dir: 0 N, 1 S, 2 E, 3 W, 4 NE, 5 NW, 6 SE, 7 SW */
export const C_RAYS: number[][][] = [];
/** Ô mà tốt bên color đứng ở sq có thể ăn */
export const PAWN_CAPTURES: number[][][] = [[], []];
/** Các ô mà tốt bên color đứng sẽ tấn công sq */
export const C_PAWN_ATTACKERS: number[][][] = [[], []];
export const CASTLE_MASK = new Int8Array(64).fill(15);
CASTLE_MASK[0] = 15 & ~CASTLE_WQ;
CASTLE_MASK[4] = 15 & ~(CASTLE_WK | CASTLE_WQ);
CASTLE_MASK[7] = 15 & ~CASTLE_WK;
CASTLE_MASK[56] = 15 & ~CASTLE_BQ;
CASTLE_MASK[60] = 15 & ~(CASTLE_BK | CASTLE_BQ);
CASTLE_MASK[63] = 15 & ~CASTLE_BK;

const DIRS = [
  [0, 1],
  [0, -1],
  [1, 0],
  [-1, 0],
  [1, 1],
  [-1, 1],
  [1, -1],
  [-1, -1],
];
const KNIGHT_D = [
  [1, 2],
  [2, 1],
  [2, -1],
  [1, -2],
  [-1, -2],
  [-2, -1],
  [-2, 1],
  [-1, 2],
];

for (let s = 0; s < 64; s++) {
  const f = s & 7;
  const r = s >> 3;
  KNIGHT_MOVES[s] = [];
  for (const [df, dr] of KNIGHT_D) if (onBoard(f + df, r + dr)) KNIGHT_MOVES[s].push((r + dr) * 8 + f + df);
  KING_MOVES[s] = [];
  C_RAYS[s] = [];
  for (const [df, dr] of DIRS) {
    if (onBoard(f + df, r + dr)) KING_MOVES[s].push((r + dr) * 8 + f + df);
    const ray: number[] = [];
    let tf = f + df;
    let tr = r + dr;
    while (onBoard(tf, tr)) {
      ray.push(tr * 8 + tf);
      tf += df;
      tr += dr;
    }
    C_RAYS[s].push(ray);
  }
  const wc: number[] = [];
  const bc: number[] = [];
  if (r < 7) {
    if (f > 0) wc.push(s + 7);
    if (f < 7) wc.push(s + 9);
  }
  if (r > 0) {
    if (f > 0) bc.push(s - 9);
    if (f < 7) bc.push(s - 7);
  }
  PAWN_CAPTURES[0][s] = wc;
  PAWN_CAPTURES[1][s] = bc;
  // Tốt trắng ở s-7 (file+1) hoặc s-9 (file-1) tấn công s
  const wa: number[] = [];
  const ba: number[] = [];
  if (r > 0) {
    if (f < 7) wa.push(s - 7);
    if (f > 0) wa.push(s - 9);
  }
  if (r < 7) {
    if (f > 0) ba.push(s + 7);
    if (f < 7) ba.push(s + 9);
  }
  C_PAWN_ATTACKERS[0][s] = wa;
  C_PAWN_ATTACKERS[1][s] = ba;
}

const Z = zobristTable(16, 64, 0x43485353);
const zr = seededRandom(0xc4e55);
const Z_SIDE_LO = zr();
const Z_SIDE_HI = zr();
const ZC_LO = new Int32Array(16);
const ZC_HI = new Int32Array(16);
for (let i = 0; i < 16; i++) {
  ZC_LO[i] = zr();
  ZC_HI[i] = zr();
}
const ZEP_LO = new Int32Array(8);
const ZEP_HI = new Int32Array(8);
for (let i = 0; i < 8; i++) {
  ZEP_LO[i] = zr();
  ZEP_HI[i] = zr();
}

const LETTER_TO_TYPE: Record<string, number> = { p: PAWN, n: KNIGHT, b: BISHOP, r: ROOK, q: QUEEN, k: KING };
export const C_TYPE_LETTER = ['', 'p', 'n', 'b', 'r', 'q', 'k'];

export function chessSquareName(s: number): string {
  return 'abcdefgh'[s & 7] + ((s >> 3) + 1);
}

export function chessParseSquare(name: string): number {
  if (!/^[a-h][1-8]$/.test(name)) return -1;
  return (name.charCodeAt(1) - 49) * 8 + (name.charCodeAt(0) - 97);
}

const STRIDE = 8;

export class ChessBoard {
  readonly sq = new Int8Array(64);
  turn: Color = 0;
  castling = 0;
  /** Ô bắt tốt qua đường, -1 nếu không có */
  ep = -1;
  /** ep có được tính vào hash không (chỉ khi có tốt đối phương có thể bắt) */
  epHashed = false;
  halfmove = 0;
  fullmove = 1;
  readonly kingSq = new Int16Array([-1, -1]);
  hashLo = 0;
  hashHi = 0;
  private readonly undoStack: number[] = [];

  constructor(fen: string = CHESS_START_FEN) {
    this.setFen(fen);
  }

  setFen(fen: string): void {
    const parts = fen.trim().split(/\s+/);
    const rows = (parts[0] ?? '').split('/');
    if (rows.length !== 8) throw new Error('FEN cờ vua không hợp lệ: cần 8 hàng');
    this.sq.fill(0);
    this.kingSq[0] = -1;
    this.kingSq[1] = -1;
    for (let i = 0; i < 8; i++) {
      const rank = 7 - i;
      let file = 0;
      for (const ch of rows[i]) {
        if (ch >= '1' && ch <= '8') {
          file += ch.charCodeAt(0) - 48;
          continue;
        }
        const type = LETTER_TO_TYPE[ch.toLowerCase()];
        if (!type || file > 7) throw new Error(`FEN cờ vua không hợp lệ: "${ch}"`);
        const color: Color = ch === ch.toUpperCase() ? 0 : 1;
        const s = rank * 8 + file;
        // Tốt không thể đứng ở hàng 1 / hàng 8 (tới hàng cuối là phong cấp)
        if (type === PAWN && (rank === 0 || rank === 7)) throw new Error('FEN cờ vua không hợp lệ: tốt ở hàng 1 hoặc hàng 8');
        this.sq[s] = cMakePiece(color, type);
        if (type === KING) {
          if (this.kingSq[color] >= 0) throw new Error('FEN cờ vua không hợp lệ: nhiều hơn 1 vua');
          this.kingSq[color] = s;
        }
        file++;
      }
      if (file !== 8) throw new Error('FEN cờ vua không hợp lệ: hàng không đủ 8 cột');
    }
    if (this.kingSq[0] < 0 || this.kingSq[1] < 0) throw new Error('FEN cờ vua không hợp lệ: thiếu vua');
    this.turn = parts[1] === 'b' ? 1 : 0;
    const c = parts[2] ?? '-';
    this.castling =
      (c.includes('K') ? CASTLE_WK : 0) |
      (c.includes('Q') ? CASTLE_WQ : 0) |
      (c.includes('k') ? CASTLE_BK : 0) |
      (c.includes('q') ? CASTLE_BQ : 0);
    // Bỏ quyền nhập thành không khớp với vị trí quân
    if (this.sq[4] !== cMakePiece(0, KING)) this.castling &= ~(CASTLE_WK | CASTLE_WQ);
    if (this.sq[7] !== cMakePiece(0, ROOK)) this.castling &= ~CASTLE_WK;
    if (this.sq[0] !== cMakePiece(0, ROOK)) this.castling &= ~CASTLE_WQ;
    if (this.sq[60] !== cMakePiece(1, KING)) this.castling &= ~(CASTLE_BK | CASTLE_BQ);
    if (this.sq[63] !== cMakePiece(1, ROOK)) this.castling &= ~CASTLE_BK;
    if (this.sq[56] !== cMakePiece(1, ROOK)) this.castling &= ~CASTLE_BQ;
    // Bên vừa đi không thể còn bị chiếu (nếu không, bên được đi sẽ "ăn vua")
    if (this.isKingAttacked((1 - this.turn) as Color)) throw new Error('FEN cờ vua không hợp lệ: bên vừa đi đang bị chiếu');
    const ep = parts[3] && parts[3] !== '-' ? chessParseSquare(parts[3]) : -1;
    if (ep >= 0) {
      // Ô bắt tốt qua đường phải khớp với nước tốt đi 2 ô vừa xong: đúng hàng 6 (Trắng được đi) / hàng 3 (Đen được đi),
      // tốt đối phương đứng ngay trước ô đó, ô đó và ô tốt xuất phát đều trống
      const white = this.turn === 0;
      const pawnSq = white ? ep - 8 : ep + 8;
      const fromSq = white ? ep + 8 : ep - 8;
      if (
        ep >> 3 !== (white ? 5 : 2) ||
        this.sq[ep] !== 0 ||
        this.sq[fromSq] !== 0 ||
        this.sq[pawnSq] !== cMakePiece(white ? 1 : 0, PAWN)
      ) {
        throw new Error('FEN cờ vua không hợp lệ: ô bắt tốt qua đường sai');
      }
    }
    this.ep = ep;
    this.epHashed = ep >= 0 && this.epCapturable(ep, this.turn);
    const hm = parseInt(parts[4] ?? '0', 10);
    const fm = parseInt(parts[5] ?? '1', 10);
    this.halfmove = Number.isFinite(hm) && hm >= 0 ? hm : 0;
    this.fullmove = Number.isFinite(fm) && fm > 0 ? fm : 1;
    this.undoStack.length = 0;
    this.recomputeHash();
  }

  private epCapturable(ep: number, by: Color): boolean {
    const pawn = cMakePiece(by, PAWN);
    const att = C_PAWN_ATTACKERS[by][ep];
    for (let i = 0; i < att.length; i++) if (this.sq[att[i]] === pawn) return true;
    return false;
  }

  private recomputeHash(): void {
    let lo = 0;
    let hi = 0;
    for (let s = 0; s < 64; s++) {
      const p = this.sq[s];
      if (p) {
        lo ^= Z.lo[p * 64 + s];
        hi ^= Z.hi[p * 64 + s];
      }
    }
    lo ^= ZC_LO[this.castling];
    hi ^= ZC_HI[this.castling];
    if (this.epHashed) {
      lo ^= ZEP_LO[this.ep & 7];
      hi ^= ZEP_HI[this.ep & 7];
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
    for (let rank = 7; rank >= 0; rank--) {
      let empty = 0;
      for (let file = 0; file < 8; file++) {
        const p = this.sq[rank * 8 + file];
        if (!p) {
          empty++;
          continue;
        }
        if (empty) {
          out += empty;
          empty = 0;
        }
        const l = C_TYPE_LETTER[cPieceType(p)];
        out += cPieceColor(p) === 0 ? l.toUpperCase() : l;
      }
      if (empty) out += empty;
      if (rank > 0) out += '/';
    }
    return out;
  }

  castlingString(): string {
    let c = '';
    if (this.castling & CASTLE_WK) c += 'K';
    if (this.castling & CASTLE_WQ) c += 'Q';
    if (this.castling & CASTLE_BK) c += 'k';
    if (this.castling & CASTLE_BQ) c += 'q';
    return c || '-';
  }

  fen(): string {
    return `${this.placement()} ${this.turn === 0 ? 'w' : 'b'} ${this.castlingString()} ${
      this.ep >= 0 ? chessSquareName(this.ep) : '-'
    } ${this.halfmove} ${this.fullmove}`;
  }

  isAttacked(s: number, by: Color): boolean {
    const b = this.sq;
    const pawn = cMakePiece(by, PAWN);
    const pa = C_PAWN_ATTACKERS[by][s];
    for (let i = 0; i < pa.length; i++) if (b[pa[i]] === pawn) return true;
    const knight = cMakePiece(by, KNIGHT);
    const kn = KNIGHT_MOVES[s];
    for (let i = 0; i < kn.length; i++) if (b[kn[i]] === knight) return true;
    const king = cMakePiece(by, KING);
    const kg = KING_MOVES[s];
    for (let i = 0; i < kg.length; i++) if (b[kg[i]] === king) return true;
    const rook = cMakePiece(by, ROOK);
    const bishop = cMakePiece(by, BISHOP);
    const queen = cMakePiece(by, QUEEN);
    const rays = C_RAYS[s];
    for (let d = 0; d < 8; d++) {
      const ray = rays[d];
      const slider = d < 4 ? rook : bishop;
      for (let i = 0; i < ray.length; i++) {
        const p = b[ray[i]];
        if (p) {
          if (p === slider || p === queen) return true;
          break;
        }
      }
    }
    return false;
  }

  isKingAttacked(color: Color): boolean {
    const k = this.kingSq[color];
    return k >= 0 && this.isAttacked(k, (1 - color) as Color);
  }

  inCheck(): boolean {
    return this.isKingAttacked(this.turn);
  }

  generateMoves(capturesOnly = false): number[] {
    const out: number[] = [];
    const us = this.turn;
    const them = (1 - us) as Color;
    const b = this.sq;
    for (let s = 0; s < 64; s++) {
      const p = b[s];
      if (p === 0 || p >> 3 !== us) continue;
      const type = p & 7;
      if (type === PAWN) {
        const fwd = us === 0 ? 8 : -8;
        const r = s >> 3;
        const startR = us === 0 ? 1 : 6;
        const lastR = us === 0 ? 6 : 1;
        const one = s + fwd;
        if (b[one] === 0) {
          if (r === lastR) {
            out.push(encodeChessMove(s, one, QUEEN));
            if (!capturesOnly) {
              out.push(encodeChessMove(s, one, ROOK), encodeChessMove(s, one, BISHOP), encodeChessMove(s, one, KNIGHT));
            }
          } else if (!capturesOnly) {
            out.push(encodeChessMove(s, one));
            if (r === startR && b[one + fwd] === 0) out.push(encodeChessMove(s, one + fwd, 0, FLAG_DOUBLE));
          }
        }
        const caps = PAWN_CAPTURES[us][s];
        for (let i = 0; i < caps.length; i++) {
          const t = caps[i];
          const q = b[t];
          if (q !== 0 && q >> 3 === them) {
            if (r === lastR) {
              out.push(encodeChessMove(s, t, QUEEN));
              if (!capturesOnly) {
                out.push(encodeChessMove(s, t, ROOK), encodeChessMove(s, t, BISHOP), encodeChessMove(s, t, KNIGHT));
              }
            } else out.push(encodeChessMove(s, t));
          } else if (t === this.ep && q === 0) {
            out.push(encodeChessMove(s, t, 0, FLAG_EP));
          }
        }
        continue;
      }
      if (type === KNIGHT || type === KING) {
        const t = type === KNIGHT ? KNIGHT_MOVES[s] : KING_MOVES[s];
        for (let i = 0; i < t.length; i++) {
          const q = b[t[i]];
          if (q === 0) {
            if (!capturesOnly) out.push(s | (t[i] << 6));
          } else if (q >> 3 === them) out.push(s | (t[i] << 6));
        }
        if (type === KING && !capturesOnly) this.genCastling(s, out);
        continue;
      }
      const d0 = type === BISHOP ? 4 : 0;
      const d1 = type === ROOK ? 4 : 8;
      const rays = C_RAYS[s];
      for (let d = d0; d < d1; d++) {
        const ray = rays[d];
        for (let i = 0; i < ray.length; i++) {
          const t = ray[i];
          const q = b[t];
          if (q === 0) {
            if (!capturesOnly) out.push(s | (t << 6));
          } else {
            if (q >> 3 === them) out.push(s | (t << 6));
            break;
          }
        }
      }
    }
    return out;
  }

  private genCastling(s: number, out: number[]): void {
    const b = this.sq;
    if (this.turn === 0 && s === 4) {
      if (
        this.castling & CASTLE_WK &&
        b[5] === 0 &&
        b[6] === 0 &&
        b[7] === cMakePiece(0, ROOK) &&
        !this.isAttacked(4, 1) &&
        !this.isAttacked(5, 1) &&
        !this.isAttacked(6, 1)
      ) {
        out.push(encodeChessMove(4, 6, 0, FLAG_CASTLE));
      }
      if (
        this.castling & CASTLE_WQ &&
        b[3] === 0 &&
        b[2] === 0 &&
        b[1] === 0 &&
        b[0] === cMakePiece(0, ROOK) &&
        !this.isAttacked(4, 1) &&
        !this.isAttacked(3, 1) &&
        !this.isAttacked(2, 1)
      ) {
        out.push(encodeChessMove(4, 2, 0, FLAG_CASTLE));
      }
    } else if (this.turn === 1 && s === 60) {
      if (
        this.castling & CASTLE_BK &&
        b[61] === 0 &&
        b[62] === 0 &&
        b[63] === cMakePiece(1, ROOK) &&
        !this.isAttacked(60, 0) &&
        !this.isAttacked(61, 0) &&
        !this.isAttacked(62, 0)
      ) {
        out.push(encodeChessMove(60, 62, 0, FLAG_CASTLE));
      }
      if (
        this.castling & CASTLE_BQ &&
        b[59] === 0 &&
        b[58] === 0 &&
        b[57] === 0 &&
        b[56] === cMakePiece(1, ROOK) &&
        !this.isAttacked(60, 0) &&
        !this.isAttacked(59, 0) &&
        !this.isAttacked(58, 0)
      ) {
        out.push(encodeChessMove(60, 58, 0, FLAG_CASTLE));
      }
    }
  }

  makeMove(m: number): boolean {
    const from = m & 63;
    const to = (m >> 6) & 63;
    const promo = (m >> 12) & 7;
    const flag = (m >> 15) & 7;
    const us = this.turn;
    const them = (1 - us) as Color;
    const b = this.sq;
    const piece = b[from];
    let capSq = to;
    if (flag === FLAG_EP) capSq = to + (us === 0 ? -8 : 8);
    const cap = b[capSq];
    this.undoStack.push(
      m,
      cap,
      this.castling,
      this.ep,
      this.epHashed ? 1 : 0,
      this.halfmove,
      this.hashLo,
      this.hashHi,
    );
    let lo = this.hashLo ^ Z.lo[piece * 64 + from];
    let hi = this.hashHi ^ Z.hi[piece * 64 + from];
    if (cap) {
      b[capSq] = 0;
      lo ^= Z.lo[cap * 64 + capSq];
      hi ^= Z.hi[cap * 64 + capSq];
    }
    const placed = promo ? cMakePiece(us, promo) : piece;
    b[from] = 0;
    b[to] = placed;
    lo ^= Z.lo[placed * 64 + to];
    hi ^= Z.hi[placed * 64 + to];
    if ((piece & 7) === KING) {
      this.kingSq[us] = to;
      if (flag === FLAG_CASTLE) {
        const rf = to > from ? from + 3 : from - 4;
        const rt = to > from ? from + 1 : from - 1;
        const rook = b[rf];
        b[rf] = 0;
        b[rt] = rook;
        lo ^= Z.lo[rook * 64 + rf] ^ Z.lo[rook * 64 + rt];
        hi ^= Z.hi[rook * 64 + rf] ^ Z.hi[rook * 64 + rt];
      }
    }
    const oldC = this.castling;
    const newC = oldC & CASTLE_MASK[from] & CASTLE_MASK[to];
    if (newC !== oldC) {
      lo ^= ZC_LO[oldC] ^ ZC_LO[newC];
      hi ^= ZC_HI[oldC] ^ ZC_HI[newC];
      this.castling = newC;
    }
    if (this.epHashed) {
      lo ^= ZEP_LO[this.ep & 7];
      hi ^= ZEP_HI[this.ep & 7];
    }
    this.ep = -1;
    this.epHashed = false;
    if (flag === FLAG_DOUBLE) {
      this.ep = (from + to) >> 1;
      if (this.epCapturable(this.ep, them)) {
        this.epHashed = true;
        lo ^= ZEP_LO[this.ep & 7];
        hi ^= ZEP_HI[this.ep & 7];
      }
    }
    this.halfmove = (piece & 7) === PAWN || cap ? 0 : this.halfmove + 1;
    if (us === 1) this.fullmove++;
    this.turn = them;
    this.hashLo = lo ^ Z_SIDE_LO;
    this.hashHi = hi ^ Z_SIDE_HI;
    if (this.isAttacked(this.kingSq[us], them)) {
      this.unmakeMove();
      return false;
    }
    return true;
  }

  unmakeMove(): void {
    const st = this.undoStack;
    if (st.length === 0) return;
    const base = st.length - STRIDE;
    const m = st[base];
    const cap = st[base + 1];
    this.castling = st[base + 2];
    this.ep = st[base + 3];
    this.epHashed = st[base + 4] === 1;
    this.halfmove = st[base + 5];
    this.hashLo = st[base + 6];
    this.hashHi = st[base + 7];
    st.length = base;
    if (m === -1) {
      // null move
      this.turn = (1 - this.turn) as Color;
      return;
    }
    const from = m & 63;
    const to = (m >> 6) & 63;
    const promo = (m >> 12) & 7;
    const flag = (m >> 15) & 7;
    this.turn = (1 - this.turn) as Color;
    const us = this.turn;
    const b = this.sq;
    const placed = b[to];
    const piece = promo ? cMakePiece(us, PAWN) : placed;
    b[from] = piece;
    b[to] = 0;
    if (flag === FLAG_EP) b[to + (us === 0 ? -8 : 8)] = cap;
    else b[to] = cap;
    if ((piece & 7) === KING) {
      this.kingSq[us] = from;
      if (flag === FLAG_CASTLE) {
        const rf = to > from ? from + 3 : from - 4;
        const rt = to > from ? from + 1 : from - 1;
        b[rf] = b[rt];
        b[rt] = 0;
      }
    }
    if (us === 1) this.fullmove--;
  }

  /** Nước "bỏ lượt" cho AI (null-move pruning) */
  makeNullMove(): void {
    this.undoStack.push(-1, 0, this.castling, this.ep, this.epHashed ? 1 : 0, this.halfmove, this.hashLo, this.hashHi);
    let lo = this.hashLo ^ Z_SIDE_LO;
    let hi = this.hashHi ^ Z_SIDE_HI;
    if (this.epHashed) {
      lo ^= ZEP_LO[this.ep & 7];
      hi ^= ZEP_HI[this.ep & 7];
    }
    this.ep = -1;
    this.epHashed = false;
    this.hashLo = lo;
    this.hashHi = hi;
    this.turn = (1 - this.turn) as Color;
  }

  unmakeNullMove(): void {
    this.unmakeMove();
  }

  legalMoves(): number[] {
    const out: number[] = [];
    for (const m of this.generateMoves(false)) {
      if (this.makeMove(m)) {
        this.unmakeMove();
        out.push(m);
      }
    }
    return out;
  }

  hasLegalMove(): boolean {
    for (const m of this.generateMoves(false)) {
      if (this.makeMove(m)) {
        this.unmakeMove();
        return true;
      }
    }
    return false;
  }

  /** Không đủ quân chiếu hết: K-K, K+B-K, K+N-K, các tượng cùng màu ô */
  insufficientMaterial(): boolean {
    let minors = 0;
    let knights = 0;
    let bishopColorMask = 0;
    for (let s = 0; s < 64; s++) {
      const p = this.sq[s];
      if (!p) continue;
      const t = p & 7;
      if (t === PAWN || t === ROOK || t === QUEEN) return false;
      if (t === KNIGHT) {
        knights++;
        minors++;
      } else if (t === BISHOP) {
        minors++;
        bishopColorMask |= 1 << (((s >> 3) + (s & 7)) & 1);
      }
    }
    if (minors <= 1) return true;
    return knights === 0 && bishopColorMask !== 3;
  }
}
