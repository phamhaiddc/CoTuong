import { describe, expect, it } from 'vitest';
import { XiangqiBoard, XiangqiGame, replayGame } from '../src';

function perft(b: XiangqiBoard, depth: number): number {
  if (depth === 0) return 1;
  let n = 0;
  for (const m of b.generateMoves()) {
    if (b.makeMove(m)) {
      n += depth === 1 ? 1 : perft(b, depth - 1);
      b.unmakeMove();
    }
  }
  return n;
}

describe('Cờ tướng – sinh nước (perft)', () => {
  it('thế cờ ban đầu: 44 / 1920 / 79666', () => {
    const b = new XiangqiBoard();
    expect(perft(b, 1)).toBe(44);
    expect(perft(b, 2)).toBe(1920);
    expect(perft(b, 3)).toBe(79666);
  });

  it('make/unmake giữ nguyên hash và FEN', () => {
    const b = new XiangqiBoard();
    const fen = b.fen();
    const lo = b.hashLo;
    const hi = b.hashHi;
    perft(b, 3);
    expect(b.fen()).toBe(fen);
    expect(b.hashLo).toBe(lo);
    expect(b.hashHi).toBe(hi);
  });
});

describe('Cờ tướng – luật quân', () => {
  it('mã bị cản chân, tượng bị cản mắt (thế ban đầu)', () => {
    const g = new XiangqiGame();
    expect(g.legalMovesFrom('b0').sort()).toEqual(['b0a2', 'b0c2']);
    expect(g.legalMovesFrom('c0').sort()).toEqual(['c0a2', 'c0e2']);
  });

  it('pháo ăn quân phải có đúng một ngòi', () => {
    const g = new XiangqiGame();
    const moves = g.legalMovesFrom('h2');
    expect(moves).toContain('h2h9'); // ăn mã qua ngòi pháo đen h7
    expect(moves).not.toContain('h2h7'); // không ăn trực tiếp
    expect(moves).not.toContain('h2h8');
  });

  it('tốt chưa qua sông chỉ đi thẳng, qua sông được đi ngang', () => {
    const g = new XiangqiGame('4k4/9/9/9/4P4/9/4P4/9/9/3K5 w - - 0 1');
    expect(g.legalMovesFrom('e3')).toEqual(['e3e4']);
    expect(g.legalMovesFrom('e5').sort()).toEqual(['e5d5', 'e5e6', 'e5f5']);
  });

  it('không được để lộ mặt tướng', () => {
    const g = new XiangqiGame('4k4/9/9/9/9/4H4/9/9/9/4K4 w - - 0 1');
    expect(g.legalMovesFrom('e4')).toEqual([]);
    expect(g.legalMoves().sort()).toEqual(['e0d0', 'e0e1', 'e0f0']);
  });

  it('FEN thế không thể có bị từ chối', () => {
    const bad = [
      '3k5/9/9/9/9/9/9/9/9/3RK4 w - - 0 1', // Đen (bên vừa đi) đang bị Xe chiếu
      '4k4/9/9/9/9/9/9/9/9/4K4 w - - 0 1', // lộ mặt tướng khi Đỏ được đi
      '9/9/9/9/3k5/9/9/9/9/4K4 w - - 0 1', // tướng Đen ngoài cung
      '4k4/9/9/9/9/9/9/9/9/A3K4 w - - 0 1', // sĩ ở a0
      '4k4/9/9/9/9/4B4/9/9/9/4K4 w - - 0 1', // tượng ở e4 (không phải điểm tượng)
      '4k4/9/9/9/9/9/9/9/P8/3K5 w - - 0 1', // tốt Đỏ lùi sau hàng tốt
      '3k1p3/9/9/9/9/9/9/9/9/4K4 w - - 0 1', // tốt Đen lùi sau hàng tốt
    ];
    for (const f of bad) expect(() => new XiangqiGame(f), f).toThrow();
    // Thế hợp lệ: bên ĐƯỢC đi đang bị chiếu thì vẫn đọc được
    expect(new XiangqiGame('3k5/9/9/9/9/9/9/9/9/3RK4 b - - 0 1').inCheck()).toBe(true);
  });

  it('nước không hợp lệ bị từ chối', () => {
    const g = new XiangqiGame();
    expect(g.play('a0a5')).toBe(false);
    expect(g.play('xyz')).toBe(false);
    expect(g.play('h2e2')).toBe(true);
    expect(g.turn()).toBe(1);
  });
});

