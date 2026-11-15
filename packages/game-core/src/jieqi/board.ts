import type { Color } from '../types';
import { seededRandom, zobristTable } from '../zobrist';
import {
  ADVISOR,
  ADVISOR_MOVES,
  CANNON,
  ELEPHANT,
  ELEPHANT_MOVES,
  HORSE,
  HORSE_ATTACKERS,
  HORSE_MOVES,
  KING,
  KING_MOVES,
  PAWN,
  PAWN_ATTACKERS,
  PAWN_MOVES,
  RAYS,
  ROOK,
  X_SQUARES,
  fileOf,
  rankOf,
  sqOf,
} from '../xiangqi/board';

/**
 * Bàn Cờ úp (Jieqi) mức thấp — dùng cho luật (JieqiGame) và cho AI (tìm kiếm nhanh).
 *
 * Toạ độ giống cờ tướng của game-core: sq = rank * 9 + file, "a0" = góc dưới trái phía Đỏ.
 * Nước đi: from | (to << 7) (giống XiangqiBoard).
 *
 * Mã quân: (úp << 4) | (màu << 3) | loại.
 *  - Quân đã lật: loại thật (KING..PAWN), giống XiangqiBoard.
 *  - Quân úp (bit HIDDEN = 16): `loại` là loại quân GỐC của ô xuất phát nó đang đứng — quân úp chỉ
 *    đứng ở ô xuất phát của bên mình (đi một nước là lật), nên loại này là thông tin công khai.
 *    Màu luôn lấy bằng (p >> 3) & 1.
 *
 * Danh tính thật của quân úp nằm riêng trong `secret[ô]` (0 = chưa biết). Có hai chế độ hiểu biết,
 * cùng một đường mã:
 *  - Biết đủ (server, ván với máy trong trình duyệt, các "mẫu" của AI): `secret` có đủ cho mọi quân úp,
 *    `doMove` tự lật quân.
 *  - Công khai (người chơi online): `secret` trống; trước khi đi nước dính tới quân úp, lớp trên
 *    (JieqiGame.play) ghi danh tính do server gửi vào `secret` rồi mới gọi `doMove`.
 * Sinh nước hợp lệ và xét chiếu chỉ dùng thông tin công khai (quân úp đi / khống chế theo loại gốc
 * của ô), nên hai chế độ luôn cho cùng danh sách nước hợp lệ.
 */

/** Bit đánh dấu quân úp trong mã quân */
export const HIDDEN = 16;

/** Ký hiệu loại quân (giống XQ_TYPE_LETTER của cờ tướng): k a e h r c p */
export const JQ_TYPE_LETTER = ['', 'k', 'a', 'e', 'h', 'r', 'c', 'p'];
/** Các loại quân có thể úp (mọi quân trừ Tướng), theo thứ tự hiển thị */
export const JQ_HIDDEN_TYPES = [ROOK, HORSE, ELEPHANT, ADVISOR, CANNON, PAWN] as const;
/** Số quân mỗi loại của một bên lúc đầu (index = loại) */
export const JQ_INITIAL_COUNT = [0, 1, 2, 2, 2, 2, 2, 5];

/** Chữ cái → loại (chấp nhận cả b/n như FEN cờ tướng thường) */
export const JQ_LETTER_TYPE: Readonly<Record<string, number>> = {
  k: KING,
  a: ADVISOR,
  e: ELEPHANT,
  b: ELEPHANT,
  h: HORSE,
  n: HORSE,
  r: ROOK,
  c: CANNON,
  p: PAWN,
};

// ---------------------------------------------------------------------------
// Ô xuất phát
// ---------------------------------------------------------------------------

/** START_TYPE[màu][ô] = loại quân gốc ở ô xuất phát của bên đó (0 nếu không phải ô của quân úp) */
export const START_TYPE: [Int8Array, Int8Array] = [new Int8Array(X_SQUARES), new Int8Array(X_SQUARES)];

