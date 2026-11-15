import { describe, expect, it } from 'vitest';
import { ChessBoard, ChessGame, replayGame } from '../src';

function perft(b: ChessBoard, depth: number): number {
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

const PERFT: Array<[string, string, number[]]> = [
  ['thế ban đầu', 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', [20, 400, 8902, 197281]],
  ['kiwipete', 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1', [48, 2039, 97862]],
  ['position 3', '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', [14, 191, 2812, 43238]],
  ['position 4', 'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1', [6, 264, 9467]],
  ['position 5', 'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8', [44, 1486, 62379]],
];

describe('Cờ vua – sinh nước (perft)', () => {
  for (const [name, fen, counts] of PERFT) {
    it(name, () => {
      const b = new ChessBoard(fen);
      counts.forEach((c, i) => expect(perft(b, i + 1)).toBe(c));
      expect(b.fen()).toBe(new ChessBoard(fen).fen());
    });
  }
});

describe('Cờ vua – luật', () => {
  it('chiếu hết (fool’s mate) và SAN', () => {
    const g = replayGame('chess', ['f2f3', 'e7e5', 'g2g4', 'd8h4']);
    expect(g.status()).toEqual({ over: true, result: { winner: 1, reason: 'checkmate' } });
    expect(g.historyInfo().map((i) => i.label)).toEqual(['f3', 'e5', 'g4', 'Qh4#']);
  });

  it('hết nước đi (stalemate) là hoà', () => {
    const g = new ChessGame('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1');
    expect(g.status()).toEqual({ over: true, result: { winner: null, reason: 'stalemate' } });
  });

  it('không đủ quân chiếu hết', () => {
    expect(new ChessGame('8/8/8/4k3/8/8/8/4K3 w - - 0 1').status()).toEqual({
      over: true,
      result: { winner: null, reason: 'insufficient_material' },
    });
    expect(new ChessGame('8/8/8/4k3/8/8/8/2B1K3 w - - 0 1').status().over).toBe(true);
    expect(new ChessGame('8/8/8/4k3/8/8/8/1N2K3 w - - 0 1').status().over).toBe(true);
    // Hai tượng cùng màu ô: hoà; khác màu: còn chơi
    expect(new ChessGame('8/8/8/4k3/8/8/8/2B1KB2 w - - 0 1').status().over).toBe(false);
    // (tượng a3 + c1: không chiếu vua đen — thế bên vừa đi bị chiếu là thế không hợp lệ)
    expect(new ChessGame('8/8/8/4k3/8/B7/8/2B1K3 w - - 0 1').status().over).toBe(true);
    expect(new ChessGame('8/8/8/4k3/8/8/8/R3K3 w - - 0 1').status().over).toBe(false);
  });

  it('lặp thế cờ 3 lần: hoà, cảnh báo ở lần 2', () => {
    const g = new ChessGame();
    const cycle = ['g1f3', 'g8f6', 'f3g1', 'f6g8'];
    for (const m of cycle) g.play(m);
    expect(g.warnings()).toEqual([{ type: 'repetition' }]);
    for (const m of cycle) g.play(m);
    expect(g.status()).toEqual({ over: true, result: { winner: null, reason: 'repetition' } });
  });

  it('luật 50 nước và cảnh báo từ nước thứ 40', () => {
    const warn = new ChessGame('8/8/8/4k3/8/8/8/R3K3 w - - 80 80');
    expect(warn.warnings()).toEqual([{ type: 'fifty_moves', movesLeft: 10 }]);
    const g = new ChessGame('8/8/8/4k3/8/8/8/R3K3 w - - 99 80');
    expect(g.status().over).toBe(false);
    g.play('a1a2');
    expect(g.status()).toEqual({ over: true, result: { winner: null, reason: 'fifty_moves' } });
  });

  it('nhập thành', () => {
    const g = new ChessGame('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
    expect(g.legalMovesFrom('e1')).toEqual(expect.arrayContaining(['e1g1', 'e1c1']));
    g.play('e1g1');
    expect(g.pieceAt('f1')).toEqual({ square: 'f1', color: 0, type: 'r' });
    expect(g.pieceAt('h1')).toBeNull();
    expect(g.historyInfo()[0].label).toBe('O-O');
    // Không nhập thành qua ô bị chiếu
    const g2 = new ChessGame('r3k2r/8/8/8/8/8/5r2/R3K2R w KQkq - 0 1');
    expect(g2.legalMovesFrom('e1')).not.toContain('e1g1');
  });

  it('bắt tốt qua đường', () => {
    const g = new ChessGame('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1');
    expect(g.play('e5d6')).toBe(true);
    expect(g.pieceAt('d5')).toBeNull();
    expect(g.historyInfo()[0].label).toBe('exd6');
  });

  it('FEN thế không thể có bị từ chối', () => {
    const bad = [
      '4k3/8/8/8/8/8/PN6/4K3 w - b3 0 1', // ô bắt tốt qua đường không có tốt vừa đi 2 ô
      '4k3/8/8/3pP3/8/8/8/4K3 w - d5 0 1', // ô bắt tốt qua đường sai hàng (và có quân)
      '4k3/8/8/3pP3/8/8/8/4K3 b - d6 0 1', // bên đi không khớp với ô bắt tốt
      '4k3/8/8/8/8/8/8/4RK2 w - - 0 1', // Đen (bên vừa đi) đang bị chiếu
      '4k2P/8/8/8/8/8/8/4K3 w - - 0 1', // tốt ở hàng 8
      '4k3/8/8/8/8/8/8/p3K3 b - - 0 1', // tốt ở hàng 1
    ];
    for (const f of bad) expect(() => new ChessGame(f), f).toThrow();
    // Ô bắt tốt hợp lệ vẫn đọc được (cả hai bên)
    expect(new ChessGame('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1').legalMovesFrom('e5')).toContain('e5d6');
    expect(new ChessGame('4k3/8/8/8/3Pp3/8/8/4K3 b - d3 0 1').legalMovesFrom('e4')).toContain('e4d3');
  });

  it('phong cấp', () => {
    const g = new ChessGame('4k3/P7/8/8/8/8/8/4K3 w - - 0 1');
    expect(g.isPromotion('a7', 'a8')).toBe(true);
    expect(g.isLegal('a7a8')).toBe(false);
    expect(g.play('a7a8q')).toBe(true);
    expect(g.pieceAt('a8')).toEqual({ square: 'a8', color: 0, type: 'q' });
    expect(g.historyInfo()[0].label).toBe('a8=Q+');
  });

  it('SAN phân biệt quân cùng loại', () => {
    // Cả hai xe a1, h1 đều tới được d1 (vua ở e2 không cản)
    const g = new ChessGame('4k3/8/8/8/8/8/4K3/R6R w - - 0 1');
    g.play('a1d1');
    expect(g.historyInfo()[0].label).toBe('Rad1');
    // Xe h1 bị vua e1 cản nên không cần phân biệt
    const g2 = new ChessGame('4k3/8/8/8/8/8/8/R3K2R w - - 0 1');
    g2.play('a1d1');
    expect(g2.historyInfo()[0].label).toBe('Rd1');
  });
});
