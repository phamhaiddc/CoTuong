import { JIEQI_START_FEN, JieqiGame, jq, xqParseMove } from '@cotuong/game-core';
import { JieqiSearchBoard } from './adapters';
import { hiddenExpectedValue } from './eval-jieqi';
import { MATE, Searcher, type TranspositionTable } from './search';
import type { AiLevel, AiRequest, AiResponse, LevelConfig } from './engine';
import { allowsPerpetualClaim } from './perpetual';

/**
 * AI Cờ úp — CHỈ dùng thông tin công khai (danh sách nước + thông tin lật quân đã công bố).
 *
 * Cách làm ("determinization" / Perfect Information Monte Carlo):
 *  1. Dựng lại thế cờ ở chế độ công khai (replay nước đi + lật quân), lấy kho quân chưa lộ của mỗi bên.
 *  2. Bốc thăm K "mẫu": mỗi mẫu xếp ngẫu nhiên kho quân chưa lộ của mỗi bên vào các ô đang có quân úp của bên đó
 *     (phân bố đều — vì không ai, kể cả chủ quân, biết quân úp là gì nên mọi cách xếp khớp kho đều như nhau).
 *  3. Với mỗi mẫu, tìm kiếm alpha-beta như ván biết đủ và chấm điểm MỌI nước gốc ở cùng một độ sâu
 *     (lặp sâu dần, xen kẽ giữa các mẫu, theo giới hạn thời gian).
 *  4. Chọn nước có điểm trung bình qua các mẫu cao nhất (điểm chiếu bí được nén để một mẫu không lấn át cả trung bình).
 * Quân úp được đánh giá bằng giá trị kỳ vọng của kho (eval-jieqi), không theo danh tính của mẫu.
 * Không có đường nào để truyền chuỗi xếp quân (bí mật) vào AI.
 */

export interface JieqiLevelConfig extends LevelConfig {
  /** Số mẫu danh tính quân úp */
  samples: number;
}

/**
 * Mức độ Cờ úp, tương ứng Dễ / Trung bình / Khó của cờ tướng nhưng luôn có giới hạn thời gian
 * (tổng cho mọi mẫu) để Web Worker trả lời kịp:
 *  - Dễ: độ sâu 1, 30% nước ngẫu nhiên, 4 mẫu.
 *  - Trung bình: độ sâu 3 (tối đa 2,5 giây), 6 mẫu.
 *  - Khó: tối đa 3 giây, 8 mẫu.
 * Các con số là điểm khởi đầu, chưa tinh chỉnh độ mạnh.
 */
export const JIEQI_LEVEL_CONFIG: Record<AiLevel, JieqiLevelConfig> = {
  easy: { maxDepth: 1, timeMs: 1500, quiescence: false, randomness: 0.3, samples: 4 },
  medium: { maxDepth: 3, timeMs: 2500, quiescence: true, randomness: 0, samples: 6 },
  hard: { maxDepth: 40, timeMs: 3000, quiescence: true, randomness: 0, samples: 8 },
};

/** Nước kém hơn nước tốt nhất của mẫu quá mức này chỉ cần cận trên (không cần điểm chính xác) */
const MARGIN = 200;
const MATE_BOUND = MATE - 1_000;

/** Nén điểm chiếu bí về khoảng ±4000..5000 (giữ thứ tự: chiếu bí nhanh hơn thì cao hơn) trước khi cộng dồn */
function aggregateScore(s: number): number {
  if (s >= MATE_BOUND) return 4_000 + (s - MATE_BOUND);
  if (s <= -MATE_BOUND) return -4_000 - (-s - MATE_BOUND);
  return s;
}

