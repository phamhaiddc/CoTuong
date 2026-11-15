import type { BoardPiece, Color, GameEngine, GameStatus, GameWarning, MoveInfo } from '../types';
import { otherColor } from '../types';
import {
  ChessBoard,
  CHESS_START_FEN,
  C_TYPE_LETTER,
  FLAG_CASTLE,
  FLAG_EP,
  PAWN,
  cMoveFlag,
  cMoveFrom,
  cMovePromo,
  cMoveTo,
  cPieceColor,
  cPieceType,
  chessParseSquare,
  chessSquareName,
} from './board';

const PROMO_LETTER = ['', '', 'n', 'b', 'r', 'q', ''];
const SAN_LETTER = ['', '', 'N', 'B', 'R', 'Q', 'K'];

export function chessMoveToString(m: number): string {
  const promo = cMovePromo(m);
  return chessSquareName(cMoveFrom(m)) + chessSquareName(cMoveTo(m)) + (promo ? PROMO_LETTER[promo] : '');
}

/** Số nửa nước (mỗi bên 40 nước) bắt đầu cảnh báo luật 50 nước */
export const FIFTY_MOVE_WARNING_HALFMOVES = 80;

/**
 * Ván cờ vua. Hệ thống tự kết thúc hoà khi: hết nước đi hợp lệ (stalemate), không đủ quân chiếu hết,
 * lặp thế cờ 3 lần, 50 nước mỗi bên không ăn quân và không đi tốt.
 */
export class ChessGame implements GameEngine {
  readonly game = 'chess' as const;
  readonly files = 8;
  readonly ranks = 8;
  readonly board: ChessBoard;
  private readonly initialFen: string;
  private readonly moves: string[] = [];
  private readonly infos: MoveInfo[] = [];
  private readonly keys: string[] = [];
  private legalCache: number[] | null = null;
  private statusCache: GameStatus | null = null;

  constructor(fen: string = CHESS_START_FEN) {
    this.board = new ChessBoard(fen);
    this.initialFen = this.board.fen();
    this.keys.push(this.positionKey());
  }

  private legal(): number[] {
    if (!this.legalCache) this.legalCache = this.board.legalMoves();
    return this.legalCache;
  }

  private invalidate(): void {
    this.legalCache = null;
    this.statusCache = null;
  }

  /** Khoá thế cờ để xét lặp: vị trí, bên đi, quyền nhập thành, ô bắt tốt qua đường (nếu bắt được thật) */
  private positionKey(): string {
    const b = this.board;
    let ep = '-';
    if (b.ep >= 0 && this.legal().some((m) => cMoveFlag(m) === FLAG_EP)) ep = chessSquareName(b.ep);
    return `${b.placement()} ${b.turn === 0 ? 'w' : 'b'} ${b.castlingString()} ${ep}`;
  }

  private findMove(move: string): number {
    if (typeof move !== 'string') return -1;
    const s = move.trim().toLowerCase();
    const mm = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/.exec(s);
    if (!mm) return -1;
    const from = chessParseSquare(mm[1]);
    const to = chessParseSquare(mm[2]);
    const promo = mm[3] ? PROMO_LETTER.indexOf(mm[3]) : 0;
    for (const m of this.legal()) {
      if (cMoveFrom(m) === from && cMoveTo(m) === to && cMovePromo(m) === promo) return m;
    }
    return -1;
  }

