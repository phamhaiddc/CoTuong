import { describe, expect, it } from 'vitest';
import {
  JIEQI_SETUP_SQUARES,
  JIEQI_STANDARD_SETUP,
  JIEQI_START_FEN,
  JieqiBoard,
  JieqiGame,
  createJieqiGame,
  isValidJieqiSetup,
  jq,
  parseJieqiSetup,
  randomJieqiSetup,
  replayGame,
  replayJieqi,
  replayJieqiPublic,
  validateJieqiSetup,
  xqParseSquare,
  xqSquareName,
} from '../src';
import { seededRandom } from '../src/zobrist';

/** RNG [0, 1) có seed cho test */
const rngOf = (seed: number) => {
  const r = seededRandom(seed);
  return () => (r() >>> 0) / 4294967296;
};

const INITIAL: Record<string, number> = { a: 2, e: 2, r: 2, c: 2, h: 2, p: 5 };
const ALIAS: Record<string, string> = { b: 'e', n: 'h' };

/**
 * FEN cờ úp cho thế tuỳ chọn "xếp-quân bên-đi": tự tính ngoặc quân bị ăn = bộ quân đầy đủ − quân ngửa trên
 * bàn − danh tính các quân úp (`secrets`).
 */
function fenOf(pos: string, secrets: Record<string, string> = {}): string {
  const [placement, turn = 'w'] = pos.split(' ');
  const used = [0, 1].map(() => ({ a: 0, e: 0, r: 0, c: 0, h: 0, p: 0 }) as Record<string, number>);
  const hiddenColor: Record<string, number> = {};
  placement.split('/').forEach((row, i) => {
    let file = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) {
        file += Number(ch);
        continue;
      }
      const sq = 'abcdefghi'[file] + (9 - i);
      const color = ch === ch.toUpperCase() ? 0 : 1;
      const l = ch.toLowerCase();
      if (l === 'x') hiddenColor[sq] = color;
      else if (l !== 'k') used[color][ALIAS[l] ?? l]++;
      file++;
    }
  });
  for (const [sq, t] of Object.entries(secrets)) used[hiddenColor[sq]][t]++;
  let br = '';
  for (const color of [0, 1]) {
    for (const t of ['a', 'e', 'r', 'c', 'h', 'p']) {
      const n = INITIAL[t] - used[color][t];
      if (n < 0) throw new Error('thế thử sai: thừa quân');
      if (n) br += (color ? t : t.toUpperCase()) + n;
    }
  }
  return `${placement}${br ? `[${br}]` : ''} ${turn} - - 0 1`;
}

/** Ván chế độ biết đủ từ thế tuỳ chọn */
const full = (pos: string, secrets: Record<string, string> = {}) => new JieqiGame({ fen: fenOf(pos, secrets), secrets });

const sorted = (a: string[]) => a.slice().sort();

/**
 * Thế xếp quân thử: không quân nào trùng loại gốc của ô (để thấy rõ quân úp đi theo ô, lật ra theo loại thật).
 * Mỗi bên: a0=Pháo b0=Tốt c0=Xe d0=Mã f0=Tốt g0=Sĩ h0=Tượng i0=Tốt b2=Xe h2=Mã a3=Tượng c3=Sĩ e3=Tốt g3=Pháo i3=Tốt
 * (Đen tương ứng a9 b9 c9 d9 f9 g9 h9 i9 b7 h7 a6 c6 e6 g6 i6).
 */
const SETUP_X = 'cprhpaeprheapcp/cprhpaeprheapcp';

/** Ván ngẫu nhiên có seed ở chế độ biết đủ */
function randomGame(seed: number, plies: number, setup?: string): JieqiGame {
  const rng = rngOf(seed);
  const g = createJieqiGame(setup ?? randomJieqiSetup(rng));
  for (let i = 0; i < plies && !g.status().over; i++) {
    const legal = g.legalMoves();
    g.play(legal[Math.floor(rng() * legal.length)]);
  }
  return g;
}

