import type { SearchBoard } from './adapters';

export const MATE = 30_000;
const INF = 32_000;
const MATE_BOUND = MATE - 1_000;
export const MAX_PLY = 64;

const TT_EXACT = 1;
const TT_LOWER = 2;
const TT_UPPER = 3;

/** Bảng chuyển vị (transposition table) dùng mảng kiểu cố định để tiết kiệm bộ nhớ */
export class TranspositionTable {
  readonly size: number;
  private readonly mask: number;
  readonly keyLo: Int32Array;
  readonly keyHi: Int32Array;
  readonly move: Int32Array;
  readonly score: Int32Array;
  readonly depth: Int8Array;
  readonly flag: Int8Array;

  constructor(bits = 19) {
    this.size = 1 << bits;
    this.mask = this.size - 1;
    this.keyLo = new Int32Array(this.size);
    this.keyHi = new Int32Array(this.size);
    this.move = new Int32Array(this.size);
    this.score = new Int32Array(this.size);
    this.depth = new Int8Array(this.size);
    this.flag = new Int8Array(this.size);
  }

  clear(): void {
    this.flag.fill(0);
  }

  probe(lo: number, hi: number): number {
    const i = lo & this.mask;
    return this.flag[i] !== 0 && this.keyLo[i] === lo && this.keyHi[i] === hi ? i : -1;
  }

  store(lo: number, hi: number, depth: number, flag: number, score: number, move: number): void {
    const i = lo & this.mask;
    if (this.flag[i] !== 0 && this.keyLo[i] === lo && this.keyHi[i] === hi && this.depth[i] > depth && flag !== TT_EXACT) {
      return;
    }
    this.keyLo[i] = lo;
    this.keyHi[i] = hi;
    this.depth[i] = depth;
    this.flag[i] = flag;
    this.score[i] = score;
    this.move[i] = move;
  }
}

/** Điểm chiếu bí lưu vào TT theo khoảng cách từ nút hiện tại */
const toTT = (s: number, ply: number) => (s >= MATE_BOUND ? s + ply : s <= -MATE_BOUND ? s - ply : s);
const fromTT = (s: number, ply: number) => (s >= MATE_BOUND ? s - ply : s <= -MATE_BOUND ? s + ply : s);

export interface SearchLimits {
  maxDepth: number;
  /** Giới hạn thời gian (ms); null = chỉ theo độ sâu */
  timeMs: number | null;
  quiescence: boolean;
  /**
   * (Tuỳ chọn) Cộng ngẫu nhiên 0..N điểm cho mỗi nước ở gốc (mỗi lần tìm một bộ khác) — các nước gần ngang nhau được
   * chọn luân phiên, máy không đi y hệt mỗi ván. Cửa sổ alpha-beta được dịch theo nên kết quả vẫn chính xác.
   */
  rootNoiseCp?: number;
}

export interface RootResult {
  move: number;
  score: number;
  depth: number;
  nodes: number;
}

export class Searcher {
  nodes = 0;
  private stopped = false;
  private deadline = Infinity;
  private extLimit = 0;
  private readonly killers = new Int32Array(MAX_PLY * 2);
  private readonly history: Int32Array;
  /** Hash các thế cờ trước (lịch sử ván + đường tìm kiếm) để phát hiện lặp */
  private readonly stackLo: number[];
  private readonly stackHi: number[];
  private limits: SearchLimits = { maxDepth: 1, timeMs: null, quiescence: true };

  constructor(
    private readonly b: SearchBoard,
    private readonly tt: TranspositionTable,
    previousHashes: Array<[number, number]>,
  ) {
    this.history = new Int32Array(16 * b.squares);
    this.stackLo = previousHashes.map((h) => h[0]);
    this.stackHi = previousHashes.map((h) => h[1]);
  }

  private push(lo: number, hi: number): void {
    this.stackLo.push(lo);
    this.stackHi.push(hi);
  }

  private pop(): void {
    this.stackLo.pop();
    this.stackHi.pop();
  }