/** Bộ sinh số [0, 1) có seed (mulberry32) — để dùng được qua Web Worker (không truyền được hàm) */
export function seededRandom01(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomIndex(rnd: () => number, n: number): number {
  const x = rnd();
  const v = Math.floor((Number.isFinite(x) ? x : 0) * n);
  return v < 0 ? 0 : v >= n ? n - 1 : v;
}

/**
 * Gán cho mỗi quân úp trên `b` một danh tính bốc thăm đều từ kho quân chưa lộ (công khai) của bên đó.
 * Ghi đè `b.secret` ở mọi ô có quân úp.
 */
export function sampleHiddenIdentities(b: jq.JieqiBoard, rnd: () => number): void {
  for (const color of [0, 1] as const) {
    const squares = b.hiddenSquares(color);
    const bag: number[] = [];
    for (const t of jq.JQ_HIDDEN_TYPES) for (let k = 0; k < b.pool[color * 8 + t]; k++) bag.push(t);
    if (bag.length !== squares.length) throw new Error('Cờ úp: kho quân chưa lộ không khớp số quân úp');
    for (let i = bag.length - 1; i > 0; i--) {
      const j = randomIndex(rnd, i + 1);
      const t = bag[i];
      bag[i] = bag[j];
      bag[j] = t;
    }
    for (let i = 0; i < squares.length; i++) b.secret[squares[i]] = bag[i];
  }
}

export function findBestMoveJieqi(req: AiRequest, tt: TranspositionTable): AiResponse {
  const t0 = Date.now();
  const empty: AiResponse = { move: null, score: 0, depth: 0, nodes: 0, timeMs: 0, random: false };
  if (req.game !== 'xiangqi') throw new Error('Cờ úp chỉ dùng với game "xiangqi"');
  const reveals = req.reveals ?? [];
  if (reveals.length > req.moves.length) throw new Error('Cờ úp: số thông tin lật quân nhiều hơn số nước đi');

  // Dựng lại ván CHỈ bằng thông tin công khai, đồng thời ghi băm các thế trước để phát hiện lặp trong lúc tìm
  const game = new JieqiGame({ fen: req.startFen ?? JIEQI_START_FEN });
  const hashes: Array<[number, number]> = [];
  for (let i = 0; i < req.moves.length; i++) {
    hashes.push([game.board.hashLo, game.board.hashHi]);
    if (!game.play(req.moves[i], reveals[i] ?? null)) {
      throw new Error(`Nước thứ ${i + 1} không hợp lệ hoặc thông tin lật quân sai: ${req.moves[i]}`);
    }
  }
  if (game.status().over) return empty;
  let legal = game.legalMoves();
  if (legal.length === 0) return empty;
  // Tránh nước khiến máy bị xử thua vì chiếu dai (nếu còn nước khác)
  // (kể cả nước chiếu để đối thủ đáp một nước là đủ lặp thế — máy là bên chiếu liên tục nên máy thua)
  const safe = legal.filter((m) => !game.isPerpetualCheckLoss(m) && !allowsPerpetualClaim(game, m));
  if (safe.length) legal = safe;

  const cfg: JieqiLevelConfig = { ...JIEQI_LEVEL_CONFIG[req.level ?? 'medium'], ...req.config } as JieqiLevelConfig;
  const rnd = req.random ?? (req.seed !== undefined ? seededRandom01(req.seed) : Math.random);
  if (cfg.randomness > 0 && rnd() < cfg.randomness) {
    return { ...empty, move: legal[randomIndex(rnd, legal.length)], timeMs: Date.now() - t0, random: true };
  }
  if (legal.length === 1) return { ...empty, move: legal[0], timeMs: Date.now() - t0 };

  const root = game.board;
  const rootMoves = legal.map(xqParseMove);
  const hidden: [number, number] = [hiddenExpectedValue(root, 0), hiddenExpectedValue(root, 1)];
  const K = Math.max(1, Math.min(32, Math.floor(Number(cfg.samples) || JIEQI_LEVEL_CONFIG.medium.samples)));
  const samples: Array<{ searcher: Searcher; order: number[] }> = [];
  for (let k = 0; k < K; k++) {
    const b = root.copy();
    sampleHiddenIdentities(b, rnd);
    const saltLo = (rnd() * 4294967296) | 0;
    const saltHi = (rnd() * 4294967296) | 0;
    const board = new JieqiSearchBoard(b, saltLo, saltHi, hidden);
    const prev = hashes.map(([lo, hi]) => [lo ^ saltLo, hi ^ saltHi] as [number, number]);
    samples.push({ searcher: new Searcher(board, tt, prev), order: rootMoves.map((_, i) => i) });
  }

  const deadline = cfg.timeMs ? t0 + cfg.timeMs : Infinity;
  const maxDepth = Math.max(1, cfg.maxDepth);
  /** done[k][i] = điểm của rootMoves[i] trong mẫu k ở độ sâu đã xong gần nhất (mọi mẫu cùng độ sâu) */
  let done: Int32Array[] = [];
  let depthDone = 0;
  for (let depth = 1; depth <= maxDepth; depth++) {
    const iter: Int32Array[] = [];
    let stopped = false;
    for (const s of samples) {
      const moves = s.order.map((i) => rootMoves[i]);
      // Độ sâu 1 luôn chạy hết để chắc chắn có kết quả
      const res = s.searcher.scoreRootMoves(moves, depth, MARGIN, depth === 1 ? Infinity : deadline, cfg.quiescence);
      if (!res) {
        stopped = true;
        break;
      }
      const byIndex = new Int32Array(rootMoves.length);
      s.order.forEach((i, k) => (byIndex[i] = res[k]));
      iter.push(byIndex);
      s.order.sort((a, c) => byIndex[c] - byIndex[a]);
    }
    if (stopped) break;
    done = iter;
    depthDone = depth;
    // Mọi mẫu đều thấy chiếu bí ở nước tốt nhất: tìm sâu hơn không đổi kết quả
    if (iter.every((sc) => Math.abs(Math.max(...sc)) >= MATE_BOUND)) break;
    if (cfg.timeMs && Date.now() - t0 > cfg.timeMs * 0.45) break;
  }

  const total = new Float64Array(rootMoves.length);
  for (const sc of done) for (let i = 0; i < sc.length; i++) total[i] += aggregateScore(sc[i]);
  let best = 0;
  for (let i = 1; i < total.length; i++) if (total[i] > total[best]) best = i;
  let nodes = 0;
  for (const s of samples) nodes += s.searcher.nodes;
  return {
    move: legal[best],
    score: Math.round(total[best] / Math.max(1, done.length)),
    depth: depthDone,
    nodes,
    timeMs: Date.now() - t0,
    random: false,
    samples: K,
  };
}