describe('Cờ úp – chuỗi xếp quân', () => {
  it('xếp chuẩn và xếp thử hợp lệ, đọc đúng ô', () => {
    expect(validateJieqiSetup(JIEQI_STANDARD_SETUP)).toBeNull();
    expect(validateJieqiSetup(SETUP_X)).toBeNull();
    const t = parseJieqiSetup(SETUP_X);
    const at = (sq: string) => t[xqParseSquare(sq)];
    // 6 = Pháo, 7 = Tốt, 5 = Xe (mã loại của game-core)
    expect([at('a0'), at('b0'), at('b2'), at('i3'), at('e0'), at('a9'), at('i6'), at('b7')]).toEqual([6, 7, 5, 7, 0, 6, 7, 5]);
    expect(JIEQI_SETUP_SQUARES[0].map(xqSquareName).join(' ')).toBe('a0 b0 c0 d0 f0 g0 h0 i0 b2 h2 a3 c3 e3 g3 i3');
    expect(JIEQI_SETUP_SQUARES[1].map(xqSquareName).join(' ')).toBe('a9 b9 c9 d9 f9 g9 h9 i9 b7 h7 a6 c6 e6 g6 i6');
  });

  it('từ chối chuỗi sai', () => {
    const bad: unknown[] = [
      '',
      null,
      undefined,
      123,
      'rheaaehrccppppp',
      'rheaaehrccppppp/rheaaehrccpppp',
      'rheaaehrccppppp/rheaaehrccpppppp',
      'RHEAAEHRCCPPPPP/rheaaehrccppppp',
      'rheaaehrccppppk/rheaaehrccppppp',
      'rrrrrrrrrrrrrrr/rheaaehrccppppp',
      'rheaaehrcccpppp/rheaaehrccppppp',
      ' rheaaehrccppppp/rheaaehrccppppp',
      'rheaaehrccppppp/rheaaehrccppppp ',
      'rheaaehrccppppp|rheaaehrccppppp',
      'rnbaabnrccppppp/rheaaehrccppppp',
    ];
    for (const s of bad) {
      expect(validateJieqiSetup(s), String(s)).not.toBeNull();
      expect(isValidJieqiSetup(s)).toBe(false);
    }
    expect(() => parseJieqiSetup('abc')).toThrow();
    expect(() => createJieqiGame('abc')).toThrow();
  });

  it('xếp ngẫu nhiên: luôn hợp lệ, đúng bộ quân, có seed thì lặp lại được', () => {
    const rng = rngOf(7);
    for (let i = 0; i < 2000; i++) {
      const s = randomJieqiSetup(rng);
      expect(validateJieqiSetup(s)).toBeNull();
      for (const half of s.split('/')) expect(half.split('').sort().join('')).toBe('aacceehhppppprr');
    }
    expect(randomJieqiSetup(rngOf(42))).toBe(randomJieqiSetup(rngOf(42)));
    expect(randomJieqiSetup(rngOf(42))).not.toBe(randomJieqiSetup(rngOf(43)));
    // RNG mặc định (crypto) và RNG trả giá trị biên / không hợp lệ
    const set = new Set(Array.from({ length: 20 }, () => randomJieqiSetup()));
    expect(set.size).toBeGreaterThan(1);
    for (const s of set) expect(isValidJieqiSetup(s)).toBe(true);
    expect(isValidJieqiSetup(randomJieqiSetup(() => 1))).toBe(true);
    expect(isValidJieqiSetup(randomJieqiSetup(() => NaN))).toBe(true);
    expect(isValidJieqiSetup(randomJieqiSetup(() => -3))).toBe(true);
  });

  it('xếp ngẫu nhiên: mỗi ô ra mỗi loại với tần suất trong giới hạn thống kê (±5σ)', () => {
    const N = 6000;
    const rng = rngOf(2024);
    const count: Array<Record<string, number>> = Array.from({ length: 30 }, () => ({ r: 0, h: 0, e: 0, a: 0, c: 0, p: 0 }));
    for (let i = 0; i < N; i++) {
      const s = randomJieqiSetup(rng).replace('/', '');
      for (let k = 0; k < 30; k++) count[k][s[k]]++;
    }
    for (let k = 0; k < 30; k++) {
      for (const [t, n] of Object.entries(INITIAL)) {
        const p = n / 15;
        const sigma = Math.sqrt(N * p * (1 - p));
        expect(Math.abs(count[k][t] - N * p), `ô ${k} loại ${t}`).toBeLessThan(5 * sigma);
      }
    }
  });
});

