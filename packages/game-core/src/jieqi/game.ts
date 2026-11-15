import type { BoardPiece, Color, GameEngine, GameResult, GameStatus, GameWarning, JieqiReveal, MoveInfo } from '../types';
import { otherColor } from '../types';
import { ADVISOR, CANNON, ELEPHANT, HORSE, KING, PAWN, ROOK, X_SQUARES } from '../xiangqi/board';
import { XQ_TYPE_NAME_VI, xqMoveToString, xqParseMove, xqParseSquare, xqSquareName } from '../xiangqi/game';
import { xqMoveNotationVi } from '../xiangqi/notation';
import { HIDDEN, JIEQI_START_FEN, JQ_LETTER_TYPE, JQ_TYPE_LETTER, JieqiBoard } from './board';
import { parseJieqiSetup } from './setup';

/**
 * Chế độ hiểu biết của một ván Cờ úp:
 *  - 'full'   biết danh tính mọi quân úp (server; ván với máy chạy trong trình duyệt). `play(move)` tự lật quân.
 *  - 'public' chỉ biết thông tin công khai (người chơi online). Nước đi dính tới quân úp phải kèm thông tin
 *             lật quân server gửi: `play(move, reveal)`.
 */
export type JieqiKnowledge = 'full' | 'public';

/** Loại quân có thể úp (ký hiệu chữ thường của game-core) */
export type JieqiPieceLetter = 'r' | 'h' | 'e' | 'a' | 'c' | 'p';

/** Số quân theo loại của một bên (ví dụ kho quân chưa lộ, quân đã bị ăn) */
export type JieqiPool = Record<JieqiPieceLetter, number>;

export interface JieqiGameOptions {
  /**
   * Chuỗi xếp quân (xem setup.ts). Có → chế độ biết đủ ('full'), thế bắt đầu phải còn đủ 15 quân úp mỗi bên.
   * Không có (và không có `secrets`) → chế độ công khai ('public').
   */
  setup?: string | null;
  /** Thế bắt đầu (FEN cờ úp công khai, xem JieqiBoard.setFen). Mặc định JIEQI_START_FEN. */
  fen?: string;
  /**
   * Chế độ biết đủ cho thế tuỳ chọn (test, phân tích): danh tính từng quân úp theo ô, ví dụ { a0: 'c', b9: 'r' }.
   * Phải có đủ mọi quân úp và khớp kho quân chưa lộ của FEN.
   */
  secrets?: Readonly<Record<string, string>> | null;
}

/**
 * Toàn bộ thông tin công khai của một ván (không chứa bí mật): đủ để dựng lại ván ở chế độ công khai
 * (replayJieqiPublic) — dùng làm đầu vào cho AI.
 */
export interface JieqiPublicRecord {
  startFen: string;
  moves: string[];
  /** Mỗi nửa nước một phần tử; null nếu nửa nước đó không dính tới quân úp */
  reveals: Array<JieqiReveal | null>;
}

const POOL_TYPES: Array<[JieqiPieceLetter, number]> = [
  ['r', ROOK],
  ['h', HORSE],
  ['e', ELEPHANT],
  ['a', ADVISOR],
  ['c', CANNON],
  ['p', PAWN],
];

/** Chữ cái lật quân hợp lệ → loại; undefined/null → 0 (không có); sai → -1 */
function revealType(v: unknown): number {
  if (v === undefined || v === null) return 0;
  if (typeof v !== 'string' || !/^[rheacp]$/.test(v)) return -1;
  return JQ_LETTER_TYPE[v];
}

const copyReveal = (r: JieqiReveal | null): JieqiReveal | null => (r ? { ...r } : null);

/**
 * Ván Cờ úp (Jieqi) với đầy đủ luật kết thúc như cờ tướng của ứng dụng:
 * - Hết nước đi hợp lệ: bên phải đi bị xử thua.
 * - Lặp thế cờ 3 lần (trạng thái úp là một phần của thế cờ): bên chiếu liên tục bị xử thua; trường hợp khác hoà.
 *
 * Luật quân: quân úp đi nước đầu theo loại quân gốc của ô nó đứng (luật cờ tướng thường của loại đó) rồi lật
 * lên; từ đó đi theo loại thật. Sĩ, Tượng đã lật không bị giới hạn cung / sông (Tượng vẫn bị cản mắt).
 * Tướng ở trong cung. Tốt theo luật thường của bên mình. Quân úp bị ăn được lật cho cả hai bên xem.
 *
 * `game` là 'xiangqi' để giao diện vẽ bàn cờ tướng; `variant` là 'jieqi'.
 */
