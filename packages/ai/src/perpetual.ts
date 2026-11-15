import type { GameEngine } from '@cotuong/game-core';

/**
 * Nước `m` là nước chiếu và đối thủ có nước đáp khiến ván kết thúc "chiếu dai" với bên đi `m` là bên thua?
 * (Lặp thế lần 3 thường do nước đáp của đối thủ tạo ra — chỉ chặn nước tự lặp lần 3 là chưa đủ.)
 * Dùng cho cờ tướng và cờ úp (engine công khai). Chỉ xét nước chiếu nên tốn ít.
 *
 * Đi thử ngay trên `engine` rồi huỷ lại (engine trở về đúng thế cũ khi hàm trả về). Không dùng clone(): clone dựng
 * lại cả ván từ đầu, gọi cho mọi nước gốc thì ván dài vài trăm nước tốn hàng giây.
 */
export function allowsPerpetualClaim(engine: GameEngine, m: string): boolean {
  const me = engine.turn();
  if (!engine.play(m)) return false;
  try {
    if (!engine.inCheck()) return false;
    for (const r of engine.legalMoves()) {
      if (!engine.play(r)) continue;
      const st = engine.status();
      engine.undo();
      if (st.over && st.result.reason === 'perpetual_check' && st.result.winner !== me) return true;
    }
    return false;
  } finally {
    engine.undo();
  }
}