describe('Cờ úp – thế bắt đầu', () => {
  it('hai Tướng ngửa, 30 quân úp ở đúng ô, FEN công khai', () => {
    const g = createJieqiGame(SETUP_X);
    expect(g.knowledge).toBe('full');
    expect(g.game).toBe('xiangqi');
    expect(g.variant).toBe('jieqi');
    expect(g.fen()).toBe(JIEQI_START_FEN);
    expect(g.startFen()).toBe(JIEQI_START_FEN);
    const ps = g.pieces();
    expect(ps.length).toBe(32);
    expect(ps.filter((p) => p.hidden).length).toBe(30);
    expect(g.pieceAt('e0')).toEqual({ square: 'e0', color: 0, type: 'k' });
    expect(g.pieceAt('e9')).toEqual({ square: 'e9', color: 1, type: 'k' });
    // Quân úp: type = loại GỐC của ô (a0 là ô Xe dù thật ra là Pháo)
    expect(g.pieceAt('a0')).toEqual({ square: 'a0', color: 0, type: 'r', hidden: true });
    expect(g.pieceAt('b7')).toEqual({ square: 'b7', color: 1, type: 'c', hidden: true });
    expect(g.isHidden('b7')).toBe(true);
    expect(g.isHidden('e9')).toBe(false);
    expect(g.pools()).toEqual([
      { r: 2, h: 2, e: 2, a: 2, c: 2, p: 5 },
      { r: 2, h: 2, e: 2, a: 2, c: 2, p: 5 },
    ]);
    expect(g.hiddenCount(0)).toBe(15);
    expect(g.capturedPieces()[1]).toEqual({ r: 0, h: 0, e: 0, a: 0, c: 0, p: 0 });
    expect(g.status()).toEqual({ over: false });
    expect(g.inCheck()).toBe(false);
    expect(g.setup()).toBe(SETUP_X);
    expect(g.secretTypeAt('a0')).toBe('c');
    expect(g.secretTypeAt('e0')).toBeNull();
    expect(createJieqiGame().setup()).toBeNull();
  });

  it('nước đầu của quân úp theo loại gốc của ô — mọi loại ô, kể cả cản chân Mã / ngòi Pháo', () => {
    const g = createJieqiGame(SETUP_X);
    expect(sorted(g.legalMovesFrom('a0'))).toEqual(['a0a1', 'a0a2']); // Xe (a3 chặn)
    expect(sorted(g.legalMovesFrom('i0'))).toEqual(['i0i1', 'i0i2']);
    expect(sorted(g.legalMovesFrom('b0'))).toEqual(['b0a2', 'b0c2']); // Mã: d1 bị c0 cản chân
    expect(sorted(g.legalMovesFrom('h0'))).toEqual(['h0g2', 'h0i2']);
    expect(sorted(g.legalMovesFrom('c0'))).toEqual(['c0a2', 'c0e2']); // Tượng
    expect(sorted(g.legalMovesFrom('g0'))).toEqual(['g0e2', 'g0i2']);
    expect(g.legalMovesFrom('d0')).toEqual(['d0e1']); // Sĩ thường: chỉ trong cung (không có d0c1)
    expect(g.legalMovesFrom('f0')).toEqual(['f0e1']);
    // Pháo: trượt + ăn qua đúng một ngòi (b9 qua ngòi b7), không ăn thẳng b7
    expect(sorted(g.legalMovesFrom('b2'))).toEqual(
      sorted(['b2b1', 'b2b3', 'b2b4', 'b2b5', 'b2b6', 'b2b9', 'b2a2', 'b2c2', 'b2d2', 'b2e2', 'b2f2', 'b2g2']),
    );
    expect(g.legalMovesFrom('b2')).not.toContain('b2b7');
    expect(g.legalMovesFrom('a3')).toEqual(['a3a4']); // Tốt chưa qua sông: chỉ tiến
    expect(g.legalMovesFrom('e3')).toEqual(['e3e4']);
    expect(g.legalMoves().length).toBe(44);
  });

  it('quân úp ở ô Mã khi chân trống, ô Tượng bị cản mắt, ô Sĩ bị chặn', () => {
    // c0 trống: quân úp b0 (ô Mã) đi được d1. Quân úp g0 (ô Tượng) bị cản mắt f1. Quân úp d0 (ô Sĩ): e1 có quân mình.
    const g = full('3k5/9/9/9/9/9/9/9/4AP3/1X1X1KX2 w', { b0: 'r', d0: 'p', g0: 'c' });
    expect(sorted(g.legalMovesFrom('b0'))).toEqual(['b0a2', 'b0c2', 'b0d1']);
    expect(g.legalMovesFrom('g0')).toEqual(['g0i2']);
    expect(g.legalMovesFrom('d0')).toEqual([]);
  });

  it('xếp như cờ tướng thường: perft 44 / 1920 / 79666 (trùng cờ tướng tới độ sâu 3)', () => {
    const b = new JieqiBoard();
    const t = parseJieqiSetup(JIEQI_STANDARD_SETUP);
    for (let s = 0; s < 90; s++) if (b.sq[s] & jq.HIDDEN) b.secret[s] = t[s];
    const fen = b.fen();
    const [lo, hi] = [b.hashLo, b.hashHi];
    const perft = (d: number): number => {
      if (d === 0) return 1;
      let n = 0;
      for (const m of b.generateMoves()) {
        if (b.makeMove(m)) {
          n += d === 1 ? 1 : perft(d - 1);
          b.unmakeMove();
        }
      }
      return n;
    };
    expect(perft(1)).toBe(44);
    expect(perft(2)).toBe(1920);
    expect(perft(3)).toBe(79666);
    // make/unmake trả lại nguyên trạng
    expect(b.fen()).toBe(fen);
    expect([b.hashLo, b.hashHi]).toEqual([lo, hi]);
    expect(Array.from(b.pool)).toEqual(Array.from(new JieqiBoard().pool));
    expect(b.captured.every((x) => x === 0)).toBe(true);
    expect(b.ply).toBe(0);
  });
});