describe('Cờ tướng – kết thúc ván', () => {
  it('hết nước đi (không bị chiếu) thì bên phải đi thua', () => {
    const g = new XiangqiGame('4k4/9/4P4/9/3R1R3/9/9/9/9/4K4 b - - 0 1');
    expect(g.inCheck()).toBe(false);
    expect(g.status()).toEqual({ over: true, result: { winner: 0, reason: 'stalemate' } });
  });

  it('chiếu bí', () => {
    // Xe b8 khoá hàng 8, tướng đỏ e0 khống chế cột e, xe a0 lên a9 chiếu bí
    const g = new XiangqiGame('3k5/1R7/9/9/9/9/9/9/9/R3K4 w - - 0 1');
    expect(g.status().over).toBe(false);
    expect(g.play('a0a9')).toBe(true);
    expect(g.inCheck()).toBe(true);
    expect(g.status()).toEqual({ over: true, result: { winner: 0, reason: 'checkmate' } });
    expect(g.historyInfo()[0].label).toBe('X9.9');
  });

  it('tướng không được đi vào cột đối mặt tướng địch', () => {
    const g = new XiangqiGame('3k5/9/9/9/9/9/9/9/9/4K4 b - - 0 1');
    expect(g.legalMovesFrom('d9').sort()).toEqual(['d9d8']);
  });

  it('chiếu dai làm lặp thế cờ 3 lần: bên chiếu bị xử thua, có cảnh báo trước', () => {
    const g = new XiangqiGame('4k4/9/9/9/9/9/9/9/9/R2K5 w - - 0 1');
    const cycle = ['a0a9', 'e9e8', 'a9a8', 'e8e9', 'a8a9', 'e9e8', 'a9a8', 'e8e9'];
    for (const m of cycle) {
      expect(g.play(m)).toBe(true);
      expect(g.status().over).toBe(false);
    }
    // Lần lặp 2 đã có cảnh báo ở các thế trước; nước tiếp theo tạo lần lặp thứ 3
    expect(g.isPerpetualCheckLoss('a8a9')).toBe(true);
    expect(g.isPerpetualCheckLoss('a8a7')).toBe(false);
    expect(g.play('a8a9')).toBe(true);
    expect(g.status()).toEqual({ over: true, result: { winner: 1, reason: 'perpetual_check' } });
  });

  it('cảnh báo khi thế cờ lặp lần 2', () => {
    const g = new XiangqiGame('4k4/9/9/9/9/9/9/9/9/R2K5 w - - 0 1');
    for (const m of ['a0a9', 'e9e8', 'a9a8', 'e8e9']) g.play(m);
    expect(g.warnings()).toEqual([]);
    g.play('a8a9');
    expect(g.warnings()).toEqual([{ type: 'repetition' }]);
  });

  it('lặp thế cờ 3 lần không do chiếu: hoà', () => {
    const shuffle = ['b0a2', 'b9a7', 'a2b0', 'a7b9'];
    const g = replayGame('xiangqi', [...shuffle, ...shuffle]);
    expect(g.status()).toEqual({ over: true, result: { winner: null, reason: 'repetition' } });
    expect(g.play('h2e2')).toBe(false);
  });

  it('undo khôi phục trạng thái', () => {
    const g = new XiangqiGame();
    const fen = g.fen();
    g.play('h2e2');
    g.play('h9g7');
    expect(g.undo()).toBe('h9g7');
    expect(g.undo()).toBe('h2e2');
    expect(g.fen()).toBe(fen);
    expect(g.history()).toEqual([]);
  });

  it('clone độc lập', () => {
    const g = new XiangqiGame();
    g.play('h2e2');
    const c = g.clone();
    c.play('h9g7');
    expect(g.history()).toEqual(['h2e2']);
    expect(c.history()).toEqual(['h2e2', 'h9g7']);
  });

  it('nhãn nước đi (ký hiệu Việt Nam, xem notation.test.ts)', () => {
    const g = new XiangqiGame();
    g.play('h2e2');
    expect(g.historyInfo()[0].label).toBe('P2-5');
  });
});