  private isRepetition(lo: number, hi: number): boolean {
    const n = this.stackLo.length;
    const limit = Math.max(0, n - this.b.repetitionWindow());
    // Chỉ so các thế cùng bên đi: cách nhau số chẵn nửa nước, chu kỳ tối thiểu 4 nửa nước
    for (let i = n - 4; i >= limit; i -= 2) {
      if (this.stackLo[i] === lo && this.stackHi[i] === hi) return true;
    }
    return false;
  }

  private checkTime(): void {
    if ((this.nodes & 1023) === 0 && Date.now() > this.deadline) this.stopped = true;
  }

  private scoreMoves(moves: number[], ttMove: number, ply: number): Int32Array {
    const b = this.b;
    const scores = new Int32Array(moves.length);
    const k0 = this.killers[ply * 2];
    const k1 = this.killers[ply * 2 + 1];
    for (let i = 0; i < moves.length; i++) {
      const m = moves[i];
      if (m === ttMove) {
        scores[i] = 10_000_000;
        continue;
      }
      const v = b.victimValue(m);
      if (v > 0) scores[i] = 1_000_000 + v * 10 - ((b.attackerValue(m) / 10) | 0);
      else if (m === k0) scores[i] = 900_000;
      else if (m === k1) scores[i] = 800_000;
      else scores[i] = this.history[b.pieceCode(m) * b.squares + b.target(m)];
    }
    return scores;
  }

  private static pickBest(moves: number[], scores: Int32Array, i: number): void {
    let best = i;
    for (let j = i + 1; j < moves.length; j++) if (scores[j] > scores[best]) best = j;
    if (best !== i) {
      const m = moves[i];
      moves[i] = moves[best];
      moves[best] = m;
      const s = scores[i];
      scores[i] = scores[best];
      scores[best] = s;
    }
  }

  private quiesce(alpha: number, beta: number, ply: number): number {
    this.nodes++;
    this.checkTime();
    if (this.stopped) return 0;
    const b = this.b;
    if (b.isRuleDraw()) return 0;
    const stand = b.evaluate();
    if (ply >= MAX_PLY || stand >= beta) return stand;
    if (stand > alpha) alpha = stand;
    const moves = b.generate(true);
    const scores = this.scoreMoves(moves, 0, Math.min(ply, MAX_PLY - 1));
    for (let i = 0; i < moves.length; i++) {
      Searcher.pickBest(moves, scores, i);
      if (!b.make(moves[i])) continue;
      const s = -this.quiesce(-beta, -alpha, ply + 1);
      b.unmake();
      if (this.stopped) return 0;
      if (s >= beta) return s;
      if (s > alpha) alpha = s;
    }
    return alpha;
  }