export class JieqiGame implements GameEngine {
  readonly game = 'xiangqi' as const;
  readonly variant = 'jieqi' as const;
  readonly files = 9;
  readonly ranks = 10;
  readonly board: JieqiBoard;
  readonly knowledge: JieqiKnowledge;
  private readonly opts: { fen: string; setup: string | null; secrets: Record<string, string> | null };
  private readonly initialFen: string;
  private readonly initialTurn: Color;
  private readonly moves: string[] = [];
  private readonly infos: MoveInfo[] = [];
  private readonly revealList: Array<JieqiReveal | null> = [];
  /** keys[i] = khoá thế cờ sau i nước (keys[0] = thế ban đầu) */
  private readonly keys: string[] = [];
  /** checks[i] = nước thứ i có chiếu tướng đối phương không */
  private readonly checks: boolean[] = [];
  private legalCache: number[] | null = null;
  private statusCache: GameStatus | null = null;

  constructor(options: JieqiGameOptions = {}) {
    this.board = new JieqiBoard(options.fen ?? JIEQI_START_FEN);
    const b = this.board;
    const setup = options.setup ?? null;
    const secrets = options.secrets ?? null;
    if (setup !== null && secrets !== null) throw new Error('Cờ úp: chỉ truyền một trong setup hoặc secrets');
    if (setup !== null) {
      if (b.hiddenCount(0) !== 15 || b.hiddenCount(1) !== 15) {
        throw new Error('Cờ úp: chuỗi xếp quân chỉ dùng cho thế bắt đầu (đủ 15 quân úp mỗi bên)');
      }
      const types = parseJieqiSetup(setup);
      for (let s = 0; s < X_SQUARES; s++) if (b.sq[s] & HIDDEN) b.secret[s] = types[s];
      this.knowledge = 'full';
    } else if (secrets !== null) {
      const count = new Int8Array(16);
      for (const [name, letter] of Object.entries(secrets)) {
        const s = xqParseSquare(name);
        const t = typeof letter === 'string' ? JQ_LETTER_TYPE[letter.toLowerCase()] : undefined;
        if (s < 0 || !(b.sq[s] & HIDDEN)) throw new Error(`Cờ úp: ô ${name} không có quân úp`);
        if (!t || t === KING) throw new Error(`Cờ úp: loại quân "${String(letter)}" ở ô ${name} không hợp lệ`);
        b.secret[s] = t;
        count[((b.sq[s] >> 3) & 1) * 8 + t]++;
      }
      for (let s = 0; s < X_SQUARES; s++) {
        if (b.sq[s] & HIDDEN && !b.secret[s]) throw new Error(`Cờ úp: thiếu danh tính quân úp ở ô ${xqSquareName(s)}`);
      }
      for (let i = 0; i < 16; i++) {
        if (count[i] !== b.pool[i]) throw new Error('Cờ úp: danh tính quân úp không khớp số quân chưa lộ của FEN');
      }
      this.knowledge = 'full';
    } else {
      this.knowledge = 'public';
    }
    this.initialFen = b.fen();
    this.initialTurn = b.turn;
    this.keys.push(b.positionKey());
    this.opts = { fen: this.initialFen, setup, secrets: secrets ? { ...secrets } : null };
  }

  turn(): Color {
    return this.board.turn;
  }

  /** FEN công khai của thế hiện tại (quân úp ghi X/x — không chứa danh tính) */
  fen(): string {
    return this.board.fen();
  }

  startFen(): string {
    return this.initialFen;
  }

  history(): string[] {
    return this.moves.slice();
  }

  historyInfo(): MoveInfo[] {
    return this.infos.slice();
  }

  /** Thông tin lật quân của từng nửa nước (null nếu nửa nước đó không dính tới quân úp) — công khai */
  reveals(): Array<JieqiReveal | null> {
    return this.revealList.map(copyReveal);
  }

  /** Thông tin lật quân của nửa nước vừa đi (server gửi kèm sự kiện nước đi) */
  lastReveal(): JieqiReveal | null {
    return this.revealList.length ? copyReveal(this.revealList[this.revealList.length - 1]) : null;
  }