/**
 * Thứ tự 15 ô xuất phát của mỗi bên trong chuỗi xếp quân (setup):
 * hàng cuối, hàng pháo, hàng tốt (tính từ phía bên đó), mỗi hàng cột a → i, bỏ ô Tướng.
 * Đỏ:  a0 b0 c0 d0 f0 g0 h0 i0 b2 h2 a3 c3 e3 g3 i3
 * Đen: a9 b9 c9 d9 f9 g9 h9 i9 b7 h7 a6 c6 e6 g6 i6
 */
export const JIEQI_SETUP_SQUARES: [readonly number[], readonly number[]] = [[], []];

{
  const back = [ROOK, HORSE, ELEPHANT, ADVISOR, 0, ADVISOR, ELEPHANT, HORSE, ROOK];
  for (let color = 0; color < 2; color++) {
    const rel = (r: number) => (color === 0 ? r : 9 - r);
    const list = JIEQI_SETUP_SQUARES[color] as number[];
    const put = (f: number, r: number, t: number) => {
      const s = sqOf(f, rel(r));
      START_TYPE[color][s] = t;
      list.push(s);
    };
    for (let f = 0; f < 9; f++) if (back[f]) put(f, 0, back[f]);
    put(1, 2, CANNON);
    put(7, 2, CANNON);
    for (let f = 0; f < 9; f += 2) put(f, 3, PAWN);
  }
}

/** Thế bắt đầu Cờ úp (công khai): hai Tướng ngửa, 30 quân còn lại úp. Ký hiệu X/x = quân úp. */
export const JIEQI_START_FEN = 'xxxxkxxxx/9/1x5x1/x1x1x1x1x/9/9/X1X1X1X1X/1X5X1/9/XXXXKXXXX w - - 0 1';

// ---------------------------------------------------------------------------
// Bảng nước đi riêng của Cờ úp (Sĩ, Tượng đã lật không bị giới hạn khu vực)
// ---------------------------------------------------------------------------

/** Sĩ đã lật: 4 ô chéo kề, ở bất kỳ đâu trên bàn. Cũng là danh sách ô chéo kề của một ô. */
export const FREE_ADVISOR_MOVES: number[][] = [];
/** Tượng đã lật: cặp [đích, mắt tượng], được qua sông */
export const FREE_ELEPHANT_MOVES: number[][] = [];

for (let s = 0; s < X_SQUARES; s++) {
  const f = fileOf(s);
  const r = rankOf(s);
  FREE_ADVISOR_MOVES[s] = [];
  FREE_ELEPHANT_MOVES[s] = [];
  for (const [df, dr] of [
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ]) {
    if (f + df >= 0 && f + df < 9 && r + dr >= 0 && r + dr < 10) FREE_ADVISOR_MOVES[s].push(sqOf(f + df, r + dr));
    const tf = f + 2 * df;
    const tr = r + 2 * dr;
    if (tf >= 0 && tf < 9 && tr >= 0 && tr < 10) FREE_ELEPHANT_MOVES[s].push(sqOf(tf, tr), sqOf(f + df, r + dr));
  }
}

const PALACE = (s: number) => {
  const f = fileOf(s);
  const r = rankOf(s);
  return f >= 3 && f <= 5 && (r <= 2 || r >= 7);
};
const palaceColor = (s: number): Color => (rankOf(s) <= 2 ? 0 : 1);

// ---------------------------------------------------------------------------
// Zobrist (mã quân 0..31, có bit úp — trạng thái úp là một phần của thế cờ)
// ---------------------------------------------------------------------------

const Z = zobristTable(32, X_SQUARES, 0x4a494551);
const sideRnd = seededRandom(0x6a71);
const Z_SIDE_LO = sideRnd();
const Z_SIDE_HI = sideRnd();

/** Số phần tử mỗi nửa nước trong ngăn xếp huỷ nước */
const UNDO = 6;

/** Thứ tự loại quân trong ngoặc quân bị ăn của FEN (theo quy ước Jieqi FEN trên chessprogramming.org) */
const CAPTURE_ORDER = [ADVISOR, ELEPHANT, ROOK, CANNON, HORSE, PAWN];

