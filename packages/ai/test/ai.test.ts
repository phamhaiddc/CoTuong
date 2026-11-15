import { describe, expect, it } from 'vitest';
import { ChessBoard, chessMoveToString, replayGame } from '@cotuong/game-core';
import { MATE, Searcher, TranspositionTable, findBestMove, handleAiRequest } from '../src';
import { ChessSearchBoard } from '../src/adapters';
import { allowsPerpetualClaim } from '../src/perpetual';

describe('AI cờ vua', () => {
  it('tìm được nước chiếu hết 1 nước', () => {
    const r = findBestMove({ game: 'chess', startFen: '6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1', moves: [], level: 'medium' });
    expect(r.move).toBe('d1d8');
    expect(r.score).toBeGreaterThan(MATE - 100);
  });

  it('ăn hậu bị bỏ không', () => {
    const r = findBestMove({ game: 'chess', startFen: '4k3/8/8/3q4/8/8/8/3RK3 w - - 0 1', moves: [], level: 'medium' });
    expect(r.move).toBe('d1d5');
  });

  it('đi nước hợp lệ từ thế ban đầu', () => {
    const r = findBestMove({ game: 'chess', moves: ['e2e4'], level: 'medium' });
    const g = replayGame('chess', ['e2e4']);
    expect(g.isLegal(r.move!)).toBe(true);
  });
});

describe('AI cờ tướng', () => {
  it('tìm được nước chiếu bí 1 nước', () => {
    const r = findBestMove({ game: 'xiangqi', startFen: '3k5/1R7/9/9/9/9/9/9/9/R3K4 w - - 0 1', moves: [], level: 'medium' });
    expect(r.move).toBe('a0a9');
    expect(r.score).toBeGreaterThan(MATE - 100);
  });

  it('không đi nước bị xử thua vì chiếu dai', () => {
    const moves = ['a0a9', 'e9e8', 'a9a8', 'e8e9', 'a8a9', 'e9e8', 'a9a8', 'e8e9'];
    const r = findBestMove({ game: 'xiangqi', startFen: '4k4/9/9/9/9/9/9/9/9/R2K5 w - - 0 1', moves, level: 'medium' });
    expect(r.move).not.toBeNull();
    expect(r.move).not.toBe('a8a9');
  });

  it('mức Dễ: 30% nước ngẫu nhiên', () => {
    const random = findBestMove({ game: 'xiangqi', moves: [], level: 'easy', random: () => 0.1 });
    expect(random.random).toBe(true);
    const searched = findBestMove({ game: 'xiangqi', moves: [], level: 'easy', random: () => 0.9 });
    expect(searched.random).toBe(false);
    expect(searched.depth).toBe(1);
  });

  it('mức Khó: dừng trong khoảng 3 giây', () => {
    const r = findBestMove({ game: 'xiangqi', moves: ['h2e2', 'h9g7'], level: 'hard' });
    console.log(`xiangqi hard: depth=${r.depth} nodes=${r.nodes} time=${r.timeMs}ms move=${r.move}`);
    expect(r.timeMs).toBeLessThan(3_600);
    expect(r.depth).toBeGreaterThanOrEqual(3);
    expect(replayGame('xiangqi', ['h2e2', 'h9g7']).isLegal(r.move!)).toBe(true);
  }, 10_000);

  it('mức Khó cờ vua: dừng trong khoảng 3 giây', () => {
    const r = findBestMove({ game: 'chess', moves: ['e2e4', 'e7e5'], level: 'hard' });
    console.log(`chess hard: depth=${r.depth} nodes=${r.nodes} time=${r.timeMs}ms move=${r.move}`);
    expect(r.timeMs).toBeLessThan(3_600);
    expect(r.depth).toBeGreaterThanOrEqual(3);
  }, 10_000);

  it('ván đã kết thúc thì không trả nước', () => {
    const r = findBestMove({ game: 'xiangqi', startFen: '4k4/9/4P4/9/3R1R3/9/9/9/9/4K4 b - - 0 1', moves: [] });
    expect(r.move).toBeNull();
  });
});

describe('AI đọc nước đi như bộ luật', () => {
  it('cờ vua: nước viết hoa / có khoảng trắng / chữ phong cấp hoa vẫn dựng lại được (không ném lỗi)', () => {
    for (const moves of [['E2E4'], ['e2e4 ', ' E7E5'], ['e2E4', 'e7e5', 'G1F3']]) {
      const r = findBestMove({ game: 'chess', moves, level: 'medium' });
      expect(r.move, JSON.stringify(moves)).not.toBeNull();
      expect(replayGame('chess', moves).isLegal(r.move!)).toBe(true);
    }
    // Phong cấp ghi chữ hoa: luật nhận "a7a8Q" → AI cũng phải nhận
    const r = findBestMove({ game: 'chess', startFen: '4k3/P7/8/8/8/8/8/4K3 w - - 0 1', moves: ['a7a8Q', 'e8d7'], level: 'medium' });
    expect(r.move).not.toBeNull();
  });

  it('cờ tướng: "H2-E2", chữ hoa vẫn dựng lại được', () => {
    const r = findBestMove({ game: 'xiangqi', moves: ['H2-E2', ' h9g7'], level: 'medium' });
    expect(replayGame('xiangqi', ['h2e2', 'h9g7']).isLegal(r.move!)).toBe(true);
  });

  it('nước sai thật sự vẫn bị từ chối', () => {
    expect(() => findBestMove({ game: 'chess', moves: ['e2e5'] })).toThrow();
  });
});