describe('Cờ úp – lật quân và đi theo loại thật', () => {
  it('lật rồi đi theo loại thật (quân úp ở a0 đi như Xe, lật ra Pháo, sau đó đi như Pháo)', () => {
    const g = createJieqiGame(SETUP_X);
    expect(g.play('a0a1')).toBe(true);
    expect(g.historyInfo()[0]).toEqual({
      move: 'a0a1',
      from: 'a0',
      to: 'a1',
      label: 'X9.1 → Pháo',
      captured: false,
      check: false,
      reveal: { piece: 'c' },
    });
    expect(g.lastReveal()).toEqual({ piece: 'c' });
    expect(g.pieceAt('a1')).toEqual({ square: 'a1', color: 0, type: 'c' });
    expect(g.pools()[0].c).toBe(1);
    expect(g.play('a9a8')).toBe(true); // Đen: cũng lật ra Pháo
    expect(g.historyInfo()[1].label).toBe('X1.1 → Pháo');
    // Pháo a1: trượt hàng 1 / cột a, ăn a6 qua ngòi a3 — không còn đi như Xe
    expect(sorted(g.legalMovesFrom('a1'))).toEqual(
      sorted(['a1a0', 'a1a2', 'a1a6', 'a1b1', 'a1c1', 'a1d1', 'a1e1', 'a1f1', 'a1g1', 'a1h1', 'a1i1']),
    );
    expect(g.reveals()).toEqual([{ piece: 'c' }, { piece: 'c' }]);
  });

  it('nhãn nước đi: quân úp, quân úp ăn quân úp, quân đã lật', () => {
    const g = createJieqiGame(SETUP_X);
    expect(g.play('h2e2')).toBe(true); // ô Pháo, thật là Mã
    expect(g.historyInfo()[0].label).toBe('P2-5 → Mã');
    expect(g.play('h7h0')).toBe(false); // h2 đã đi nên Pháo h7 không còn ngòi
    expect(g.play('b7b0')).toBe(true); // ô Pháo đen (thật Xe) ăn b0 (thật Tốt) qua ngòi b2
    expect(g.historyInfo()[1]).toMatchObject({ label: 'P2.7 → Xe (ăn Tốt úp)', captured: true, reveal: { piece: 'r', captured: 'p' } });
    expect(g.capturedPieces()[0].p).toBe(1);
    expect(g.pools()[0].p).toBe(4);
    expect(g.fen()).toBe('xxxxkxxxx/9/7x1/x1x1x1x1x/9/9/X1X1X1X1X/1X2H4/9/XrXXKXXXX[P1] w - - 0 2');
    expect(g.play('a0a1')).toBe(true);
    expect(g.play('b0b1')).toBe(true); // Xe đen đã lật đi tiếp: nhãn theo loại thật
    expect(g.historyInfo()[3].label).toBe('X2/1');
  });

  it('nhãn ký hiệu Việt Nam: quân úp ghi theo loại gốc của ô rồi quân lật ra; Sĩ đã lật đi tự do', () => {
    const g = createJieqiGame(SETUP_X);
    expect(g.play('c3c4')).toBe(true); // ô Tốt cột 7 của Đỏ, thật là Sĩ
    expect(g.play('c6c5')).toBe(true); // ô Tốt cột 3 của Đen, thật là Sĩ
    expect(g.play('c4d5')).toBe(true); // Sĩ đã lật đi ra ngoài cung
    expect(g.historyInfo().map((i) => i.label)).toEqual(['B7.1 → Sĩ', 'B3.1 → Sĩ', 'S7.6']);
  });

  it('chưa xác minh: hai Tượng đã lật cùng cột chỉ ghi t / s khi cho cùng ký hiệu', () => {
    const pos = '3k5/9/9/2E6/9/9/9/2E6/9/4K4 w';
    const labelOf = (move: string) => {
      const g = full(pos);
      expect(g.play(move)).toBe(true);
      return g.historyInfo()[0].label;
    };
    expect(labelOf('c2e4')).toBe('Ts.5'); // Tượng c6 cũng tấn sang cột 5 được
    expect(labelOf('c6e8')).toBe('Tt.5');
    expect(labelOf('c2a4')).toBe('Ts.9');
    expect(labelOf('c6e4')).toBe('T7/5'); // Tượng c2 không thoái sang cột 5 được (ô e0 có Tướng)
  });

  it('quân úp bị ăn: lật cho cả hai bên (FULL tự biết, PUBLIC cần đúng thông tin)', () => {
    const g = createJieqiGame(SETUP_X);
    expect(g.play('b2b9')).toBe(true); // ô Pháo đỏ (thật Xe) ăn b9 (thật Tốt) qua ngòi b7
    expect(g.lastReveal()).toEqual({ piece: 'r', captured: 'p' });
    expect(g.historyInfo()[0].label).toBe('P8.7 → Xe (ăn Tốt úp)');
    expect(g.pools()[1].p).toBe(4);
    expect(g.capturedPieces()[1]).toEqual({ r: 0, h: 0, e: 0, a: 0, c: 0, p: 1 });
    expect(g.fen()).toBe('xRxxkxxxx/9/1x5x1/x1x1x1x1x/9/9/X1X1X1X1X/7X1/9/XXXXKXXXX[p1] b - - 0 1');

    const p = createJieqiGame();
    expect(p.knowledge).toBe('public');
    expect(p.needsReveal('b2b9')).toBe(true);
    expect(p.needsReveal('e0e1')).toBe(false);
    expect(p.needsReveal('b2b8')).toBe(false); // không hợp lệ
    expect(p.play('b2b9')).toBe(false); // thiếu thông tin lật
    expect(p.play('b2b9', { piece: 'r' })).toBe(false); // thiếu quân bị ăn
    expect(p.play('b2b9', { piece: 'r', captured: 'k' })).toBe(false);
    expect(p.play('b2b9', { piece: 'R', captured: 'p' })).toBe(false);
    expect(p.play('b2b9', { piece: 'r', captured: 'p' })).toBe(true);
    expect(p.fen()).toBe(g.fen());
    expect(p.historyInfo()).toEqual(g.historyInfo());
    expect(p.secretTypeAt('a0')).toBeNull();
  });

  it('chế độ công khai từ chối thông tin lật quân sai / thừa / hết trong kho', () => {
    const p = createJieqiGame();
    expect(p.play('e0e1', { piece: 'r' })).toBe(false); // Tướng không úp
    expect(p.play('e0e1', { captured: 'p' })).toBe(false); // không ăn quân
    expect(p.play('e0e1', {})).toBe(true);
    expect(p.play('d9e8', { piece: 'a' })).toBe(true);
    expect(p.play('e1e0', null)).toBe(true);
    expect(p.play('f9f8', { piece: 'a' })).toBe(false); // nước không hợp lệ
    expect(p.play('e8d7', { piece: 'a' })).toBe(false); // e8 đã lật, không được kèm piece
    expect(p.play('f9e8')).toBe(false); // e8 đang có quân mình
    expect(p.play('e8d7')).toBe(true);
    expect(p.play('d0e1', { piece: 'a' })).toBe(true);
    expect(p.play('f9e8', { piece: 'a' })).toBe(true);
    expect(p.pools()[1].a).toBe(0);
    expect(p.play('e1d2')).toBe(true);
    expect(p.play('c9e7', { piece: 'a' })).toBe(false); // kho Sĩ của Đen đã hết
    expect(p.play('c9e7', { piece: 'e' })).toBe(true);
  });
});

