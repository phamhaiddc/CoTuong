import { cb, jq, xq, type Color } from '@cotuong/game-core';
import { evaluateXiangqi, xqHasAttackers, XQ_VALUE } from './eval-xiangqi';
import { evaluateChess, chessHasPieces, CHESS_VALUE } from './eval-chess';
import { evaluateJieqi, jqHasAttackers } from './eval-jieqi';

/**
 * Giao diện bàn cờ mà bộ tìm kiếm dùng; mỗi game có một adapter.
 */
export interface SearchBoard {
  turn(): Color;
  hashLo(): number;
  hashHi(): number;
  generate(capturesOnly: boolean): number[];
  /** false = nước không hợp lệ (đã tự huỷ) */
  make(m: number): boolean;
  unmake(): void;
  makeNull(): void;
  unmakeNull(): void;
  inCheck(): boolean;
  /** Điểm theo góc nhìn bên được đi */
  evaluate(): number;
  /** Giá trị quân bị ăn (0 nếu nước không ăn quân) */
  victimValue(m: number): number;
  attackerValue(m: number): number;
  /** Mã quân đi (0..15) để tra bảng history */
  pieceCode(m: number): number;
  target(m: number): number;
  /** Số ô của bàn (để cấp phát bảng history) */
  readonly squares: number;
  /** Điểm khi bên được đi không còn nước hợp lệ */
  noMovesScore(ply: number, mate: number): number;
  /** Có nên thử null move không (tránh zugzwang) */
  canNullMove(): boolean;
  /** Hoà theo luật không cần xét lặp (cờ vua: 50 nước, không đủ quân) */
  isRuleDraw(): boolean;
  /** Số nửa nước tối đa cần nhìn lại để tìm lặp thế cờ */
  repetitionWindow(): number;
}

export class XiangqiSearchBoard implements SearchBoard {
  readonly squares = 90;
  /**
   * Số nửa nước kể từ lần ăn quân gần nhất (ngăn xếp theo nước đi trong lúc tìm). Thế cờ chỉ có thể lặp trong đoạn
   * này — dùng làm cửa sổ phát hiện lặp (luật cờ tướng xét lặp thế cả ván, không chỉ 100 nửa nước gần nhất).
   */
  private readonly rev: number[];
  constructor(
    readonly b: xq.XiangqiBoard,
    pliesSinceCapture = 0,
  ) {
    this.rev = [pliesSinceCapture];
  }
  turn(): Color {
    return this.b.turn;
  }
  hashLo(): number {
    return this.b.hashLo;
  }
  hashHi(): number {
    return this.b.hashHi;
  }
  generate(capturesOnly: boolean): number[] {
    return this.b.generateMoves(capturesOnly);
  }
  make(m: number): boolean {
    const capture = this.b.sq[m >> 7] !== 0;
    if (!this.b.makeMove(m)) return false;
    this.rev.push(capture ? 0 : this.rev[this.rev.length - 1] + 1);
    return true;
  }
  unmake(): void {
    this.b.unmakeMove();
    if (this.rev.length > 1) this.rev.pop();
  }
  makeNull(): void {
    this.b.makeNullMove();
    // Nước "bỏ lượt" (cắt tỉa null-move) không phải nước thật: không so lặp xuyên qua nó
    this.rev.push(0);
  }
  unmakeNull(): void {
    this.b.unmakeNullMove();
    if (this.rev.length > 1) this.rev.pop();
  }
  inCheck(): boolean {
    return this.b.inCheck();
  }
  evaluate(): number {
    return evaluateXiangqi(this.b);
  }
  victimValue(m: number): number {
    const p = this.b.sq[m >> 7];
    return p ? XQ_VALUE[p & 7] || 1000 : 0;
  }
  attackerValue(m: number): number {
    return XQ_VALUE[this.b.sq[m & 127] & 7] || 1000;
  }
  pieceCode(m: number): number {
    return this.b.sq[m & 127];
  }
  target(m: number): number {
    return m >> 7;
  }
  noMovesScore(ply: number, mate: number): number {
    // Cờ tướng: hết nước đi là thua
    return -mate + ply;
  }
  canNullMove(): boolean {
    return xqHasAttackers(this.b, this.b.turn);
  }
  isRuleDraw(): boolean {
    return false;
  }
  repetitionWindow(): number {
    return this.rev[this.rev.length - 1];
  }
}

/**
 * Cờ úp: bàn của MỘT "mẫu" (danh tính quân úp được bốc thăm từ kho quân chưa lộ — không phải danh tính thật).
 * Băm được XOR thêm `salt` riêng của mẫu để các mẫu dùng chung bảng chuyển vị mà không lẫn kết quả của nhau
 * (cùng một thế công khai có giá trị khác nhau ở mỗi mẫu).
 */