export class JieqiBoard {
  readonly sq = new Int8Array(X_SQUARES);
  /**
   * Danh tính thật (loại) của quân úp đang đứng ở ô đó; 0 = không biết.
   * KHÔNG bao giờ đưa ra ngoài trước khi quân được lật (xem JieqiGame).
   */
  readonly secret = new Int8Array(X_SQUARES);
  /** pool[màu * 8 + loại]: số quân loại đó của bên `màu` chưa lộ danh tính (= đang úp trên bàn) */
  readonly pool = new Int8Array(16);
  /** captured[màu * 8 + loại]: số quân loại đó của bên `màu` đã bị ăn (danh tính luôn công khai) */
  readonly captured = new Int8Array(16);
  turn: Color = 0;
  fullmove = 1;
  /** Số nửa nước kể từ lần ăn quân hoặc lật quân gần nhất (thế cờ trước đó không thể lặp lại) */
  rev = 0;
  readonly kingSq = new Int16Array([-1, -1]);
  hashLo = 0;
  hashHi = 0;
  /** Ngăn xếp huỷ nước: [move, quân bị ăn, quân đi (mã trước nước), hashLo, hashHi, rev] */
  private readonly undoStack: number[] = [];

  constructor(fen: string = JIEQI_START_FEN) {
    this.setFen(fen);
  }

  get ply(): number {
    return this.undoStack.length / UNDO;
  }

  /** Bản sao thế cờ hiện tại (kể cả `secret`), không kèm lịch sử huỷ nước */
  copy(): JieqiBoard {
    const b = new JieqiBoard();
    b.sq.set(this.sq);
    b.secret.set(this.secret);
    b.pool.set(this.pool);
    b.captured.set(this.captured);
    b.kingSq.set(this.kingSq);
    b.turn = this.turn;
    b.fullmove = this.fullmove;
    b.rev = this.rev;
    b.hashLo = this.hashLo;
    b.hashHi = this.hashHi;
    return b;
  }

  // ------------------------------------------------------------------ FEN công khai