  /** Toàn bộ thông tin công khai của ván (đầu vào cho AI / dựng lại ván phía người chơi) */
  publicRecord(): JieqiPublicRecord {
    return { startFen: this.initialFen, moves: this.moves.slice(), reveals: this.reveals() };
  }

  private legal(): number[] {
    if (!this.legalCache) this.legalCache = this.board.legalMoves();
    return this.legalCache;
  }

  private invalidate(): void {
    this.legalCache = null;
    this.statusCache = null;
  }

  legalMoves(): string[] {
    if (this.status().over) return [];
    return this.legal().map(xqMoveToString);
  }

  legalMovesFrom(square: string): string[] {
    const s = xqParseSquare(square);
    if (s < 0 || this.status().over) return [];
    return this.legal()
      .filter((m) => (m & 127) === s)
      .map(xqMoveToString);
  }

  isLegal(move: string): boolean {
    const m = xqParseMove(move);
    return m >= 0 && !this.status().over && this.legal().includes(m);
  }

  /**
   * Nước hợp lệ này có dính tới quân úp không (quân đi đang úp hoặc ăn quân úp). Ở chế độ công khai,
   * nước như vậy chỉ đi được khi có thông tin lật quân từ server.
   */
  needsReveal(move: string): boolean {
    if (!this.isLegal(move)) return false;
    return this.board.touchesHidden(xqParseMove(move));
  }

  /**
   * Đi một nước; trả về false nếu không hợp lệ hoặc ván đã kết thúc.
   * Chế độ 'public': nếu quân đi đang úp thì `reveal.piece` bắt buộc, nếu ăn quân úp thì `reveal.captured`
   * bắt buộc (chữ thường r h e a c p, phải còn trong kho quân chưa lộ); có trường thừa cũng bị từ chối.
   * Chế độ 'full': danh tính lấy từ thế xếp quân, `reveal` bị bỏ qua.
   */
  play(move: string, reveal?: JieqiReveal | null): boolean {
    const m = xqParseMove(move);
    if (m < 0 || this.status().over || !this.legal().includes(m)) return false;
    const b = this.board;
    const from = m & 127;
    const to = m >> 7;
    const piece = b.sq[from];
    const cap = b.sq[to];
    const us = b.turn;
    const them = otherColor(us);
    const moverHidden = (piece & HIDDEN) !== 0;
    const capHidden = (cap & HIDDEN) !== 0;
    if (this.knowledge === 'public') {
      const pt = revealType(reveal?.piece);
      const ct = revealType(reveal?.captured);
      if (moverHidden ? pt <= 0 || b.pool[us * 8 + pt] <= 0 : pt !== 0) return false;
      if (capHidden ? ct <= 0 || b.pool[them * 8 + ct] <= 0 : ct !== 0) return false;
      if (moverHidden) b.secret[from] = pt;
      if (capHidden) b.secret[to] = ct;
    }
    const revealed = moverHidden ? b.secret[from] : 0;
    const capturedType = capHidden ? b.secret[to] : 0;
    // Ký hiệu kiểu Việt Nam tính trên thế trước khi đi; quân úp được ký hiệu theo loại gốc của ô (loại nó đi theo),
    // sau đó ghi quân lật ra: "B7.1 → Xe". Ăn quân úp: thêm "(ăn Pháo úp)". (Cách ghi riêng của ứng dụng — Cờ úp
    // không có quy ước ghi biên bản tiếng Việt nào được đối chiếu.)
    let label = xqMoveNotationVi(b.sq, from, to, this.legal());
    if (moverHidden) label += ` → ${XQ_TYPE_NAME_VI[revealed]}`;
    if (capHidden) label += ` (ăn ${XQ_TYPE_NAME_VI[capturedType]} úp)`;
    b.doMove(m);
    const check = b.isKingAttacked(b.turn);
    const str = xqMoveToString(m);
    let rv: JieqiReveal | null = null;
    if (moverHidden || capHidden) {
      rv = {};
      if (moverHidden) rv.piece = JQ_TYPE_LETTER[revealed];
      if (capHidden) rv.captured = JQ_TYPE_LETTER[capturedType];
    }
    const f = xqSquareName(from);
    const t = xqSquareName(to);
    this.moves.push(str);
    this.checks.push(check);
    this.keys.push(b.positionKey());
    this.revealList.push(rv);
    const info: MoveInfo = { move: str, from: f, to: t, label, captured: cap !== 0, check };
    if (rv) info.reveal = { ...rv };
    this.infos.push(info);
    this.invalidate();
    return true;
  }