  private search(depth: number, alpha: number, beta: number, ply: number, allowNull: boolean): number {
    this.nodes++;
    this.checkTime();
    if (this.stopped) return 0;
    const b = this.b;
    const lo = b.hashLo();
    const hi = b.hashHi();

    if (b.isRuleDraw() || this.isRepetition(lo, hi)) return 0;
    // Cắt tỉa theo khoảng cách chiếu bí
    const mAlpha = Math.max(alpha, -MATE + ply);
    const mBeta = Math.min(beta, MATE - ply - 1);
    if (mAlpha >= mBeta) return mAlpha;

    const inCheck = b.inCheck();
    if (inCheck && ply < this.extLimit) depth++;
    if (depth <= 0) return this.limits.quiescence ? this.quiesce(alpha, beta, ply) : b.evaluate();
    if (ply >= MAX_PLY - 1) return b.evaluate();

    let ttMove = 0;
    const ti = this.tt.probe(lo, hi);
    if (ti >= 0) {
      ttMove = this.tt.move[ti];
      if (this.tt.depth[ti] >= depth) {
        const s = fromTT(this.tt.score[ti], ply);
        const f = this.tt.flag[ti];
        if (f === TT_EXACT || (f === TT_LOWER && s >= beta) || (f === TT_UPPER && s <= alpha)) return s;
      }
    }

    const pvNode = beta - alpha > 1;
    if (allowNull && !pvNode && !inCheck && depth >= 3 && b.canNullMove() && b.evaluate() >= beta) {
      const R = depth >= 6 ? 3 : 2;
      b.makeNull();
      this.push(lo, hi);
      const s = -this.search(depth - 1 - R, -beta, -beta + 1, ply + 1, false);
      this.pop();
      b.unmakeNull();
      if (this.stopped) return 0;
      if (s >= beta) return s >= MATE_BOUND ? beta : s;
    }

    const moves = b.generate(false);
    const scores = this.scoreMoves(moves, ttMove, ply);
    const origAlpha = alpha;
    let best = -INF;
    let bestMove = 0;
    let legal = 0;
    this.push(lo, hi);
    for (let i = 0; i < moves.length; i++) {
      Searcher.pickBest(moves, scores, i);
      const m = moves[i];
      // Nước yên tĩnh không phải killer / nước TT: ứng viên giảm độ sâu (LMR)
      const quiet = scores[i] < 800_000 && b.victimValue(m) === 0;
      if (!b.make(m)) continue;
      legal++;
      let s: number;
      if (legal === 1) {
        s = -this.search(depth - 1, -beta, -alpha, ply + 1, true);
      } else {
        const givesCheck = b.inCheck();
        const reduce = depth >= 3 && legal > 4 && !inCheck && !givesCheck && quiet ? 1 : 0;
        s = -this.search(depth - 1 - reduce, -alpha - 1, -alpha, ply + 1, true);
        if (!this.stopped && s > alpha && reduce) s = -this.search(depth - 1, -alpha - 1, -alpha, ply + 1, true);
        if (!this.stopped && s > alpha && s < beta) s = -this.search(depth - 1, -beta, -alpha, ply + 1, true);
      }
      b.unmake();
      if (this.stopped) {
        this.pop();
        return 0;
      }
      if (s > best) {
        best = s;
        bestMove = m;
        if (s > alpha) {
          alpha = s;
          if (alpha >= beta) {
            if (b.victimValue(m) === 0) {
              if (this.killers[ply * 2] !== m) {
                this.killers[ply * 2 + 1] = this.killers[ply * 2];
                this.killers[ply * 2] = m;
              }
              const hIdx = b.pieceCode(m) * b.squares + b.target(m);
              this.history[hIdx] += depth * depth;
              if (this.history[hIdx] > 700_000) for (let k = 0; k < this.history.length; k++) this.history[k] >>= 1;
            }
            break;
          }
        }
      }
    }
    this.pop();
    if (legal === 0) return b.noMovesScore(ply, MATE);
    const flag = best <= origAlpha ? TT_UPPER : best >= beta ? TT_LOWER : TT_EXACT;
    this.tt.store(lo, hi, depth, flag, toTT(best, ply), bestMove);
    return best;
  }

  /**
   * Chấm điểm TỪNG nước gốc ở đúng độ sâu `depth` (một vòng, không lặp sâu dần) — dùng cho Cờ úp, nơi điểm của mỗi
   * nước được cộng dồn qua nhiều "mẫu" danh tính quân úp.
   * Nước đầu tiên được tìm với cửa sổ đầy đủ; nước sau dùng cửa sổ (tốt nhất − margin, +∞): điểm chính xác nếu lớn hơn
   * (tốt nhất − margin), nếu không thì là cận trên (đủ biết nước đó kém hơn ít nhất `margin`).
   * Trả về null nếu hết giờ (`deadline`, giờ hệ thống ms) giữa chừng. Nên xếp nước tốt của vòng trước lên đầu.
   * Bộ đếm `nodes` không bị đặt lại (cộng dồn qua các lần gọi).
   */
  scoreRootMoves(rootMoves: number[], depth: number, margin: number, deadline: number, quiescence: boolean): Int32Array | null {
    const b = this.b;
    this.limits = { maxDepth: depth, timeMs: null, quiescence };
    this.stopped = false;
    this.deadline = deadline;
    this.extLimit = Math.min(MAX_PLY - 8, depth * 2);
    const lo = b.hashLo();
    const hi = b.hashHi();
    const scores = new Int32Array(rootMoves.length).fill(-INF);
    let best = -INF;
    this.push(lo, hi);
    for (let i = 0; i < rootMoves.length; i++) {
      const m = rootMoves[i];
      if (!b.make(m)) continue;
      const floor = best === -INF ? -INF : Math.max(-INF, best - margin);
      const s = -this.search(depth - 1, -INF, -floor, 1, true);
      b.unmake();
      if (this.stopped) {
        this.pop();
        return null;
      }
      scores[i] = s;
      if (s > best) best = s;
    }
    this.pop();
    return scores;
  }

