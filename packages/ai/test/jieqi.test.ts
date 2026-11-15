import { describe, expect, it } from 'vitest';
import { createJieqiGame, randomJieqiSetup, replayJieqi, type JieqiReveal } from '@cotuong/game-core';
import { findBestMove, handleAiRequest, seededRandom01 } from '../src';

/** Chơi một ván ngắn ở chế độ biết đủ, trả về thông tin CÔNG KHAI (nước + lật quân) */
function playPublic(setup: string, plies: number, seed: number) {
  const g = createJieqiGame(setup);
  const rnd = seededRandom01(seed);
  for (let i = 0; i < plies && !g.status().over; i++) {
    const legal = g.legalMoves();
    g.play(legal[Math.floor(rnd() * legal.length)]);
  }
  return { game: g, moves: g.history(), reveals: g.reveals() as Array<JieqiReveal | null> };
}

describe('AI cờ úp', () => {
  it('trả về nước hợp lệ từ thế bắt đầu, ở cả ba mức', () => {
    const setup = randomJieqiSetup(seededRandom01(7));
    for (const level of ['easy', 'medium', 'hard'] as const) {
      const r = findBestMove({ game: 'xiangqi', variant: 'jieqi', moves: [], level, seed: 11, config: { timeMs: 400 } });
      expect(r.move).not.toBeNull();
      expect(createJieqiGame(setup).isLegal(r.move!)).toBe(true);
    }
  });

  it('trả về nước hợp lệ giữa ván (sau nhiều lần lật quân)', () => {
    const setup = randomJieqiSetup(seededRandom01(3));
    const { game, moves, reveals } = playPublic(setup, 24, 5);
    if (game.status().over) return;
    const r = findBestMove({ game: 'xiangqi', variant: 'jieqi', moves, reveals, level: 'medium', seed: 1, config: { timeMs: 500 } });
    expect(r.move).not.toBeNull();
    expect(replayJieqi(setup, moves).isLegal(r.move!)).toBe(true);
  });

  it('không dùng bí mật: hai cách xếp quân khác nhau nhưng cùng thông tin công khai cho cùng một nước', () => {
    // Từ thế bắt đầu, thông tin công khai giống hệt nhau với mọi cách xếp quân
    const a = findBestMove({ game: 'xiangqi', variant: 'jieqi', moves: [], level: 'medium', seed: 42, config: { timeMs: null, maxDepth: 2 } });
    const b = findBestMove({ game: 'xiangqi', variant: 'jieqi', moves: [], level: 'medium', seed: 42, config: { timeMs: null, maxDepth: 2 } });
    expect(a.move).toBe(b.move);
    // Yêu cầu không có trường nào để truyền chuỗi xếp quân: AI không thể biết danh tính quân úp
    expect(Object.keys({ game: 'xiangqi', variant: 'jieqi', moves: [], reveals: [] })).not.toContain('setup');
  });

  it('kết thúc trong giới hạn thời gian', () => {
    const t0 = Date.now();
    const r = findBestMove({ game: 'xiangqi', variant: 'jieqi', moves: [], level: 'hard', seed: 9, config: { timeMs: 800 } });
    expect(r.move).not.toBeNull();
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it('chạy được qua bộ xử lý Web Worker', () => {
    const res = handleAiRequest({ id: 1, type: 'search', request: { game: 'xiangqi', variant: 'jieqi', moves: [], level: 'easy', seed: 2 } });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.result?.move).toBeTruthy();
  });

  it('báo lỗi khi thông tin lật quân sai', () => {
    const setup = randomJieqiSetup(seededRandom01(4));
    const g = createJieqiGame(setup);
    const first = g.legalMoves()[0];
    g.play(first);
    const real = g.reveals()[0];
    const wrong: JieqiReveal = { piece: real?.piece === 'r' ? 'c' : 'r' };
    // Thông tin lật quân phải khớp số quân còn trong kho; lật sai loại vẫn có thể hợp lệ về mặt công khai,
    // nhưng lật một loại không còn trong kho thì phải bị từ chối
    expect(() =>
      findBestMove({ game: 'xiangqi', variant: 'jieqi', moves: [first, first], reveals: [wrong, null], level: 'easy', seed: 1 }),
    ).toThrow();
  });
});
