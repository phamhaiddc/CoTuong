import {
  ChessBoard,
  XiangqiBoard,
  chessMoveToString,
  replayGame,
  startFenOf,
  xqParseMove,
  type GameType,
} from '@cotuong/game-core';
import { ChessSearchBoard, XiangqiSearchBoard, type SearchBoard } from './adapters';
import { findBestMoveJieqi } from './jieqi';
import { allowsPerpetualClaim } from './perpetual';
import { Searcher, TranspositionTable, type SearchLimits } from './search';

export type AiLevel = 'easy' | 'medium' | 'hard';

export interface LevelConfig extends SearchLimits {
  /** Tỉ lệ đi nước ngẫu nhiên (0..1) */
  randomness: number;
}

/**
 * Thông số khởi điểm theo đặc tả (chỉnh lại khi test):
 * Dễ – độ sâu 1, 30% nước ngẫu nhiên; Trung bình – độ sâu 3; Khó – tối đa 3 giây mỗi nước.
 */
export const AI_LEVEL_CONFIG: Record<AiLevel, LevelConfig> = {
  easy: { maxDepth: 1, timeMs: null, quiescence: false, randomness: 0.3 },
  medium: { maxDepth: 3, timeMs: null, quiescence: true, randomness: 0 },
  hard: { maxDepth: 40, timeMs: 3000, quiescence: true, randomness: 0 },
};

/** Cấu hình cho chức năng "Gợi ý nước đi" */
export const HINT_CONFIG: LevelConfig = { maxDepth: 40, timeMs: 1500, quiescence: true, randomness: 0 };

export interface AiRequest {
  game: GameType;
  /** Thế bắt đầu ván; mặc định thế ban đầu chuẩn */
  startFen?: string;
  /** Các nước đã đi từ startFen */
  moves: string[];
  level?: AiLevel;
  /** Ghi đè cấu hình mức độ */
  config?: Partial<LevelConfig>;
  /** Hàm ngẫu nhiên (để test); mặc định Math.random */
  random?: () => number;
  /** Biến thể: 'jieqi' = Cờ úp (game phải là 'xiangqi'); mặc định cờ thường */
  variant?: 'standard' | 'jieqi';
  /**
   * Cờ úp: thông tin lật quân CÔNG KHAI của từng nước (cùng độ dài với moves; null nếu nước đó không dính quân úp).
   * AI không bao giờ nhận chuỗi xếp quân bí mật.
   */
  reveals?: Array<import('@cotuong/game-core').JieqiReveal | null>;
  /** Seed cho bộ sinh số ngẫu nhiên (dùng qua Web Worker, vì không truyền được hàm) */
  seed?: number;
}

export interface AiResponse {
  move: string | null;
  /** Điểm theo góc nhìn bên được đi (centipawn; |score| gần MATE = chiếu bí) */
  score: number;
  depth: number;
  nodes: number;
  timeMs: number;
  /** Nước được chọn ngẫu nhiên (mức Dễ) */
  random: boolean;
  /** Cờ úp: số mẫu danh tính quân úp đã dùng */
  samples?: number;
}

let sharedTT: TranspositionTable | null = null;

function getTT(): TranspositionTable {
  if (!sharedTT) sharedTT = new TranspositionTable(19);
  return sharedTT;
}

/** Xoá bảng chuyển vị (khi bắt đầu ván mới) */
export function resetAi(): void {
  sharedTT?.clear();
}

export function findBestMove(req: AiRequest): AiResponse {
  if (req.variant === 'jieqi') return findBestMoveJieqi(req, getTT());
  const t0 = Date.now();
  const startFen = req.startFen ?? startFenOf(req.game);
  const engine = replayGame(req.game, req.moves, startFen);
  // Danh sách nước dạng CHUẨN của bộ luật (bộ luật đọc được "E2E4", " e2e4", "h2-e2"…): bàn cờ mức thấp bên dưới
  // dựng lại từ danh sách này, nên AI và bộ luật không bao giờ hiểu khác nhau một nước đi
  const history = engine.history();
  const empty: AiResponse = { move: null, score: 0, depth: 0, nodes: 0, timeMs: 0, random: false };
  if (engine.status().over) return empty;

  let legal = engine.legalMoves();
  if (legal.length === 0) return empty;
  // Cờ tướng: tránh nước khiến máy bị xử thua vì chiếu dai — cả khi chính nước đó lặp thế lần 3, lẫn khi nước chiếu
  // này để đối thủ đáp một nước là đủ lặp thế (máy là bên chiếu liên tục → máy thua) (nếu còn nước khác)
  if (req.game === 'xiangqi') {
    const safe = legal.filter((m) => !engine.isPerpetualCheckLoss(m) && !allowsPerpetualClaim(engine, m));
    if (safe.length) legal = safe;
  }

  const cfg: LevelConfig = { ...AI_LEVEL_CONFIG[req.level ?? 'medium'], ...req.config };
  const rnd = req.random ?? Math.random;
  if (cfg.randomness > 0 && rnd() < cfg.randomness) {
    const move = legal[Math.floor(rnd() * legal.length)];
    return { ...empty, move, timeMs: Date.now() - t0, random: true };
  }

  // Dựng bàn cờ mức thấp và lịch sử hash để phát hiện lặp trong lúc tìm
  let board: SearchBoard;
  const hashes: Array<[number, number]> = [];
  let rootMoves: number[];
  if (req.game === 'xiangqi') {
    const b = new XiangqiBoard(startFen);
    let sinceCapture = 0;
    for (const mv of history) {
      hashes.push([b.hashLo, b.hashHi]);
      const m = xqParseMove(mv);
      const capture = b.sq[m >> 7] !== 0;
      b.makeMove(m);
      sinceCapture = capture ? 0 : sinceCapture + 1;
    }
    board = new XiangqiSearchBoard(b, sinceCapture);
    rootMoves = legal.map((m) => xqParseMove(m));
  } else {
    const b = new ChessBoard(startFen);
    for (const mv of history) {
      hashes.push([b.hashLo, b.hashHi]);
      const m = b.legalMoves().find((x) => chessMoveToString(x) === mv);
      if (m === undefined) throw new Error(`Nước không hợp lệ: ${mv}`);
      b.makeMove(m);
    }
    board = new ChessSearchBoard(b);
    const byString = new Map(b.legalMoves().map((m) => [chessMoveToString(m), m]));
    rootMoves = [];
    const kept: string[] = [];
    for (const s of legal) {
      const m = byString.get(s);
      if (m !== undefined) {
        rootMoves.push(m);
        kept.push(s);
      }
    }
    legal = kept;
  }

  const searcher = new Searcher(board, getTT(), hashes);
  // Giới hạn thời gian tính từ lúc nhận yêu cầu (t0): phần dựng lại ván + lọc nước chiếu dai ở trên cũng nằm trong
  // timeMs, không cộng thêm vào thời gian nghĩ (ván rất dài không làm máy nghĩ lâu hơn hạn được giao)
  const limits: LevelConfig = cfg.timeMs ? { ...cfg, timeMs: Math.max(1, cfg.timeMs - (Date.now() - t0)) } : cfg;
  const res = searcher.searchRoot(rootMoves, limits);
  const moveStr = legal[rootMoves.indexOf(res.move)] ?? legal[0];
  return {
    move: moveStr,
    score: res.score,
    depth: res.depth,
    nodes: res.nodes,
    timeMs: Date.now() - t0,
    random: false,
  };
}