  /**
   * Đọc FEN Cờ úp công khai (theo quy ước Jieqi FEN mô tả trên chessprogramming.org):
   *  - Quân ngửa: K A E H R C P (Đỏ chữ hoa, Đen chữ thường; chấp nhận cả B/N như FEN cờ tướng).
   *  - Quân úp: X (Đỏ) / x (Đen) — chỉ được đứng ở ô xuất phát của bên mình.
   *  - Quân đã bị ăn (luôn biết danh tính) ghi trong ngoặc vuông liền sau phần xếp quân, mỗi loại kèm số
   *    lượng, ví dụ `[R1p2]`; bỏ ngoặc nếu chưa ăn quân nào.
   *  - Tiếp theo: bên đi (w = Đỏ, b = Đen), "- -", số nửa nước (bỏ qua), số nước.
   * Kho quân chưa lộ của mỗi bên = bộ quân đầy đủ − quân ngửa trên bàn − quân đã bị ăn, và phải có đúng
   * bằng số quân úp của bên đó. FEN không bao giờ chứa danh tính quân úp.
   */
  setFen(fen: string): void {
    const err = (msg: string) => new Error(`FEN cờ úp không hợp lệ: ${msg}`);
    const parts = String(fen).trim().split(/\s+/);
    let placement = parts[0] ?? '';
    let bracket = '';
    const bm = /^([^[\]]*)\[([^\]]*)\]$/.exec(placement);
    if (bm) {
      placement = bm[1];
      bracket = bm[2];
    } else if (/[[\]]/.test(placement)) {
      throw err('ngoặc quân bị ăn sai');
    }
    const rows = placement.split('/');
    if (rows.length !== 10) throw err('cần 10 hàng');
    this.sq.fill(0);
    this.secret.fill(0);
    this.pool.fill(0);
    this.captured.fill(0);
    this.kingSq[0] = -1;
    this.kingSq[1] = -1;
    const onBoard = new Int8Array(16);
    const hiddenCount = [0, 0];
    for (let i = 0; i < 10; i++) {
      const rank = 9 - i;
      let file = 0;
      for (const ch of rows[i]) {
        if (ch >= '1' && ch <= '9') {
          file += ch.charCodeAt(0) - 48;
          continue;
        }
        if (file > 8) throw err('hàng quá 9 cột');
        const s = sqOf(file, rank);
        const color: Color = ch === ch.toUpperCase() ? 0 : 1;
        if (ch === 'X' || ch === 'x') {
          const t = START_TYPE[color][s];
          if (!t) throw err(`quân úp ở ô không phải ô xuất phát (${'abcdefghi'[file]}${rank})`);
          this.sq[s] = HIDDEN | (color << 3) | t;
          hiddenCount[color]++;
        } else {
          const t = JQ_LETTER_TYPE[ch.toLowerCase()];
          if (!t) throw err(`ký tự "${ch}"`);
          this.sq[s] = (color << 3) | t;
          if (t === KING) {
            if (this.kingSq[color] >= 0) throw err('nhiều hơn 1 tướng');
            if (!PALACE(s) || palaceColor(s) !== color) throw err('tướng nằm ngoài cung');
            this.kingSq[color] = s;
          } else {
            onBoard[color * 8 + t]++;
          }
        }
        file++;
      }
      if (file !== 9) throw err('hàng không đủ 9 cột');
    }
    if (this.kingSq[0] < 0 || this.kingSq[1] < 0) throw err('thiếu tướng');
    if (bracket) {
      const re = /([A-Za-z])(\d+)/y;
      let pos = 0;
      while (pos < bracket.length) {
        re.lastIndex = pos;
        const m = re.exec(bracket);
        if (!m) throw err('ngoặc quân bị ăn sai');
        const t = JQ_LETTER_TYPE[m[1].toLowerCase()];
        const n = parseInt(m[2], 10);
        if (!t || t === KING || !(n > 0)) throw err(`quân bị ăn "${m[0]}"`);
        const color: Color = m[1] === m[1].toUpperCase() ? 0 : 1;
        // Kiểm tra trước khi cộng: số lớn (vd 254) tràn Int8 thành số âm và làm phình kho quân úp
        if (this.captured[color * 8 + t] + n > JQ_INITIAL_COUNT[t]) throw err(`quân bị ăn "${m[0]}" nhiều hơn số quân có`);
        this.captured[color * 8 + t] += n;
        pos = re.lastIndex;
      }
    }
    for (let color = 0; color < 2; color++) {
      let poolSize = 0;
      for (let t = ADVISOR; t <= PAWN; t++) {
        const left = JQ_INITIAL_COUNT[t] - onBoard[color * 8 + t] - this.captured[color * 8 + t];
        if (left < 0) throw err(`bên ${color === 0 ? 'Đỏ' : 'Đen'} thừa quân loại "${JQ_TYPE_LETTER[t]}"`);
        this.pool[color * 8 + t] = left;
        poolSize += left;
      }
      if (poolSize !== hiddenCount[color]) {
        throw err(`bên ${color === 0 ? 'Đỏ' : 'Đen'} có ${hiddenCount[color]} quân úp nhưng còn ${poolSize} quân chưa rõ`);
      }
    }
    const side = parts[1] ?? 'w';
    if (side !== 'w' && side !== 'b' && side !== 'r') throw err(`bên đi "${side}"`);
    this.turn = side === 'b' ? 1 : 0;
    // Bên vừa đi không thể còn bị chiếu / lộ mặt tướng (nếu không, bên được đi sẽ "ăn tướng")
    if (this.isKingAttacked((1 - this.turn) as Color)) throw err('bên vừa đi đang bị chiếu');
    const fm = parseInt(parts[5] ?? '1', 10);
    this.fullmove = Number.isFinite(fm) && fm > 0 ? fm : 1;
    this.rev = 0;
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