  /**
   * Tìm nước tốt nhất trong `rootMoves` (đã là nước hợp lệ) bằng iterative deepening.
   */
  searchRoot(rootMoves: number[], limits: SearchLimits): RootResult {
    const b = this.b;
    this.limits = limits;
    this.nodes = 0;
    this.stopped = false;
    const start = Date.now();
    this.deadline = limits.timeMs ? start + limits.timeMs : Infinity;
    this.killers.fill(0);
    if (rootMoves.length === 0) return { move: 0, score: 0, depth: 0, nodes: 0 };

    const lo = b.hashLo();
    const hi = b.hashHi();
    // Thứ tự ban đầu: nước ăn quân giá trị cao trước
    const initScores = this.scoreMoves(rootMoves.slice(), 0, 0);
    const order = rootMoves
      .map((m, i) => ({ m, s: initScores[i] }))
      .sort((a, c) => c.s - a.s)
      .map((x) => x.m);
    let bestMove = order[0];
    let bestScore = 0;
    let completed = 0;
    if (order.length === 1) return { move: bestMove, score: 0, depth: 0, nodes: 0 };

    // Nhiễu gốc (cố định trong suốt lần tìm này để các vòng sâu dần nhất quán)
    const noiseCap = Math.max(0, Math.floor(limits.rootNoiseCp ?? 0));
    const noise = new Map<number, number>();
    if (noiseCap > 0) for (const m of order) noise.set(m, Math.floor(Math.random() * (noiseCap + 1)));
    // Dịch cận theo nhiễu (giữ nguyên cận vô cực)
    const shift = (x: number, n: number) => (x >= INF || x <= -INF ? x : x - n);

    for (let depth = 1; depth <= limits.maxDepth; depth++) {
      this.extLimit = Math.min(MAX_PLY - 8, depth * 2);
      let alpha = -INF;
      const beta = INF;
      let iterBest = 0;
      let iterScore = -INF;
      this.push(lo, hi);
      for (let i = 0; i < order.length; i++) {
        const m = order[i];
        if (!b.make(m)) continue;
        const n = noise.get(m) ?? 0;
        let s: number;
        if (i === 0) {
          s = -this.search(depth - 1, -shift(beta, n), -shift(alpha, n), 1, true) + n;
        } else {
          s = -this.search(depth - 1, -shift(alpha, n) - 1, -shift(alpha, n), 1, true) + n;
          if (!this.stopped && s > alpha) s = -this.search(depth - 1, -shift(beta, n), -shift(alpha, n), 1, true) + n;
        }
        b.unmake();
        if (this.stopped) break;
        if (s > iterScore) {
          iterScore = s;
          iterBest = m;
          if (s > alpha) alpha = s;
        }
      }
      this.pop();
      if (this.stopped) {
        // Vòng dang dở: nước đầu (nước tốt nhất vòng trước) đã được xét đủ, nên nước tốt hơn tìm thấy vẫn dùng được
        if (iterBest && iterScore > -INF) {
          bestMove = iterBest;
          bestScore = iterScore;
        }
        break;
      }
      bestMove = iterBest;
      bestScore = iterScore;
      completed = depth;
      // Đưa nước tốt nhất lên đầu cho vòng sau
      const idx = order.indexOf(bestMove);
      if (idx > 0) {
        order.splice(idx, 1);
        order.unshift(bestMove);
      }
      // Đã thấy chiếu hết: chỉ dừng khi độ sâu đã phủ hết khoảng cách tới chiếu hết (điểm chiếu hết lấy từ bảng chuyển vị
      // của lần tìm trước có thể là đường dài hơn — tìm tiếp để chọn đường ngắn nhất)
      if (Math.abs(bestScore) >= MATE_BOUND && depth >= MATE - Math.abs(bestScore)) break;
      if (limits.timeMs && Date.now() - start > limits.timeMs * 0.45) break;
    }
    return { move: bestMove, score: bestScore, depth: completed, nodes: this.nodes };
  }
}