describe('Cờ úp – Sĩ, Tượng đã lật không bị giới hạn khu vực; Tốt', () => {
  it('Sĩ đã lật ra khỏi cung, qua sông', () => {
    const g = full('4k4/9/9/9/9/9/9/3A5/9/3K5 w');
    expect(sorted(g.legalMovesFrom('d2'))).toEqual(['d2c1', 'd2c3', 'd2e1', 'd2e3']);
    const h = full('3k5/9/9/9/4A4/9/9/9/9/4K4 w');
    expect(sorted(h.legalMovesFrom('e5'))).toEqual(['e5d4', 'e5d6', 'e5f4', 'e5f6']);
  });

  it('Tượng đã lật qua sông, vẫn bị cản mắt', () => {
    const g = full('3k5/9/9/9/3p5/2E6/9/9/9/4K4 w');
    // Tượng c4: a2, e2, a6; e6 bị cản mắt d5 (Tốt đen)
    expect(sorted(g.legalMovesFrom('c4'))).toEqual(['c4a2', 'c4a6', 'c4e2']);
    const h = full('3k5/9/9/2E6/9/9/9/9/9/4K4 w');
    expect(sorted(h.legalMovesFrom('c6'))).toEqual(['c6a4', 'c6a8', 'c6e4', 'c6e8']);
  });

  it('Tốt lật ở sân nhà chỉ tiến; qua sông được đi ngang; ở hàng cuối chỉ đi ngang (cả hai bên)', () => {
    const g = full('3k5/2p6/9/9/9/2P3P2/9/2p6/2P6/4K4 w');
    expect(g.legalMovesFrom('c1')).toEqual(['c1c2']); // Đỏ ở sân nhà (hàng 1), ăn thẳng
    expect(g.legalMovesFrom('g4')).toEqual(['g4g5']); // Đỏ chưa qua sông
    expect(g.legalMovesFrom('c4')).toEqual(['c4c5']);
    const h = full('3k5/9/9/2P6/9/9/9/9/9/4K4 w');
    expect(sorted(h.legalMovesFrom('c6'))).toEqual(['c6b6', 'c6c7', 'c6d6']);
    const last = full('3k1P3/9/9/9/9/9/9/9/9/4K4 w');
    expect(sorted(last.legalMovesFrom('f9'))).toEqual(['f9e9', 'f9g9']);
    const b = full('3k5/2p6/9/9/9/9/2p6/9/9/4K4 b');
    expect(b.legalMovesFrom('c8')).toEqual(['c8c7']); // Đen ở sân nhà
    expect(sorted(b.legalMovesFrom('c3'))).toEqual(['c3b3', 'c3c2', 'c3d3']); // Đen qua sông
  });

  it('quân úp lật ra Tốt ngay bên kia sông (do ăn quân) được đi ngang ở nước sau', () => {
    // Quân úp a0 (ô Xe) thật là Tốt, ăn quân úp a6 của Đen (thật là Mã)
    const g = full('3k5/9/9/x8/9/9/9/9/9/X3K4 w', { a0: 'p', a6: 'h' });
    expect(g.play('a0a6')).toBe(true);
    expect(g.historyInfo()[0].label).toBe('X9.6 → Tốt (ăn Mã úp)');
    expect(g.play('d9d8')).toBe(true);
    expect(sorted(g.legalMovesFrom('a6'))).toEqual(['a6a7', 'a6b6']);
  });
});

describe('Cờ úp – chiếu, lộ mặt tướng', () => {
  it('quân úp khống chế theo loại gốc của ô', () => {
    const b = new JieqiBoard();
    const at = (s: string) => xqParseSquare(s);
    expect(b.isAttacked(at('a7'), 1)).toBe(true); // x a9 (ô Xe) và x b9 (ô Mã)
    expect(b.isAttacked(at('a5'), 1)).toBe(true); // quân úp a6 (ô Tốt) khống chế ô trước mặt
    expect(b.isAttacked(at('b6'), 1)).toBe(false); // ô Tốt chưa qua sông không khống chế ngang; ô Pháo b7 cần ngòi
    expect(b.isAttacked(at('b0'), 1)).toBe(true); // ô Pháo b7 qua ngòi b2
    expect(b.isAttacked(at('d8'), 1)).toBe(false); // ô Mã b9 bị cản chân c9
    expect(b.isAttacked(at('e8'), 1)).toBe(true); // ô Sĩ d9 / Tướng
    expect(b.isAttacked(at('c8'), 1)).toBe(false); // ô Sĩ d9: Sĩ thường chỉ trong cung
    expect(b.isAttacked(at('e7'), 1)).toBe(true); // ô Tượng c9 qua mắt d8
    expect(b.isAttacked(at('a5'), 0)).toBe(false);
    expect(b.isAttacked(at('a4'), 0)).toBe(true); // ô Tốt a3 của Đỏ
  });

  it('nước của quân úp chiếu tướng (sau khi lật) — theo loại thật, cả hai chế độ', () => {
    const place = '4k4/9/9/9/9/9/9/7X1/9/3K5 w';
    const rook = full(place, { h2: 'r' });
    expect(rook.legalMovesFrom('h2')).toContain('h2e2');
    expect(rook.play('h2e2')).toBe(true);
    expect(rook.inCheck()).toBe(true);
    expect(rook.historyInfo()[0]).toMatchObject({ label: 'P2-5 → Xe', check: true });
    const pawn = full(place, { h2: 'p' });
    expect(pawn.play('h2e2')).toBe(true);
    expect(pawn.inCheck()).toBe(false);
    expect(pawn.historyInfo()[0].label).toBe('P2-5 → Tốt');
    const pub = new JieqiGame({ fen: fenOf(place, { h2: 'r' }) });
    expect(pub.knowledge).toBe('public');
    expect(pub.play('h2e2', { piece: 'r' })).toBe(true);
    expect(pub.inCheck()).toBe(true);
    expect(pub.historyInfo()).toEqual(rook.historyInfo());
  });

  it('quân úp làm ngòi cho Pháo chiếu tướng', () => {
    const g = full('4k4/9/9/9/9/9/4X4/4C4/9/4K4 b', { e3: 'h' });
    expect(g.inCheck()).toBe(true);
    // Đen phải tránh chiếu: chỉ đi Tướng sang cột khác (e8 vẫn bị chiếu)
    expect(sorted(g.legalMoves())).toEqual(['e9d9', 'e9f9']);
  });

  it('Sĩ, Tượng đã lật vào sân đối phương chiếu tướng', () => {
    expect(full('3k5/4A4/9/9/9/9/9/9/9/4K4 b').inCheck()).toBe(true);
    expect(full('4k4/9/2E6/9/9/9/9/9/9/3K5 b').inCheck()).toBe(true);
    // mắt tượng bị cản thì không chiếu
    expect(full('4k4/3p5/2E6/9/9/9/9/9/9/3K5 b').inCheck()).toBe(false);
  });

  it('lộ mặt tướng: quân ở giữa bị ghim, tướng không được ra cột trống đối mặt', () => {
    const g = full('4k4/9/9/9/9/4H4/9/9/9/4K4 w');
    expect(g.legalMovesFrom('e4')).toEqual([]);
    expect(sorted(g.legalMoves())).toEqual(['e0d0', 'e0e1', 'e0f0']);
    const h = full('4k4/9/9/9/9/9/9/9/9/3K5 w');
    expect(h.legalMovesFrom('d0')).toEqual(['d0d1']);
    // quân úp đứng giữa hai tướng (ô Tốt e3) vẫn đi được trên cột e
    const u = full('4k4/9/9/9/9/9/4X4/9/9/4K4 w', { e3: 'r' });
    expect(u.legalMovesFrom('e3')).toEqual(['e3e4']);
  });
});