describe('AI cờ vua – luật 50 nước', () => {
  it('chiếu hết đúng ở nửa nước thứ 100 vẫn là thắng: máy chọn nước chiếu hết, không coi là hoà', () => {
    // a1a8 chiếu hết; nước khác (vd a1a2) thì hoà 50 nước
    for (const level of ['easy', 'medium', 'hard'] as const) {
      const r = findBestMove({ game: 'chess', startFen: '7k/8/6K1/8/8/8/8/R7 w - - 99 80', moves: [], level, random: () => 0.99 });
      expect(r.move, level).toBe('a1a8');
      expect(r.score, level).toBeGreaterThan(MATE - 100);
    }
  }, 20_000);

  it('bị chiếu hết ở nửa nước thứ 100 được tính là thua (không phải hoà)', () => {
    // Đen chỉ có h8g8, Trắng đáp b1b8 chiếu hết đúng ở nửa nước thứ 100. findBestMove trả ngay nước duy nhất (điểm 0,
    // không tìm), nên chấm điểm thẳng bằng bộ tìm kiếm: phải là thua như khi chưa gần mốc 50 nước
    for (const hm of [98, 0]) {
      const b = new ChessBoard(`7k/8/6K1/8/8/8/8/1R6 b - - ${hm} 80`);
      const root = b.legalMoves();
      expect(root.map(chessMoveToString)).toEqual(['h8g8']);
      const scores = new Searcher(new ChessSearchBoard(b), new TranspositionTable(12), []).scoreRootMoves(
        root,
        3,
        0,
        Infinity,
        true,
      );
      expect(scores![0], `halfmove ${hm}`).toBeLessThan(-(MATE - 100));
    }
  });
});

describe('AI cờ tướng – ván dài', () => {
  it('lọc nước chiếu dai không dựng lại cả ván cho mỗi nước, không làm đổi engine', () => {
    // Ván dài tối đa 400 nửa nước: mỗi nước chọn tất định trong các nước không ăn quân, không chiếu, không lặp thế
    const moves: string[] = [];
    const g = replayGame('xiangqi', []);
    while (moves.length < 400) {
      const legal = g.legalMoves().filter((m) => {
        g.play(m);
        const ok = !g.status().over && !g.inCheck() && !g.historyInfo().at(-1)!.captured && g.warnings().length === 0;
        g.undo();
        return ok;
      });
      if (!legal.length) break;
      const m = legal[(moves.length * 7919) % legal.length];
      g.play(m);
      moves.push(m);
    }
    expect(moves.length).toBeGreaterThan(200);
    const t = Date.now();
    const r = findBestMove({ game: 'xiangqi', moves, config: { maxDepth: 2, timeMs: 200, quiescence: true, randomness: 0 } });
    const took = Date.now() - t;
    expect(replayGame('xiangqi', moves).isLegal(r.move!)).toBe(true);
    // Hạn 200 ms tính cả phần dựng lại ván + lọc (trước đây phần lọc riêng đã mất hàng giây ở ván dài)
    expect(took).toBeLessThan(2_000);
    // Đi thử rồi huỷ: engine phải trở về đúng thế cũ sau mỗi lần kiểm tra
    const fen = g.fen();
    const len = g.history().length;
    for (const m of g.legalMoves()) allowsPerpetualClaim(g, m);
    expect(g.fen()).toBe(fen);
    expect(g.history().length).toBe(len);
  }, 60_000);

  it('vẫn nhận ra nước chiếu để đối thủ đáp lặp thế lần 3 (máy thua vì chiếu dai)', () => {
    // Xe Đỏ chiếu liên tục; nước chiếu 'e9e8' tự nó chưa lặp lần 3, nhưng Đen đáp 'f8f9' là lặp thế lần 3 → Đỏ thua
    const fen = '4k4/9/9/9/9/9/9/9/9/R2K5 w - - 0 1';
    const moves = ['a0a9', 'e9e8', 'a9a8', 'e8e9', 'a8e8', 'e9f9', 'e8e9', 'f9f8', 'e9e8', 'f8f9', 'e8e9', 'f9f8'];
    const g = replayGame('xiangqi', moves, fen);
    expect(g.isPerpetualCheckLoss('e9e8')).toBe(false);
    expect(allowsPerpetualClaim(g, 'e9e8')).toBe(true);
    expect(g.history()).toEqual(moves);
    // Máy (Đỏ) có nước khác thì không chọn nước chiếu đó
    const r = findBestMove({ game: 'xiangqi', startFen: fen, moves, level: 'medium' });
    expect(r.move).not.toBe('e9e8');
  });
});

describe('Giao thức Web Worker', () => {
  it('reset và search', () => {
    expect(handleAiRequest({ id: 1, type: 'reset' })).toEqual({ id: 1, ok: true, result: null });
    const res = handleAiRequest({ id: 2, type: 'search', request: { game: 'chess', moves: [], level: 'medium' } });
    expect(res.ok).toBe(true);
    const bad = handleAiRequest({ id: 3, type: 'search', request: { game: 'chess', moves: ['e2e5'] } });
    expect(bad.ok).toBe(false);
  });
});
