import { describe, expect, it } from 'vitest';
import { JieqiBoard, createJieqiGame, randomJieqiSetup } from '../src';
import { seededRandom } from '../src/zobrist';
import { refInCheck, refLegalMoves } from './jieqi-reference';

const rngOf = (seed: number) => {
  const r = seededRandom(seed);
  return () => (r() >>> 0) / 4294967296;
};

const inOwnPalace = (color: number, sq: string) => {
  const f = sq.charCodeAt(0) - 97;
  const r = Number(sq[1]);
  return f >= 3 && f <= 5 && (color === 0 ? r <= 2 : r >= 7);
};
const inEnemyHalf = (color: number, sq: string) => (color === 0 ? Number(sq[1]) >= 5 : Number(sq[1]) <= 4);

describe('Cờ úp – đối chiếu bộ sinh nước tham chiếu (ván ngẫu nhiên)', () => {
  it('nước hợp lệ + chiếu khớp tham chiếu; chế độ công khai luôn khớp chế độ biết đủ', () => {
    const seen = { advisorOut: 0, elephantCross: 0, pawnSide: 0, check: 0, hiddenCaptured: 0, mate: 0, positions: 0 };
    for (let seed = 1; seed <= 40; seed++) {
      const rng = rngOf(seed);
      const g = createJieqiGame(randomJieqiSetup(rng));
      const p = createJieqiGame();
      for (let ply = 0; ply < 150; ply++) {
        seen.positions++;
        const legal = g.legalMoves().slice().sort();
        const over = g.status().over;
        if (!over) expect(legal, `seed ${seed} ply ${ply} ${g.fen()}`).toEqual(refLegalMoves(g));
        expect(g.inCheck()).toBe(refInCheck(g));
        // Đường nhanh xét chiếu tướng khớp hàm khống chế tổng quát (cả hai bên)
        for (const c of [0, 1] as const) {
          expect(g.board.isKingAttacked(c)).toBe(g.board.isAttacked(g.board.kingSq[c], c === 0 ? 1 : 0));
        }
        // Chế độ công khai: cùng nước hợp lệ, cùng trạng thái
        expect(p.legalMoves().slice().sort()).toEqual(legal);
        expect(p.fen()).toBe(g.fen());
        expect(p.status()).toEqual(g.status());
        expect(p.warnings()).toEqual(g.warnings());
        expect(p.inCheck()).toBe(g.inCheck());
        expect(p.pools()).toEqual(g.pools());
        if (g.inCheck()) seen.check++;
        if (over) {
          if (g.status().over && (g.status() as { result: { reason: string } }).result.reason === 'checkmate') seen.mate++;
          break;
        }
        // Ưu tiên nước ăn quân một chút để ván đi xa hơn
        const caps = legal.filter((m) => g.pieceAt(m.slice(2, 4)));
        const pool = caps.length && rng() < 0.35 ? caps : legal;
        const m = pool[Math.floor(rng() * pool.length)];
        const mover = g.pieceAt(m.slice(0, 2))!;
        expect(g.play(m)).toBe(true);
        const rv = g.lastReveal();
        expect(p.play(m, rv)).toBe(true);
        expect(p.historyInfo()[p.history().length - 1]).toEqual(g.historyInfo()[g.history().length - 1]);
        if (rv?.captured) seen.hiddenCaptured++;
        if (!mover.hidden && mover.type === 'p' && m[1] === m[3]) seen.pawnSide++;
        for (const q of g.pieces()) {
          if (q.hidden) continue;
          if (q.type === 'a' && !inOwnPalace(q.color, q.square)) seen.advisorOut++;
          if (q.type === 'e' && inEnemyHalf(q.color, q.square)) seen.elephantCross++;
        }
        // Băm Zobrist cập nhật dần khớp với băm tính lại từ FEN công khai
        const fresh = new JieqiBoard(g.fen());
        expect([g.board.hashLo, g.board.hashHi]).toEqual([fresh.hashLo, fresh.hashHi]);
      }
    }
    console.log('độ phủ đối chiếu:', JSON.stringify(seen));
    expect(seen.advisorOut).toBeGreaterThan(0);
    expect(seen.elephantCross).toBeGreaterThan(0);
    expect(seen.pawnSide).toBeGreaterThan(0);
    expect(seen.check).toBeGreaterThan(0);
    expect(seen.hiddenCaptured).toBeGreaterThan(0);
  }, 60_000);
});