  undo(): string | null {
    if (this.moves.length === 0) return null;
    this.board.unmakeMove();
    this.checks.pop();
    this.keys.pop();
    this.infos.pop();
    this.revealList.pop();
    this.invalidate();
    return this.moves.pop()!;
  }

  inCheck(): boolean {
    return this.board.inCheck();
  }

  status(): GameStatus {
    if (this.statusCache) return this.statusCache;
    let st: GameStatus = { over: false };
    if (this.legal().length === 0) {
      // Như cờ tướng: hết nước đi thì thua
      st = {
        over: true,
        result: { winner: otherColor(this.board.turn), reason: this.board.inCheck() ? 'checkmate' : 'stalemate' },
      };
    } else {
      const rep = this.repetitionResult();
      if (rep) st = { over: true, result: rep };
    }
    this.statusCache = st;
    return st;
  }

  /** Số lần thế cờ hiện tại đã xuất hiện (tính cả hiện tại); trạng thái úp là một phần của thế cờ */
  repetitionCount(): number {
    const cur = this.keys[this.keys.length - 1];
    let n = 0;
    for (const k of this.keys) if (k === cur) n++;
    return n;
  }

  private repetitionResult(): GameResult | null {
    const n = this.moves.length;
    const cur = this.keys[n];
    const idx: number[] = [];
    for (let i = 0; i <= n; i++) if (this.keys[i] === cur) idx.push(i);
    if (idx.length < 3) return null;
    const start = idx[idx.length - 3];
    const allCheck = [true, true];
    const made = [false, false];
    for (let j = start; j < n; j++) {
      const mover = (this.initialTurn + j) % 2;
      made[mover] = true;
      if (!this.checks[j]) allCheck[mover] = false;
    }
    const red = made[0] && allCheck[0];
    const black = made[1] && allCheck[1];
    if (red && !black) return { winner: 1, reason: 'perpetual_check' };
    if (black && !red) return { winner: 0, reason: 'perpetual_check' };
    return { winner: null, reason: 'repetition' };
  }

  warnings(): GameWarning[] {
    if (this.status().over) return [];
    return this.repetitionCount() === 2 ? [{ type: 'repetition' }] : [];
  }

  isPerpetualCheckLoss(move: string): boolean {
    if (!this.isLegal(move)) return false;
    const m = xqParseMove(move);
    const b = this.board;
    // Nước ăn quân hoặc lật quân luôn tạo thế cờ mới (không thể lặp) — không cần biết danh tính quân úp
    if (b.sq[m >> 7] !== 0 || b.sq[m & 127] & HIDDEN) return false;
    const mover = b.turn;
    this.play(move);
    const st = this.status();
    this.undo();
    return st.over && st.result.reason === 'perpetual_check' && st.result.winner !== mover;
  }

  private pieceOf(s: number, p: number): BoardPiece {
    const piece: BoardPiece = { square: xqSquareName(s), color: ((p >> 3) & 1) as Color, type: JQ_TYPE_LETTER[p & 7] };
    if (p & HIDDEN) piece.hidden = true;
    return piece;
  }

  /** Quân trên bàn; quân úp có `hidden: true` và `type` = loại gốc của ô (không phải danh tính thật) */
  pieces(): BoardPiece[] {
    const out: BoardPiece[] = [];
    for (let s = 0; s < X_SQUARES; s++) {
      const p = this.board.sq[s];
      if (p) out.push(this.pieceOf(s, p));
    }
    return out;
  }

  pieceAt(square: string): BoardPiece | null {
    const s = xqParseSquare(square);
    if (s < 0) return null;
    const p = this.board.sq[s];
    return p ? this.pieceOf(s, p) : null;
  }

  kingSquare(color: Color): string | null {
    const k = this.board.kingSq[color];
    return k >= 0 ? xqSquareName(k) : null;
  }

  isPromotion(): boolean {
    return false;
  }

  /** Ô này có quân úp không */
  isHidden(square: string): boolean {
    const s = xqParseSquare(square);
    return s >= 0 && (this.board.sq[s] & HIDDEN) !== 0;
  }