describe('Cờ úp – kết thúc ván', () => {
  it('chiếu bí (Xe), cả hai chế độ', () => {
    const pos = '3k5/1R7/9/9/9/9/9/9/9/R3K4 w';
    for (const g of [full(pos), new JieqiGame({ fen: fenOf(pos) })]) {
      expect(g.status().over).toBe(false);
      expect(g.play('a0a9')).toBe(true);
      expect(g.status()).toEqual({ over: true, result: { winner: 0, reason: 'checkmate' } });
      expect(g.historyInfo()[0].label).toBe('X9.9');
      expect(g.legalMoves()).toEqual([]);
      expect(g.play('d9d8')).toBe(false);
    }
  });

  it('hết nước đi (không bị chiếu): bên phải đi thua', () => {
    const g = full('4k4/9/4P4/9/3R1R3/9/9/9/9/4K4 b');
    expect(g.inCheck()).toBe(false);
    expect(g.status()).toEqual({ over: true, result: { winner: 0, reason: 'stalemate' } });
  });

  it('quân úp ăn quân đã lật', () => {
    const g = full('x2k5/1R7/9/9/9/9/9/9/9/R3K4 w', { a9: 'p' });
    expect(g.play('a0a8')).toBe(true);
    expect(g.play('a9a8')).toBe(true); // quân úp a9 (ô Xe) ăn Xe a8 → lật ra Tốt
    expect(g.historyInfo()[1].label).toBe('X1.1 → Tốt');
    expect(g.historyInfo()[1].reveal).toEqual({ piece: 'p' });
    expect(g.capturedPieces()[0].r).toBe(1);
  });

  it('trạng thái úp là một phần của thế cờ: đi đi lại lại sau khi lật không lặp thế ban đầu', () => {
    const g = createJieqiGame(JIEQI_STANDARD_SETUP);
    const cycle = ['a0a1', 'a9a8', 'a1a0', 'a8a9'];
    for (const m of cycle) expect(g.play(m)).toBe(true);
    // Cờ tướng thường sẽ là lần lặp thứ 2 ở đây; Cờ úp thì a0/a9 đã lật nên là thế mới
    expect(g.repetitionCount()).toBe(1);
    expect(g.warnings()).toEqual([]);
    for (const m of cycle) expect(g.play(m)).toBe(true);
    expect(g.repetitionCount()).toBe(2);
    expect(g.warnings()).toEqual([{ type: 'repetition' }]);
    expect(g.status().over).toBe(false);
    // Cờ tướng thường: cùng 8 nửa nước đã là lặp 3 lần (thế ban đầu xuất hiện lần thứ 3)
    expect(replayGame('xiangqi', [...cycle, ...cycle]).status()).toEqual({ over: true, result: { winner: null, reason: 'repetition' } });
    expect(g.play('a0a1')).toBe(true);
    expect(g.status().over).toBe(false);
    expect(g.play('a9a8')).toBe(true); // thế sau nửa nước thứ 2 xuất hiện lần thứ 3
    expect(g.status()).toEqual({ over: true, result: { winner: null, reason: 'repetition' } });
    expect(g.play('h2e2')).toBe(false);
    expect(g.warnings()).toEqual([]);
  });

  it('chiếu dai làm lặp thế 3 lần: bên chiếu thua; nước lật quân không bao giờ là chiếu dai', () => {
    const g = full('4k4/9/9/9/9/9/6X2/9/9/R2K5 w', { g3: 'r' });
    const cycle = ['a0a9', 'e9e8', 'a9a8', 'e8e9', 'a8a9', 'e9e8', 'a9a8', 'e8e9'];
    for (const m of cycle) {
      expect(g.play(m)).toBe(true);
      expect(g.status().over).toBe(false);
    }
    expect(g.isPerpetualCheckLoss('a8a9')).toBe(true);
    expect(g.isPerpetualCheckLoss('a8a7')).toBe(false);
    expect(g.isPerpetualCheckLoss('g3g4')).toBe(false);
    const pub = replayJieqiPublic(g.history(), g.reveals(), g.startFen());
    expect(pub.isPerpetualCheckLoss('a8a9')).toBe(true);
    expect(pub.isPerpetualCheckLoss('g3g4')).toBe(false); // không cần biết danh tính
    expect(pub.history()).toEqual(g.history());
    expect(g.play('a8a9')).toBe(true);
    expect(g.status()).toEqual({ over: true, result: { winner: 1, reason: 'perpetual_check' } });
  });
});