  /** Phần xếp quân của FEN (không có ngoặc quân bị ăn); quân úp là X/x */
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
        const letter = p & HIDDEN ? 'x' : JQ_TYPE_LETTER[p & 7];
        out += (p >> 3) & 1 ? letter : letter.toUpperCase();
      }
      if (empty) out += empty;
      if (rank > 0) out += '/';
    }
    return out;
  }

  /** Ngoặc quân bị ăn, ví dụ "[R1p2]" (chuỗi rỗng nếu chưa ăn quân nào) */
  capturedBracket(): string {
    let out = '';
    for (let color = 0; color < 2; color++) {
      for (const t of CAPTURE_ORDER) {
        const n = this.captured[color * 8 + t];
        if (n > 0) out += (color === 0 ? JQ_TYPE_LETTER[t].toUpperCase() : JQ_TYPE_LETTER[t]) + n;
      }
    }
    return out ? `[${out}]` : '';
  }

  /** FEN Cờ úp công khai (không chứa danh tính quân úp) */
  fen(): string {
    return `${this.placement()}${this.capturedBracket()} ${this.turn === 0 ? 'w' : 'b'} - - 0 ${this.fullmove}`;
  }

  /**
   * Khoá thế cờ để xét lặp nước: vị trí quân (gồm trạng thái úp) + bên đi.
   * Trong một ván, quân bị ăn chỉ tăng nên không cần đưa vào khoá.
   */
  positionKey(): string {
    return `${this.placement()} ${this.turn === 0 ? 'w' : 'b'}`;
  }

  /** Số quân úp của một bên trên bàn */
  hiddenCount(color: Color): number {
    let n = 0;
    for (let t = ADVISOR; t <= PAWN; t++) n += this.pool[color * 8 + t];
    return n;
  }

  /** Các ô đang có quân úp của một bên */
  hiddenSquares(color: Color): number[] {
    const out: number[] = [];
    for (const s of JIEQI_SETUP_SQUARES[color]) {
      const p = this.sq[s];
      if (p & HIDDEN && ((p >> 3) & 1) === color) out.push(s);
    }
    return out;
  }

  // ------------------------------------------------------------------ khống chế, chiếu

  /**
   * Bên `by` có khống chế ô `target` không (theo luật đi; quân úp khống chế theo loại gốc của ô nó
   * đứng, với giới hạn cung / sông của loại đó; Sĩ, Tượng đã lật không bị giới hạn khu vực).
   * Nếu `target` là ô tướng đối phương thì tính cả luật lộ mặt tướng.
   */
  isAttacked(target: number, by: Color): boolean {
    const b = this.sq;
    const rays = RAYS[target];
    const enemyKingTarget = target === this.kingSq[1 - by];
    for (let dir = 0; dir < 4; dir++) {
      const ray = rays[dir];
      const n = ray.length;
      let i = 0;
      while (i < n && b[ray[i]] === 0) i++;
      if (i === n) continue;
      let p = b[ray[i]];
      if (((p >> 3) & 1) === by) {
        const t = p & 7;
        if (t === ROOK) return true;
        // Lộ mặt tướng: hai tướng cùng cột, không có quân ở giữa
        if (t === KING && dir < 2 && enemyKingTarget) return true;
      }
      i++;
      while (i < n && b[ray[i]] === 0) i++;
      if (i < n) {
        p = b[ray[i]];
        if (((p >> 3) & 1) === by && (p & 7) === CANNON) return true;
      }
    }
    const horse = (by << 3) | HORSE;
    const ha = HORSE_ATTACKERS[target];
    for (let i = 0; i < ha.length; i += 2) {
      const p = b[ha[i]];
      if (p !== 0 && (p & 15) === horse && b[ha[i + 1]] === 0) return true;
    }
    const pawn = (by << 3) | PAWN;
    const pa = PAWN_ATTACKERS[by][target];
    for (let i = 0; i < pa.length; i++) {
      const p = b[pa[i]];
      if (p !== 0 && (p & 15) === pawn) return true;
    }
    // Sĩ / Tượng: quân úp ở ô Sĩ / Tượng không bao giờ với tới cung đối phương, nên khi xét chiếu tướng mà bên
    // `by` chưa có Sĩ (Tượng) nào đã lật thì bỏ qua (số đã lật = 2 − chưa lộ − đã bị ăn).
    const base = by * 8;
    if (!enemyKingTarget || this.pool[base + ADVISOR] + this.captured[base + ADVISOR] < 2) {
      const advisor = (by << 3) | ADVISOR;
      const da = FREE_ADVISOR_MOVES[target];
      for (let i = 0; i < da.length; i++) {
        const s = da[i];
        const p = b[s];
        if (p !== 0 && (p & 15) === advisor && (!(p & HIDDEN) || ADVISOR_MOVES[s].includes(target))) return true;
      }
    }
    if (!enemyKingTarget || this.pool[base + ELEPHANT] + this.captured[base + ELEPHANT] < 2) {
      const elephant = (by << 3) | ELEPHANT;
      const ea = FREE_ELEPHANT_MOVES[target];
      for (let i = 0; i < ea.length; i += 2) {
        const s = ea[i];
        const p = b[s];
        if (p !== 0 && (p & 15) === elephant && b[ea[i + 1]] === 0) {
          // Quân úp ở ô Tượng đi như Tượng thường: không qua sông
          if (!(p & HIDDEN) || rankOf(s) <= 4 === rankOf(target) <= 4) return true;
        }
      }
    }
    if (!enemyKingTarget) {
      const k = this.kingSq[by];
      if (k >= 0 && KING_MOVES[k].includes(target)) return true;
    }
    return false;
  }

  /**
   * Tướng bên `color` có đang bị chiếu không (kể cả lộ mặt tướng). Kết quả giống
   * `isAttacked(kingSq[color], đối phương)` nhưng nhanh hơn (đường nóng của sinh nước / AI): quân úp luôn đứng ở ô
   * xuất phát của bên mình, và không ô xuất phát nào (với loại gốc của ô) khống chế được cung đối phương, nên chỉ
   * cần so mã quân đã lật — như XiangqiBoard, cộng thêm Sĩ / Tượng đã lật.
   */
  isKingAttacked(color: Color): boolean {
    const k = this.kingSq[color];
    if (k < 0) return false;
    const by = 1 - color;
    const b = this.sq;
    const rook = (by << 3) | ROOK;
    const cannon = (by << 3) | CANNON;
    const king = (by << 3) | KING;
    const rays = RAYS[k];
    for (let dir = 0; dir < 4; dir++) {
      const ray = rays[dir];
      const n = ray.length;
      let i = 0;
      while (i < n && b[ray[i]] === 0) i++;
      if (i === n) continue;
      const p = b[ray[i]];
      // Lộ mặt tướng: hai tướng cùng cột, không có quân ở giữa
      if (p === rook || (p === king && dir < 2)) return true;
      i++;
      while (i < n && b[ray[i]] === 0) i++;
      if (i < n && b[ray[i]] === cannon) return true;
    }
    const horse = (by << 3) | HORSE;
    const ha = HORSE_ATTACKERS[k];
    for (let i = 0; i < ha.length; i += 2) if (b[ha[i]] === horse && b[ha[i + 1]] === 0) return true;
    const pawn = (by << 3) | PAWN;
    const pa = PAWN_ATTACKERS[by][k];
    for (let i = 0; i < pa.length; i++) if (b[pa[i]] === pawn) return true;
    const base = by * 8;
    if (this.pool[base + ADVISOR] + this.captured[base + ADVISOR] < 2) {
      const advisor = (by << 3) | ADVISOR;
      const da = FREE_ADVISOR_MOVES[k];
      for (let i = 0; i < da.length; i++) if (b[da[i]] === advisor) return true;
    }
    if (this.pool[base + ELEPHANT] + this.captured[base + ELEPHANT] < 2) {
      const elephant = (by << 3) | ELEPHANT;
      const ea = FREE_ELEPHANT_MOVES[k];
      for (let i = 0; i < ea.length; i += 2) if (b[ea[i]] === elephant && b[ea[i + 1]] === 0) return true;
    }
    return false;
  }

  inCheck(): boolean {
    return this.isKingAttacked(this.turn);
  }

  // ------------------------------------------------------------------ sinh nước

  /** Sinh nước giả hợp lệ (chưa kiểm tra tự để tướng bị chiếu). Chỉ dùng thông tin công khai. */
  generateMoves(capturesOnly = false): number[] {
    const out: number[] = [];
    const us = this.turn;
    const b = this.sq;
    const add = (from: number, to: number) => {
      const q = b[to];
      if (q === 0) {
        if (!capturesOnly) out.push(from | (to << 7));
      } else if (((q >> 3) & 1) !== us) {
        out.push(from | (to << 7));
      }
    };
    for (let s = 0; s < X_SQUARES; s++) {
      const p = b[s];
      if (p === 0 || ((p >> 3) & 1) !== us) continue;
      switch (p & 7) {
        case KING: {
          const t = KING_MOVES[s];
          for (let i = 0; i < t.length; i++) add(s, t[i]);
          break;
        }
        case ADVISOR: {
          // Quân úp ở ô Sĩ đi nước đầu như Sĩ thường (trong cung); Sĩ đã lật đi chéo 1 ô ở bất kỳ đâu
          const t = p & HIDDEN ? ADVISOR_MOVES[s] : FREE_ADVISOR_MOVES[s];
          for (let i = 0; i < t.length; i++) add(s, t[i]);
          break;
        }
        case ELEPHANT: {
          // Quân úp ở ô Tượng đi như Tượng thường; Tượng đã lật được qua sông. Cản mắt luôn áp dụng.
          const t = p & HIDDEN ? ELEPHANT_MOVES[s] : FREE_ELEPHANT_MOVES[s];
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
                if (((q >> 3) & 1) !== us) out.push(s | (t << 7));
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
            if (i < n && ((b[ray[i]] >> 3) & 1) !== us) out.push(s | (ray[i] << 7));
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
   * Nước giả hợp lệ `m` có giữ an toàn cho tướng bên đi không. Không cần biết danh tính quân úp:
   * quân vừa đi chỉ đóng vai vật cản, quân bị ăn bị nhấc khỏi bàn.
   */
  isSafe(m: number): boolean {
    const from = m & 127;
    const to = m >> 7;
    const b = this.sq;
    const piece = b[from];
    const cap = b[to];
    const us = ((piece >> 3) & 1) as Color;
    const king = (piece & 7) === KING; // Tướng không bao giờ úp
    b[to] = piece;
    b[from] = 0;
    if (king) this.kingSq[us] = to;
    const bad = this.isKingAttacked(us);
    if (king) this.kingSq[us] = from;
    b[from] = piece;
    b[to] = cap;
    return !bad;
  }

  /** Nước `m` (giả hợp lệ) có cần biết danh tính quân úp không: quân đi đang úp hoặc quân bị ăn đang úp */
  touchesHidden(m: number): boolean {
    return ((this.sq[m & 127] | this.sq[m >> 7]) & HIDDEN) !== 0;
  }

  // ------------------------------------------------------------------ đi / huỷ nước

  /**
   * Đi nước m nếu hợp lệ về an toàn tướng (m phải là nước giả hợp lệ). Trả về false nếu nước để tướng
   * mình bị chiếu (bàn không đổi). Cần `secret` cho mọi quân úp mà nước này đụng tới.
   */
  makeMove(m: number): boolean {
    if (!this.isSafe(m)) return false;
    this.doMove(m);
    return true;
  }

  /**
   * Đi nước m không kiểm tra hợp lệ. Quân úp đi thì lật thành loại thật `secret[from]`;
   * quân úp bị ăn thì lộ danh tính `secret[to]` (cập nhật kho quân chưa lộ và quân bị ăn).
   */
  doMove(m: number): void {
    const from = m & 127;
    const to = m >> 7;
    const b = this.sq;
    const piece = b[from];
    const cap = b[to];
    const us = this.turn;
    const them = 1 - us;
    let moved = piece;
    if (piece & HIDDEN) {
      const real = this.secret[from];
      if (!real) throw new Error(`Cờ úp: chưa biết danh tính quân úp ở ô ${'abcdefghi'[fileOf(from)]}${rankOf(from)}`);
      moved = (us << 3) | real;
      this.pool[us * 8 + real]--;
    }
    if (cap) {
      let capType = cap & 7;
      if (cap & HIDDEN) {
        capType = this.secret[to];
        if (!capType) throw new Error(`Cờ úp: chưa biết danh tính quân úp bị ăn ở ô ${'abcdefghi'[fileOf(to)]}${rankOf(to)}`);
        this.pool[them * 8 + capType]--;
      }
      this.captured[them * 8 + capType]++;
    }
    const st = this.undoStack;
    st.push(m, cap, piece, this.hashLo, this.hashHi, this.rev);
    b[to] = moved;
    b[from] = 0;
    if ((piece & 7) === KING) this.kingSq[us] = to;
    let lo = this.hashLo ^ Z.lo[piece * X_SQUARES + from] ^ Z.lo[moved * X_SQUARES + to] ^ Z_SIDE_LO;
    let hi = this.hashHi ^ Z.hi[piece * X_SQUARES + from] ^ Z.hi[moved * X_SQUARES + to] ^ Z_SIDE_HI;
    if (cap) {
      lo ^= Z.lo[cap * X_SQUARES + to];
      hi ^= Z.hi[cap * X_SQUARES + to];
    }
    this.hashLo = lo;
    this.hashHi = hi;
    this.rev = cap || piece & HIDDEN ? 0 : this.rev + 1;
    this.turn = them as Color;
    if (us === 1) this.fullmove++;
  }

  unmakeMove(): void {
    const st = this.undoStack;
    if (st.length === 0) return;
    const rev = st.pop()!;
    const hi = st.pop()!;
    const lo = st.pop()!;
    const piece = st.pop()!;
    const cap = st.pop()!;
    const m = st.pop()!;
    const from = m & 127;
    const to = m >> 7;
    const b = this.sq;
    const moved = b[to];
    b[from] = piece;
    b[to] = cap;
    this.turn = (1 - this.turn) as Color;
    const us = this.turn;
    const them = 1 - us;
    if (us === 1) this.fullmove--;
    if ((piece & 7) === KING) this.kingSq[us] = from;
    if (piece & HIDDEN) this.pool[us * 8 + (moved & 7)]++;
    if (cap) {
      let capType = cap & 7;
      if (cap & HIDDEN) {
        capType = this.secret[to];
        this.pool[them * 8 + capType]++;
      }
      this.captured[them * 8 + capType]--;
    }
    this.hashLo = lo;
    this.hashHi = hi;
    this.rev = rev;
  }

  /** Nước "bỏ lượt" cho AI (null-move pruning) */
  makeNullMove(): void {
    this.undoStack.push(-1, 0, 0, this.hashLo, this.hashHi, this.rev);
    this.hashLo ^= Z_SIDE_LO;
    this.hashHi ^= Z_SIDE_HI;
    this.rev++;
    this.turn = (1 - this.turn) as Color;
  }

  unmakeNullMove(): void {
    const st = this.undoStack;
    this.rev = st.pop()!;
    this.hashHi = st.pop()!;
    this.hashLo = st.pop()!;
    st.length -= 3;
    this.turn = (1 - this.turn) as Color;
  }

  /** Nước hợp lệ của bên đi (chỉ cần thông tin công khai) */
  legalMoves(): number[] {
    const pseudo = this.generateMoves(false);
    const out: number[] = [];
    for (const m of pseudo) if (this.isSafe(m)) out.push(m);
    return out;
  }
}
