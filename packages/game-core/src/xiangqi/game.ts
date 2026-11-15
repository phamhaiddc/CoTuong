import type { BoardPiece, Color, GameEngine, GameResult, GameStatus, GameWarning, MoveInfo } from '../types';
import { otherColor } from '../types';
import {
  XiangqiBoard,
  XIANGQI_START_FEN,
  fileOf,
  rankOf,
  sqOf,
  pieceColor,
  pieceType,
  moveFrom,
  moveTo,
  encodeMove,
} from './board';
import { xqMoveNotationVi } from './notation';

const FILE_CHARS = 'abcdefghi';
/** Ký hiệu loại quân dùng ngoài game-core */
export const XQ_TYPE_LETTER = ['', 'k', 'a', 'e', 'h', 'r', 'c', 'p'];
export const XQ_TYPE_NAME_VI = ['', 'Tướng', 'Sĩ', 'Tượng', 'Mã', 'Xe', 'Pháo', 'Tốt'];

export function xqSquareName(s: number): string {
  return FILE_CHARS[fileOf(s)] + rankOf(s);
}

export function xqParseSquare(name: string): number {
  if (!/^[a-i][0-9]$/.test(name)) return -1;
  return sqOf(name.charCodeAt(0) - 97, name.charCodeAt(1) - 48);
}

/** Nước đi dạng ICCS chữ thường không gạch, ví dụ "h2e2" */
export function xqMoveToString(m: number): string {
  return xqSquareName(moveFrom(m)) + xqSquareName(moveTo(m));
}

export function xqParseMove(str: string): number {
  if (typeof str !== 'string') return -1;
  const s = str.trim().toLowerCase().replace('-', '');
  if (!/^[a-i][0-9][a-i][0-9]$/.test(s)) return -1;
  return encodeMove(xqParseSquare(s.slice(0, 2)), xqParseSquare(s.slice(2, 4)));
}

/**
 * Ván cờ tướng với đầy đủ luật kết thúc:
 * - Hết nước đi hợp lệ: bên phải đi bị xử thua (dù bị chiếu hay không).
 * - Lặp thế cờ 3 lần: bên chiếu liên tục (chiếu dai) bị xử thua; trường hợp khác hoà.
 * - Bản đầu chưa xử đuổi dai.
 */
export class XiangqiGame implements GameEngine {
  readonly game = 'xiangqi' as const;
  readonly files = 9;
  readonly ranks = 10;
  readonly board: XiangqiBoard;
  private readonly initialFen: string;
  private readonly initialTurn: Color;
  private readonly moves: string[] = [];
  private readonly infos: MoveInfo[] = [];
  /** keys[i] = khoá thế cờ sau i nước (keys[0] = thế ban đầu) */
  private readonly keys: string[] = [];
  /** checks[i] = nước thứ i có chiếu tướng đối phương không */
  private readonly checks: boolean[] = [];
  private legalCache: number[] | null = null;
  private statusCache: GameStatus | null = null;

  constructor(fen: string = XIANGQI_START_FEN) {
    this.board = new XiangqiBoard(fen);
    this.initialFen = this.board.fen();
    this.initialTurn = this.board.turn;
    this.keys.push(this.board.positionKey());
  }

  turn(): Color {
    return this.board.turn;
  }

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
      .filter((m) => moveFrom(m) === s)
      .map(xqMoveToString);
  }

  isLegal(move: string): boolean {
    const m = xqParseMove(move);
    return m >= 0 && !this.status().over && this.legal().includes(m);
  }

  play(move: string): boolean {
    const m = xqParseMove(move);
    if (m < 0 || this.status().over || !this.legal().includes(m)) return false;
    const from = moveFrom(m);
    const to = moveTo(m);
    const captured = this.board.sq[to] !== 0;
    // Ký hiệu kiểu Việt Nam ("P2-5", "M8.7"…) tính trên thế trước khi đi
    const label = xqMoveNotationVi(this.board.sq, from, to, this.legal());
    this.board.makeMove(m);
    const check = this.board.isKingAttacked(this.board.turn);
    const str = xqMoveToString(m);
    this.moves.push(str);
    this.checks.push(check);
    this.keys.push(this.board.positionKey());
    this.infos.push({
      move: str,
      from: xqSquareName(from),
      to: xqSquareName(to),
      label,
      captured,
      check,
    });
    this.invalidate();
    return true;
  }

  undo(): string | null {
    if (this.moves.length === 0) return null;
    this.board.unmakeMove();
    this.checks.pop();
    this.keys.pop();
    this.infos.pop();
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
      // Cờ tướng: hết nước đi thì thua (khác cờ vua là hoà)
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

  /** Số lần thế cờ hiện tại đã xuất hiện (tính cả hiện tại) */
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
    // Xét chuỗi nước từ lần xuất hiện thứ nhất (trong 3 lần gần nhất) tới hiện tại
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
    const mover = this.board.turn;
    this.play(move);
    const st = this.status();
    this.undo();
    return st.over && st.result.reason === 'perpetual_check' && st.result.winner !== mover;
  }

  pieces(): BoardPiece[] {
    const out: BoardPiece[] = [];
    for (let s = 0; s < 90; s++) {
      const p = this.board.sq[s];
      if (p) out.push({ square: xqSquareName(s), color: pieceColor(p), type: XQ_TYPE_LETTER[pieceType(p)] });
    }
    return out;
  }

  pieceAt(square: string): BoardPiece | null {
    const s = xqParseSquare(square);
    if (s < 0) return null;
    const p = this.board.sq[s];
    return p ? { square, color: pieceColor(p), type: XQ_TYPE_LETTER[pieceType(p)] } : null;
  }

  kingSquare(color: Color): string | null {
    const k = this.board.kingSq[color];
    return k >= 0 ? xqSquareName(k) : null;
  }

  isPromotion(): boolean {
    return false;
  }

  clone(): XiangqiGame {
    const g = new XiangqiGame(this.initialFen);
    for (const m of this.moves) g.play(m);
    return g;
  }
}
