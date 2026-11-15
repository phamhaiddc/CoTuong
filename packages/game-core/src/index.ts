import type { GameEngine, GameType } from './types';
import { XiangqiGame } from './xiangqi/game';
import { XIANGQI_START_FEN } from './xiangqi/board';
import { ChessGame } from './chess/game';
import { CHESS_START_FEN } from './chess/board';

export * from './types';
export * as xq from './xiangqi/board';
export * as cb from './chess/board';
export { XiangqiBoard, XIANGQI_START_FEN } from './xiangqi/board';
export { XiangqiGame, xqMoveToString, xqParseMove, xqSquareName, xqParseSquare, XQ_TYPE_NAME_VI } from './xiangqi/game';
// Ký hiệu nước đi cờ tướng kiểu Việt Nam ("P2-5", "M8.7", "Xt.1") — nhãn hiển thị của historyInfo()
export { xqMoveNotationVi, xqFileNumberVi, XQ_TYPE_ABBR_VI } from './xiangqi/notation';
export { ChessBoard, CHESS_START_FEN, chessSquareName, chessParseSquare } from './chess/board';
export { ChessGame, chessMoveToString, FIFTY_MOVE_WARNING_HALFMOVES } from './chess/game';
// Cờ úp (Jieqi): `jq` = bàn cờ mức thấp cho AI; JieqiGame / createJieqiGame / replayJieqi(Public) cho server & giao diện
export * as jq from './jieqi/board';
export {
  JieqiBoard,
  JIEQI_START_FEN,
  JIEQI_SETUP_SQUARES,
  JIEQI_STANDARD_SETUP,
  JieqiGame,
  createJieqiGame,
  replayJieqi,
  replayJieqiPublic,
  randomJieqiSetup,
  validateJieqiSetup,
  isValidJieqiSetup,
  parseJieqiSetup,
} from './jieqi';
export type { JieqiGameOptions, JieqiKnowledge, JieqiPieceLetter, JieqiPool, JieqiPublicRecord } from './jieqi';

export function createGame(game: GameType, fen?: string): GameEngine {
  if (game === 'xiangqi') return new XiangqiGame(fen);
  if (game === 'chess') return new ChessGame(fen);
  throw new Error(`Loại game không hợp lệ: ${String(game)}`);
}

export function startFenOf(game: GameType): string {
  return game === 'xiangqi' ? XIANGQI_START_FEN : CHESS_START_FEN;
}

/**
 * Dựng lại ván từ danh sách nước. Ném lỗi nếu có nước không hợp lệ.
 */
export function replayGame(game: GameType, moves: readonly string[], fen?: string): GameEngine {
  const g = createGame(game, fen);
  for (let i = 0; i < moves.length; i++) {
    if (!g.play(moves[i])) throw new Error(`Nước thứ ${i + 1} không hợp lệ: ${moves[i]}`);
  }
  return g;
}

export function isGameType(v: unknown): v is GameType {
  return v === 'xiangqi' || v === 'chess';
}