  /** Số quân úp của một bên còn trên bàn */
  hiddenCount(color: Color): number {
    return this.board.hiddenCount(color);
  }

  /**
   * Kho quân chưa lộ danh tính của mỗi bên ([Đỏ, Đen]) — công khai. Tổng của một bên = số quân úp của bên đó.
   */
  pools(): [JieqiPool, JieqiPool] {
    return [this.countsOf(this.board.pool, 0), this.countsOf(this.board.pool, 1)];
  }

  /** Quân đã bị ăn của mỗi bên ([Đỏ, Đen]) theo loại thật — công khai */
  capturedPieces(): [JieqiPool, JieqiPool] {
    return [this.countsOf(this.board.captured, 0), this.countsOf(this.board.captured, 1)];
  }

  private countsOf(arr: Int8Array, color: Color): JieqiPool {
    const out = {} as JieqiPool;
    for (const [letter, t] of POOL_TYPES) out[letter] = arr[color * 8 + t];
    return out;
  }

  /**
   * BÍ MẬT — chuỗi xếp quân của ván (chỉ có ở chế độ 'full' tạo từ setup; null nếu không có).
   * Server chỉ được gửi cho người chơi sau khi ván kết thúc.
   */
  setup(): string | null {
    return this.knowledge === 'full' ? this.opts.setup : null;
  }

  /**
   * BÍ MẬT — danh tính thật của quân úp ở ô `square` (chế độ 'full'; null nếu ô không có quân úp hoặc chế độ
   * công khai). Chỉ dùng khi ván đã kết thúc (ví dụ xem lại ván, lật hết quân còn úp).
   */
  secretTypeAt(square: string): string | null {
    if (this.knowledge !== 'full') return null;
    const s = xqParseSquare(square);
    if (s < 0 || !(this.board.sq[s] & HIDDEN)) return null;
    return JQ_TYPE_LETTER[this.board.secret[s]] || null;
  }

  clone(): JieqiGame {
    const o = this.opts;
    const g = new JieqiGame(
      this.knowledge === 'public'
        ? { fen: o.fen }
        : o.setup !== null
          ? { fen: o.fen, setup: o.setup }
          : { fen: o.fen, secrets: o.secrets },
    );
    for (let i = 0; i < this.moves.length; i++) {
      if (!g.play(this.moves[i], this.revealList[i])) throw new Error(`Cờ úp: không sao chép được nước ${this.moves[i]}`);
    }
    return g;
  }
}

/**
 * Ván Cờ úp mới từ thế bắt đầu.
 * - Có `setup` (server, ván với máy trong trình duyệt): chế độ biết đủ.
 * - Không có: chế độ công khai (người chơi online), đi bằng `play(move, reveal)`.
 */
export function createJieqiGame(setup?: string | null): JieqiGame {
  return new JieqiGame({ setup: setup ?? null });
}

/** Dựng lại ván ở chế độ biết đủ từ chuỗi xếp quân + danh sách nước. Ném lỗi nếu có nước không hợp lệ. */
export function replayJieqi(setup: string, moves: readonly string[]): JieqiGame {
  const g = new JieqiGame({ setup });
  for (let i = 0; i < moves.length; i++) {
    if (!g.play(moves[i])) throw new Error(`Nước thứ ${i + 1} không hợp lệ: ${moves[i]}`);
  }
  return g;
}

/**
 * Dựng lại ván ở chế độ công khai từ danh sách nước + thông tin lật quân của từng nửa nước (thiếu phần tử
 * = null). Ném lỗi nếu có nước không hợp lệ hoặc thông tin lật quân sai / thiếu.
 */
export function replayJieqiPublic(
  moves: readonly string[],
  reveals: ReadonlyArray<JieqiReveal | null | undefined> = [],
  startFen?: string,
): JieqiGame {
  if (reveals.length > moves.length) throw new Error('Cờ úp: số thông tin lật quân nhiều hơn số nước đi');
  const g = new JieqiGame({ fen: startFen });
  for (let i = 0; i < moves.length; i++) {
    if (!g.play(moves[i], reveals[i] ?? null)) {
      throw new Error(`Nước thứ ${i + 1} không hợp lệ hoặc thông tin lật quân sai: ${moves[i]}`);
    }
  }
  return g;
}