export class JieqiSearchBoard implements SearchBoard {
  readonly squares = 90;
  constructor(
    readonly b: jq.JieqiBoard,
    private readonly saltLo: number,
    private readonly saltHi: number,
    /** [giá trị một quân úp Đỏ, giá trị một quân úp Đen] */
    private readonly hidden: [number, number],
  ) {}
  turn(): Color {
    return this.b.turn;
  }
  hashLo(): number {
    return this.b.hashLo ^ this.saltLo;
  }
  hashHi(): number {
    return this.b.hashHi ^ this.saltHi;
  }
  generate(capturesOnly: boolean): number[] {
    return this.b.generateMoves(capturesOnly);
  }
  make(m: number): boolean {
    return this.b.makeMove(m);
  }
  unmake(): void {
    this.b.unmakeMove();
  }
  makeNull(): void {
    this.b.makeNullMove();
  }
  unmakeNull(): void {
    this.b.unmakeNullMove();
  }
  inCheck(): boolean {
    return this.b.inCheck();
  }
  evaluate(): number {
    return evaluateJieqi(this.b, this.hidden);
  }
  private valueOf(p: number): number {
    if (p & jq.HIDDEN) return this.hidden[(p >> 3) & 1];
    return XQ_VALUE[p & 7] || 1000;
  }
  victimValue(m: number): number {
    const p = this.b.sq[m >> 7];
    return p ? this.valueOf(p) : 0;
  }
  attackerValue(m: number): number {
    return this.valueOf(this.b.sq[m & 127]);
  }
  pieceCode(m: number): number {
    // Bảng history có 16 mã quân: bỏ bit úp
    return this.b.sq[m & 127] & 15;
  }
  target(m: number): number {
    return m >> 7;
  }
  noMovesScore(ply: number, mate: number): number {
    // Như cờ tướng: hết nước đi là thua
    return -mate + ply;
  }
  canNullMove(): boolean {
    return jqHasAttackers(this.b, this.b.turn);
  }
  isRuleDraw(): boolean {
    return false;
  }
  repetitionWindow(): number {
    // Thế trước lần ăn quân / lật quân gần nhất không thể lặp lại
    return this.b.rev;
  }
}

export class ChessSearchBoard implements SearchBoard {
  readonly squares = 64;
  constructor(readonly b: cb.ChessBoard) {}
  turn(): Color {
    return this.b.turn;
  }
  hashLo(): number {
    return this.b.hashLo;
  }
  hashHi(): number {
    return this.b.hashHi;
  }
  generate(capturesOnly: boolean): number[] {
    return this.b.generateMoves(capturesOnly);
  }
  make(m: number): boolean {
    return this.b.makeMove(m);
  }
  unmake(): void {
    this.b.unmakeMove();
  }
  makeNull(): void {
    this.b.makeNullMove();
  }
  unmakeNull(): void {
    this.b.unmakeNullMove();
  }
  inCheck(): boolean {
    return this.b.inCheck();
  }
  evaluate(): number {
    return evaluateChess(this.b);
  }
  victimValue(m: number): number {
    const flag = cb.cMoveFlag(m);
    if (flag === cb.FLAG_EP) return CHESS_VALUE[cb.PAWN];
    const p = this.b.sq[cb.cMoveTo(m)];
    let v = p ? CHESS_VALUE[p & 7] : 0;
    const promo = cb.cMovePromo(m);
    if (promo) v += CHESS_VALUE[promo];
    return v;
  }
  attackerValue(m: number): number {
    return CHESS_VALUE[this.b.sq[cb.cMoveFrom(m)] & 7] || 1000;
  }
  pieceCode(m: number): number {
    return this.b.sq[cb.cMoveFrom(m)];
  }
  target(m: number): number {
    return cb.cMoveTo(m);
  }
  noMovesScore(ply: number, mate: number): number {
    return this.b.inCheck() ? -mate + ply : 0;
  }
  canNullMove(): boolean {
    return chessHasPieces(this.b, this.b.turn);
  }
  isRuleDraw(): boolean {
    if (this.b.insufficientMaterial()) return true;
    if (this.b.halfmove < 100) return false;
    // Như game-core: chiếu hết đúng ở nửa nước thứ 100 vẫn là thắng — chỉ hoà 50 nước khi bên đi KHÔNG bị chiếu hết
    // (không thì máy bỏ lỡ nước chiếu hết của mình / coi nước bị chiếu hết là "hoà")
    return !this.b.inCheck() || this.b.hasLegalMove();
  }
  repetitionWindow(): number {
    return this.b.halfmove;
  }
}