  private san(m: number): string {
    const b = this.board;
    const from = cMoveFrom(m);
    const to = cMoveTo(m);
    const flag = cMoveFlag(m);
    const piece = b.sq[from];
    const type = cPieceType(piece);
    if (flag === FLAG_CASTLE) return to > from ? 'O-O' : 'O-O-O';
    const capture = b.sq[to] !== 0 || flag === FLAG_EP;
    let s = '';
    if (type === PAWN) {
      if (capture) s += 'abcdefgh'[from & 7] + 'x';
      s += chessSquareName(to);
      const promo = cMovePromo(m);
      if (promo) s += '=' + SAN_LETTER[promo];
      return s;
    }
    s += SAN_LETTER[type];
    const others = this.legal().filter(
      (o) => o !== m && cMoveTo(o) === to && b.sq[cMoveFrom(o)] === piece && cMoveFrom(o) !== from,
    );
    if (others.length) {
      const sameFile = others.some((o) => (cMoveFrom(o) & 7) === (from & 7));
      const sameRank = others.some((o) => cMoveFrom(o) >> 3 === from >> 3);
      if (!sameFile) s += 'abcdefgh'[from & 7];
      else if (!sameRank) s += String((from >> 3) + 1);
      else s += chessSquareName(from);
    }
    if (capture) s += 'x';
    s += chessSquareName(to);
    return s;
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

  legalMoves(): string[] {
    if (this.status().over) return [];
    return this.legal().map(chessMoveToString);
  }

  legalMovesFrom(square: string): string[] {
    const s = chessParseSquare(square);
    if (s < 0 || this.status().over) return [];
    return this.legal()
      .filter((m) => cMoveFrom(m) === s)
      .map(chessMoveToString);
  }

  isLegal(move: string): boolean {
    return !this.status().over && this.findMove(move) >= 0;
  }

  isPromotion(from: string, to: string): boolean {
    const f = chessParseSquare(from);
    const t = chessParseSquare(to);
    return this.legal().some((m) => cMoveFrom(m) === f && cMoveTo(m) === t && cMovePromo(m) !== 0);
  }

  play(move: string): boolean {
    if (this.status().over) return false;
    const m = this.findMove(move);
    if (m < 0) return false;
    let label = this.san(m);
    const from = cMoveFrom(m);
    const to = cMoveTo(m);
    const captured = this.board.sq[to] !== 0 || cMoveFlag(m) === FLAG_EP;
    this.board.makeMove(m);
    this.invalidate();
    const check = this.board.inCheck();
    if (check) label += this.legal().length === 0 ? '#' : '+';
    const str = chessMoveToString(m);
    this.moves.push(str);
    this.keys.push(this.positionKey());
    this.infos.push({ move: str, from: chessSquareName(from), to: chessSquareName(to), label, captured, check });
    return true;
  }

  undo(): string | null {
    if (this.moves.length === 0) return null;
    this.board.unmakeMove();
    this.keys.pop();
    this.infos.pop();
    this.invalidate();
    return this.moves.pop()!;
  }

  inCheck(): boolean {
    return this.board.inCheck();
  }

  repetitionCount(): number {
    const cur = this.keys[this.keys.length - 1];
    let n = 0;
    for (const k of this.keys) if (k === cur) n++;
    return n;
  }

  status(): GameStatus {
    if (this.statusCache) return this.statusCache;
    let st: GameStatus = { over: false };
    const b = this.board;
    if (this.legal().length === 0) {
      st = b.inCheck()
        ? { over: true, result: { winner: otherColor(b.turn), reason: 'checkmate' } }
        : { over: true, result: { winner: null, reason: 'stalemate' } };
    } else if (b.insufficientMaterial()) {
      st = { over: true, result: { winner: null, reason: 'insufficient_material' } };
    } else if (this.repetitionCount() >= 3) {
      st = { over: true, result: { winner: null, reason: 'repetition' } };
    } else if (b.halfmove >= 100) {
      st = { over: true, result: { winner: null, reason: 'fifty_moves' } };
    }
    this.statusCache = st;
    return st;
  }

  warnings(): GameWarning[] {
    if (this.status().over) return [];
    const out: GameWarning[] = [];
    if (this.repetitionCount() === 2) out.push({ type: 'repetition' });
    if (this.board.halfmove >= FIFTY_MOVE_WARNING_HALFMOVES) {
      out.push({ type: 'fifty_moves', movesLeft: Math.ceil((100 - this.board.halfmove) / 2) });
    }
    return out;
  }

  isPerpetualCheckLoss(): boolean {
    return false;
  }

  pieces(): BoardPiece[] {
    const out: BoardPiece[] = [];
    for (let s = 0; s < 64; s++) {
      const p = this.board.sq[s];
      if (p) out.push({ square: chessSquareName(s), color: cPieceColor(p), type: C_TYPE_LETTER[cPieceType(p)] });
    }
    return out;
  }

  pieceAt(square: string): BoardPiece | null {
    const s = chessParseSquare(square);
    if (s < 0) return null;
    const p = this.board.sq[s];
    return p ? { square, color: cPieceColor(p), type: C_TYPE_LETTER[cPieceType(p)] } : null;
  }

  kingSquare(color: Color): string | null {
    const k = this.board.kingSq[color];
    return k >= 0 ? chessSquareName(k) : null;
  }

  clone(): ChessGame {
    const g = new ChessGame(this.initialFen);
    for (const m of this.moves) g.play(m);
    return g;
  }
}
