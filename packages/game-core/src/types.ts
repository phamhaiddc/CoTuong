export type GameType = 'xiangqi' | 'chess';

/**
 * 0 = bên đi trước (Đỏ trong Cờ tướng, Trắng trong Cờ vua); 1 = Đen.
 */
export type Color = 0 | 1;

export type EndReason =
  /** Chiếu bí */
  | 'checkmate'
  /** Hết nước đi hợp lệ. Cờ vua: hoà. Cờ tướng: bên hết nước bị xử thua. */
  | 'stalemate'
  /** Cờ tướng: bên chiếu liên tục làm lặp thế cờ 3 lần bị xử thua */
  | 'perpetual_check'
  /** Lặp thế cờ 3 lần (không phải chiếu dai): hoà */
  | 'repetition'
  /** Cờ vua: không đủ quân chiếu hết */
  | 'insufficient_material'
  /** Cờ vua: 50 nước mỗi bên không ăn quân và không đi tốt */
  | 'fifty_moves'
  | 'resign'
  | 'timeout'
  /** Hoà theo thoả thuận */
  | 'agreement'
  /** Không đi nước đầu tiên trong 30 giây (ván xếp hạng) */
  | 'no_first_move'
  /** Mất kết nối quá 60 giây */
  | 'disconnect';

export interface GameResult {
  /** null = hoà */
  winner: Color | null;
  reason: EndReason;
}

export type GameStatus = { over: false } | { over: true; result: GameResult };

export type GameWarning =
  /** Thế cờ hiện tại đã xuất hiện lần thứ 2 */
  | { type: 'repetition' }
  /** Cờ vua: đã >= 40 nước (mỗi bên) không ăn quân / đi tốt */
  | { type: 'fifty_moves'; movesLeft: number };

export interface BoardPiece {
  square: string;
  color: Color;
  /**
   * Cờ tướng: k (tướng), a (sĩ), e (tượng), h (mã), r (xe), c (pháo), p (tốt)
   * Cờ vua: k, q, r, b, n, p
   *
   * Cờ úp, quân đang úp (`hidden: true`): đây là loại quân GỐC của ô quân đứng (quân úp đi nước đầu
   * theo loại này), KHÔNG phải danh tính thật — danh tính thật là bí mật cho tới khi lật.
   */
  type: string;
  /** Cờ úp: quân đang úp (chưa lật). Không có / false với mọi quân khác. */
  hidden?: boolean;
}

/**
 * Cờ úp: thông tin lật quân của một nửa nước (công khai cho cả hai bên).
 * Ký hiệu loại quân như cờ tướng của game-core (chữ thường): r h e a c p.
 */
export interface JieqiReveal {
  /** Loại thật của quân vừa đi, nếu trước nước này nó đang úp (nay đã lật) */
  piece?: string;
  /** Loại thật của quân úp bị ăn ở nước này (quân úp bị ăn được lật cho cả hai bên xem) */
  captured?: string;
}

export interface MoveInfo {
  /** Chuỗi nước đi: UCI (cờ vua) hoặc ICCS (cờ tướng), ví dụ "e2e4", "h2e2" */
  move: string;
  from: string;
  to: string;
  /** Nhãn hiển thị trong danh sách nước đi (SAN cho cờ vua) */
  label: string;
  captured: boolean;
  /** Nước này chiếu tướng/vua đối phương */
  check: boolean;
  /** Cờ úp: quân được lật ở nước này (không có nếu nước đi không dính tới quân úp) */
  reveal?: JieqiReveal;
}

/**
 * Bộ luật dùng chung cho trình duyệt (gợi ý nước hợp lệ, AI) và server (quyết định kết quả).
 * Mọi nước đi trao đổi dưới dạng chuỗi toạ độ: UCI (cờ vua), ICCS (cờ tướng).
 */
export interface GameEngine {
  readonly game: GameType;
  /** Số cột / hàng của bàn cờ (giao điểm với cờ tướng) */
  readonly files: number;
  readonly ranks: number;
  turn(): Color;
  fen(): string;
  startFen(): string;
  /** Danh sách nước đã đi (UCI / ICCS) */
  history(): string[];
  /** Thông tin từng nước đã đi (nhãn hiển thị, ăn quân, chiếu) */
  historyInfo(): MoveInfo[];
  legalMoves(): string[];
  legalMovesFrom(square: string): string[];
  isLegal(move: string): boolean;
  /** Đi một nước; trả về false nếu không hợp lệ hoặc ván đã kết thúc */
  play(move: string): boolean;
  /** Huỷ nước cuối (dùng cho AI / phân tích; giao diện không có chức năng đi lại) */
  undo(): string | null;
  inCheck(): boolean;
  status(): GameStatus;
  warnings(): GameWarning[];
  /** Cờ tướng: nước này tạo lần lặp thứ 3 do chiếu dai và khiến bên đi bị xử thua. Cờ vua: luôn false. */
  isPerpetualCheckLoss(move: string): boolean;
  pieces(): BoardPiece[];
  pieceAt(square: string): BoardPiece | null;
  /** Ô của tướng/vua bên `color` (null nếu không có) */
  kingSquare(color: Color): string | null;
  /** Nước này có phải nước phong cấp (cờ vua) cần chọn quân không */
  isPromotion(from: string, to: string): boolean;
  clone(): GameEngine;
}

export const otherColor = (c: Color): Color => (c === 0 ? 1 : 0);