describe('Cờ úp – tuần tự hoá, hoàn tác, sao chép', () => {
  it('FEN công khai: đọc lại cho đúng thế (chế độ công khai)', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const g = randomGame(seed, 10 + seed * 3);
      const p = new JieqiGame({ fen: g.fen() });
      expect(p.fen()).toBe(g.fen());
      expect(p.pieces()).toEqual(g.pieces());
      expect(p.pools()).toEqual(g.pools());
      expect(p.capturedPieces()).toEqual(g.capturedPieces());
      if (!g.status().over) expect(sorted(p.legalMoves())).toEqual(sorted(g.legalMoves()));
      expect(p.inCheck()).toBe(g.inCheck());
      expect(new JieqiBoard(g.fen()).hashLo).toBe(g.board.hashLo);
      expect(new JieqiBoard(g.fen()).hashHi).toBe(g.board.hashHi);
    }
  });

  it('FEN sai bị từ chối', () => {
    const bad = [
      'xxxxkxxxx/9/1x5x1/x1x1x1x1x/9/9/X1X1X1X1X/1X5X1/9/XXXXKXXX w', // thiếu cột
      'xxxxkxxxx/9/1x5x1/x1x1x1x1x/9/9/X1X1X1X1X/1X5X1/9/XXXXKXXXX[ w', // ngoặc sai
      'xxxxkxxxx/9/1x5x1/x1x1x1x1x/9/9/X1X1X1X1X/1X5X1/X8/1XXXKXXXX w', // X ở a1 không phải ô xuất phát
      'xxxxkxxxx/9/1x5x1/x1x1x1x1x/9/9/X1X1X1X1X/1X5X1/RR7/RXXXKXXXX w', // 3 Xe đỏ
      'xxxxkxxxx/9/1x5x1/x1x1x1x1x/9/9/X1X1X1X1X/1X5X1/9/1XXXKXXXX w', // thiếu 1 quân mà không ghi bị ăn
      'xxxxkxxxx/9/1x5x1/x1x1x1x1x/9/9/X1X1X1X1X/1X5X1/9/1XXXKXXXX[K1] w',
      'xxxxkxxxx/9/1x5x1/x1x1x1x1x/9/9/X1X1X1X1X/1X5X1/9/XXXX1XXXX w', // thiếu tướng Đỏ
      'xxxxkxxxx/9/1x5x1/x1x1x1x1x/9/9/X1X1X1X1X/KX5X1/9/XXXX1XXXX w', // tướng ngoài cung
      'xxxxkxxxx/9/1x5x1/x1x1x1x1x/9/9/X1X1X1X1X/1X5X1/9/XXXXKXXXX z',
      '9/9/9/9/9/9/9/9/9/9 w',
      // Số quân bị ăn lớn hơn số quân có (254 từng tràn Int8 thành -2, làm phình kho quân úp)
      'xxxxkxxxx/9/1x5x1/x1x1x1x1x/9/9/X1X1X1X1X/1X5X1/9/1XXXKXXXX[R254] w',
      'xxxxkxxxx/9/1x5x1/x1x1x1x1x/9/9/X1X1X1X1X/1X5X1/P1P6/1XXXKXXXX[R254] w',
      'xxxxkxxxx/9/1x5x1/x1x1x1x1x/9/9/X1X1X1X1X/1X5X1/9/1XXXKXXXX[R1R2] w',
      // Bên vừa đi (Đen) đang bị chiếu / lộ mặt tướng
      fenOf('4k4/9/9/9/9/9/9/9/9/4K4 w'),
      fenOf('3k5/9/9/9/9/9/9/9/9/3RK4 w'),
    ];
    for (const f of bad) expect(() => new JieqiGame({ fen: f }), f).toThrow();
    // Bên ĐƯỢC đi đang bị chiếu: hợp lệ
    expect(new JieqiGame({ fen: fenOf('3k5/9/9/9/9/9/9/9/9/3RK4 b') }).inCheck()).toBe(true);
    // Một quân đã lật (Xe a0) + 14 quân úp: hợp lệ
    expect(new JieqiGame({ fen: 'xxxxkxxxx/9/1x5x1/x1x1x1x1x/9/9/X1X1X1X1X/1X5X1/9/RXXXKXXXX w' }).pools()[0].r).toBe(1);
    expect(new JieqiGame({ fen: 'xxxxkxxxx/9/1x5x1/x1x1x1x1x/9/9/X1X1X1X1X/1X5X1/9/1XXXKXXXX[R1] w - - 0 1' }).pools()[0].r).toBe(1);
    // setup chỉ dùng cho thế bắt đầu; secrets phải đủ và khớp
    expect(() => new JieqiGame({ fen: fenOf('3k5/9/9/9/9/9/9/9/9/X3K4 w', { a0: 'r' }), setup: SETUP_X })).toThrow();
    expect(() => new JieqiGame({ fen: fenOf('3k5/9/9/9/9/9/9/9/9/X3K4 w', { a0: 'r' }), secrets: {} })).toThrow();
    expect(() => new JieqiGame({ fen: fenOf('3k5/9/9/9/9/9/9/9/9/X3K4 w', { a0: 'r' }), secrets: { a0: 'k' } })).toThrow();
    expect(() => new JieqiGame({ fen: fenOf('3k5/9/9/9/9/9/9/9/9/X3K4 w', { a0: 'r' }), secrets: { a0: 'c' } })).toThrow();
    expect(() => new JieqiGame({ fen: fenOf('3k5/9/9/9/9/9/9/9/9/X3K4 w', { a0: 'r' }), secrets: { a0: 'r', b0: 'r' } })).toThrow();
    expect(() => new JieqiGame({ setup: SETUP_X, secrets: {} })).toThrow();
  });

  it('bản ghi công khai (JSON) dựng lại đúng ván; replay biết đủ khớp', () => {
    for (let seed = 100; seed < 120; seed++) {
      const g = randomGame(seed, 60);
      const rec = JSON.parse(JSON.stringify(g.publicRecord()));
      const p = replayJieqiPublic(rec.moves, rec.reveals, rec.startFen);
      expect(p.fen()).toBe(g.fen());
      expect(p.historyInfo()).toEqual(g.historyInfo());
      expect(p.reveals()).toEqual(g.reveals());
      expect(p.status()).toEqual(g.status());
      expect(p.warnings()).toEqual(g.warnings());
      const f = replayJieqi(g.setup()!, g.history());
      expect(f.fen()).toBe(g.fen());
      expect(f.reveals()).toEqual(g.reveals());
    }
    expect(() => replayJieqi(SETUP_X, ['a0a5'])).toThrow(/Nước thứ 1/);
    expect(() => replayJieqiPublic(['a0a1'], [])).toThrow();
    expect(() => replayJieqiPublic(['e0e1'], [null, null])).toThrow();
  });

  it('hoàn tác và sao chép ở cả hai chế độ', () => {
    const g = randomGame(5, 40);
    const p = replayJieqiPublic(g.history(), g.reveals());
    for (const x of [g, p]) {
      const c = x.clone();
      expect(c.knowledge).toBe(x.knowledge);
      expect(c.fen()).toBe(x.fen());
      expect(c.reveals()).toEqual(x.reveals());
      const n = x.history().length;
      for (let i = 0; i < n; i++) x.undo();
      expect(x.fen()).toBe(JIEQI_START_FEN);
      expect(x.pools()).toEqual(createJieqiGame().pools());
      expect(x.history()).toEqual([]);
      expect(x.reveals()).toEqual([]);
      expect(x.undo()).toBeNull();
      expect(c.history().length).toBe(n);
    }
    // Đi lại sau khi hoàn tác (chế độ công khai cần lại thông tin lật quân)
    expect(p.play('b2b9')).toBe(false);
    expect(g.play('b2b9')).toBe(true);
    expect(p.play('b2b9', g.lastReveal())).toBe(true);
    expect(p.fen()).toBe(g.fen());
  });

  it('thông tin công khai không bao giờ chứa danh tính quân úp', () => {
    for (let seed = 200; seed < 260; seed++) {
      const rng = rngOf(seed);
      const setupA = randomJieqiSetup(rng);
      const a = randomGame(seed, Math.floor(rng() * 80), setupA);
      // Xếp B: giống A ở mọi quân đã lộ, hoán vị danh tính các quân còn úp của mỗi bên
      const types = setupA.replace('/', '').split('');
      for (const color of [0, 1] as const) {
        const idx = JIEQI_SETUP_SQUARES[color]
          .map((s, i) => [s, color * 15 + i] as const)
          .filter(([s]) => a.board.sq[s] & jq.HIDDEN);
        const vals = idx.map(([, i]) => types[i]);
        vals.push(vals.shift()!); // xoay vòng
        idx.forEach(([, i], k) => (types[i] = vals[k]));
      }
      const setupB = `${types.slice(0, 15).join('')}/${types.slice(15).join('')}`;
      expect(isValidJieqiSetup(setupB)).toBe(true);
      const b = replayJieqi(setupB, a.history());
      const pub = replayJieqiPublic(a.history(), a.reveals());
      for (const x of [b, pub]) {
        expect(x.fen()).toBe(a.fen());
        expect(x.pieces()).toEqual(a.pieces());
        expect(x.pools()).toEqual(a.pools());
        expect(x.capturedPieces()).toEqual(a.capturedPieces());
        expect(x.historyInfo()).toEqual(a.historyInfo());
        expect(JSON.stringify(x.publicRecord())).toBe(JSON.stringify(a.publicRecord()));
        expect(x.status()).toEqual(a.status());
        expect(x.warnings()).toEqual(a.warnings());
        expect(x.inCheck()).toBe(a.inCheck());
        expect(x.legalMoves()).toEqual(a.legalMoves());
      }
      // Quân úp chỉ hiện loại gốc của ô; FEN chỉ có X/x cho quân úp
      for (const p of a.pieces().filter((q) => q.hidden)) {
        expect(p.type).toBe(jq.JQ_TYPE_LETTER[jq.START_TYPE[p.color][xqParseSquare(p.square)]]);
      }
      const hiddenOnBoard = a.pieces().filter((q) => q.hidden).length;
      const placement = a.fen().split(/[\s[]/)[0];
      expect((placement.match(/x/gi) ?? []).length).toBe(hiddenOnBoard);
    }
  });
});
