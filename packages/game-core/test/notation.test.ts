import { describe, expect, it } from 'vitest';
import { XiangqiGame, xqFileNumberVi } from '../src';

/**
 * Ký hiệu nước đi cờ tướng kiểu Việt Nam (xem src/xiangqi/notation.ts).
 * Ví dụ lấy nguyên văn từ hai nguồn:
 *  - Wikipedia tiếng Việt "Cờ tướng", mục "Cách ghi nước đi" → Hệ thống 2
 *    (https://vi.wikipedia.org/wiki/C%E1%BB%9D_t%C6%B0%E1%BB%9Bng)
 *  - Bulletin Giải cờ tướng Các danh thủ quốc tế – Cúp Phương Trang lần VI (2023), Liên đoàn Cờ Việt Nam
 *    (https://vietnamchess.vn/document/2023/futa6-bulletin-full.pdf)
 */

/** Nhãn của nước `move` nếu đi ở thế hiện tại (không làm thay đổi ván) */
function labelOf(g: XiangqiGame, move: string): string {
  expect(g.play(move)).toBe(true);
  const label = g.historyInfo().at(-1)!.label;
  g.undo();
  return label;
}

/** Đi lần lượt các nước, trả về nhãn của từng nước */
function labels(moves: string[], fen?: string): string[] {
  const g = new XiangqiGame(fen);
  for (const m of moves) expect(g.play(m), m).toBe(true);
  return g.historyInfo().map((i) => i.label);
}

/**
 * Dựng lại cả ván chỉ từ biên bản ký hiệu Việt Nam: mỗi ký hiệu phải khớp ĐÚNG MỘT nước hợp lệ
 * (nhãn do game-core tạo ra trùng với nguyên văn của nguồn và không nhầm với nước nào khác).
 */
function replayRecord(record: string): XiangqiGame {
  const tokens = record
    .trim()
    .split(/\s+/)
    .filter((t) => !/^\d+\)$/.test(t));
  const g = new XiangqiGame();
  tokens.forEach((tok, i) => {
    const matches = g.legalMoves().filter((m) => labelOf(g, m) === tok);
    expect(matches, `nửa nước ${i + 1}: ${tok}`).toHaveLength(1);
    g.play(matches[0]);
  });
  expect(g.historyInfo().map((x) => x.label)).toEqual(tokens);
  return g;
}

describe('Ký hiệu Việt Nam – quy tắc cơ bản', () => {
  it('ví dụ của Wikipedia (Hệ thống 2): "1. P2–5 M8.7", "2. P8/1 B7.1"', () => {
    // Wikipedia viết dấu bình bằng gạch nối dài "–"; biên bản của Liên đoàn và giao diện dùng "-"
    expect(labels(['h2e2', 'h9g7', 'b2b1', 'g6g5'])).toEqual(['P2-5', 'M8.7', 'P8/1', 'B7.1']);
  });

  it('cột 1–9 đếm từ phải sang trái theo hướng nhìn của mỗi bên', () => {
    expect([0, 4, 8].map((f) => xqFileNumberVi(f, 0))).toEqual([9, 5, 1]); // Đỏ: cột a = 9, i = 1
    expect([0, 4, 8].map((f) => xqFileNumberVi(f, 1))).toEqual([1, 5, 9]); // Đen: cột a = 1, i = 9
    // Xe góc a của Đỏ là Xe 9, của Đen là Xe 1
    expect(labels(['a0a1', 'a9a8', 'i0i1', 'i9i8'])).toEqual(['X9.1', 'X1.1', 'X1.1', 'X9.1']);
    // Mã: Đỏ h0 (cột 2) lên g2 (cột 3); Đen b9 (cột 2) lên c7 (cột 3)
    expect(labels(['h0g2', 'b9c7'])).toEqual(['M2.3', 'M2.3']);
  });

  it('quân đi thẳng: tấn / thoái ghi số bước, bình ghi cột mới', () => {
    // Xe 1 tấn 1, Xe 1 thoái 1, Xe 1 bình 2 (Đỏ); Tướng 5 tấn 1, Tướng 5 bình 4
    expect(labels(['i0i1', 'a9a8', 'i1i0', 'a8a9', 'i0i1', 'a9a8', 'i1h1'])).toEqual([
      'X1.1',
      'X1.1',
      'X1/1',
      'X1/1',
      'X1.1',
      'X1.1',
      'X1-2',
    ]);
    expect(labels(['e0e1', 'f9f8', 'e1d1'], '5k3/9/9/9/9/9/9/9/9/4K4 w - - 0 1')).toEqual(['Tg5.1', 'Tg6.1', 'Tg5-6']);
    // Tốt qua sông đi ngang
    expect(labels(['e5d5'], '3k5/9/9/9/4P4/9/9/9/9/4K4 w - - 0 1')).toEqual(['B5-6']);
  });

  it('quân đi chéo (Mã, Tượng, Sĩ): ghi cột mới', () => {
    expect(labels(['g0e2', 'c9e7', 'f0e1', 'd9e8', 'b0c2', 'h9i7'])).toEqual(['T3.5', 'T3.5', 'S4.5', 'S4.5', 'M8.7', 'M8.9']);
    expect(labels(['g0e2', 'c9e7', 'e2g0', 'e7c9'])).toEqual(['T3.5', 'T3.5', 'T5/3', 'T5/3']);
  });

  it('không ghi dấu chiếu / ăn quân', () => {
    const g = new XiangqiGame('3k5/1R7/9/9/9/9/9/9/9/R3K4 w - - 0 1');
    expect(g.play('a0a9')).toBe(true);
    expect(g.historyInfo()[0]).toMatchObject({ label: 'X9.9', check: true });
    const h = new XiangqiGame();
    expect(h.play('h2h9')).toBe(true); // Pháo ăn Mã
    expect(h.historyInfo()[0]).toMatchObject({ label: 'P2.7', captured: true });
  });
});

describe('Ký hiệu Việt Nam – quân trước / quân sau', () => {
  it('hai Pháo cùng cột: Pt / Ps (trước = gần đối phương hơn, theo hướng của bên đi)', () => {
    // Đỏ: Pháo e4 (trước) và e2 (sau); Đen: Pháo e5 (trước) và e7 (sau)
    const fen = '3k5/9/4c4/9/4c4/4C4/9/4C4/9/5K3 w - - 0 1';
    const g = new XiangqiGame(fen);
    expect(labelOf(g, 'e4d4')).toBe('Pt-6');
    expect(labelOf(g, 'e2e3')).toBe('Ps.1');
    expect(labelOf(g, 'e2f2')).toBe('Ps-4');
    expect(labels(['e2e3', 'e7e6', 'e4d4', 'e5f5'], fen)).toEqual(['Ps.1', 'Ps.1', 'Pt-6', 'Pt-6']);
    // còn một Pháo trên cột thì ghi số cột như thường
    expect(labels(['e4d4', 'e5f5', 'e2e3', 'e7e6'], fen)).toEqual(['Pt-6', 'Pt-6', 'P5.1', 'P5.1']);
  });

  it('hai Xe / Mã cùng cột luôn ghi t / s, kể cả khi số cột không nhầm', () => {
    const g = new XiangqiGame('3k5/9/9/9/9/9/R8/9/R8/4K4 w - - 0 1');
    expect(labelOf(g, 'a3b3')).toBe('Xt-8');
    expect(labelOf(g, 'a1a2')).toBe('Xs.1');
    const h = new XiangqiGame('3k5/9/9/9/9/9/9/2H6/9/2H1K4 w - - 0 1');
    expect(labelOf(h, 'c2d4')).toBe('Mt.6');
    expect(labelOf(h, 'c0b2')).toBe('Ms.8');
  });

  it('hai Sĩ / Tượng cùng cột vẫn ghi số cột (không bao giờ nhầm)', () => {
    const g = new XiangqiGame('3k5/9/9/9/9/2B6/9/9/9/2B1K4 w - - 0 1');
    expect(labelOf(g, 'c4e2')).toBe('T7/5');
    expect(labelOf(g, 'c0a2')).toBe('T7.9');
    const h = new XiangqiGame('3k5/9/9/9/9/9/9/3A5/9/3AK4 w - - 0 1');
    expect(labelOf(h, 'd2e1')).toBe('S6/5');
    expect(labelOf(h, 'd0e1')).toBe('S6.5');
  });

  it('Tốt cùng cột: t / s khi số cột sẽ nhầm (cùng tiến), số cột khi chỉ một Tốt đi được như vậy', () => {
    // Tốt đỏ c6 (qua sông) và c4 (chưa qua sông)
    const g = new XiangqiGame('3k5/9/9/2P6/9/2P6/9/9/9/4K4 w - - 0 1');
    expect(labelOf(g, 'c6c7')).toBe('Bt.1');
    expect(labelOf(g, 'c4c5')).toBe('Bs.1');
    expect(labelOf(g, 'c6d6')).toBe('B7-6'); // Tốt c4 chưa qua sông, không đi ngang được
    // cả hai đã qua sông: đi ngang cũng phải phân biệt
    const h = new XiangqiGame('3k5/9/2P6/9/2P6/9/9/9/9/4K4 w - - 0 1');
    expect(labelOf(h, 'c7d7')).toBe('Bt-6');
    expect(labelOf(h, 'c5b5')).toBe('Bs-8');
  });

  it('chưa xác minh: ba Tốt cùng cột t / g / s; hai cột cùng có nhiều Tốt thêm số cột', () => {
    const g = new XiangqiGame('3k5/9/2P6/2P6/2P6/9/9/9/9/4K4 w - - 0 1');
    expect(labelOf(g, 'c7c8')).toBe('B7.1'); // hai Tốt sau bị chặn, không tiến được → không nhầm
    expect(labelOf(g, 'c7d7')).toBe('Bt-6');
    expect(labelOf(g, 'c6d6')).toBe('Bg-6');
    expect(labelOf(g, 'c5b5')).toBe('Bs-8');
    const h = new XiangqiGame('3k5/9/2P3P2/9/2P3P2/9/9/9/9/4K4 w - - 0 1');
    expect(labelOf(h, 'c7c8')).toBe('Bt7.1');
    expect(labelOf(h, 'g5g6')).toBe('Bs3.1');
  });
});

describe('Ký hiệu Việt Nam – dựng lại nguyên ván từ biên bản của Liên đoàn Cờ Việt Nam (bulletin FUTA 6, 2023)', () => {
  it('Bảng A, ván (1), vòng 1.1, 16.07.2023 (trang 25): Xt, Tg, hai Tượng cùng cột "T3/5"', () => {
    replayRecord(`
      1) B7.1 P2-3 2) P2-5 T3.5 3) P5.4 S4.5 4) T7.5 M2.4 5) P5/1 X1-2 6) M8.6 X9.1 7) M2.3 X9-6
      8) B3.1 M8.7 9) X1-2 X6.3 10) B5.1 M7.5 11) X2.3 B7.1 12) X9-8 B7.1 13) T5.3 P8-7 14)
      P8.3 X6.4 15) M6.5 X6/6 16) T3/5 B3.1 17) X2.3 X6.4 18) M3.2 X6/1 19) M2.3 X6-5 20) M3.5
      X5.1 21) M5.3 Tg5-4 22) P5-6 P3-4 23) B7.1 M5.6 24) X2-7 P7-5 25) X7.2 X5.1 26) S4.5 X5-7
      27) M3/5 Tg4-5 28) M5/4 M6.8 29) P6/4 P4-6 30) X7-6 X7.2 31) S5/4 X7-6 32) Tg5.1 M8.6
      33) Tg5.1 M6.7 34) S6.5 X6-2 35) P6.3 Xt/2 36) S5.6 Xt/1 37) S6/5 Xt-8 38) P6-5 P6-5 39)
      Tg5-6 M7/5 40) P5.2 M5.3 41) Tg6/1 M3/2 42) Tg6/1 X8.3 43) P5/6 X8/3 44) P5.3 M2/3 45)
      P5.3 M3.1`);
  });

  it('Bảng A, ván (7), vòng 3.1, 17.07.2023 (trang 26): Xs, Mt', () => {
    replayRecord(`
      1) P2-5 M8.7 2) M2.3 X9-8 3) X1-2 M2.3 4) B7.1 B7.1 5) X2.6 M7.6 6) M8.7 T7.5 7) B5.1
      B7.1 8) X2-4 M6.7 9) M3.5 P8.7 10) X9.1 P8-9 11) X9-3 X8.9 12) B5.1 P9-7 13) Tg5.1 X1.1
      14) B5.1 X1-8 15) P8/1 Xs.3 16) M5.4 M7/5 17) X4.2 S4.5 18) M4/5 Xs-2 19) P8-6 P2/1 20)
      X4/6 X2-4 21) M7.8 X4.2 22) B5.1 T3.5 23) X3.3 X4-5 24) Tg5-4 M5.3 25) P6-5 Mt.5 26)
      T7.5 X5-4 27) P5.6 Tg5-4 28) S4.5 X8/1 29) Tg4/1 P7-4`);
  });

  it('Bán kết 1, ván (1), 21.07.2023 (trang 46): Xt, Xs, Pt, Ps, Ms, Bt', () => {
    replayRecord(`
      1) P8-5 M2.3 2) M8.7 X1-2 3) X9-8 M8.7 4) B7.1 B7.1 5) M2.1 B9.1 6) P2-3 M7.8 7) X1.1
      T7.5 8) X1-4 X9.3 9) M7.6 S4.5 10) M6.4 P2.1 11) P3-4 B5.1 12) B5.1 X9-5 13) X4-6 B5.1 14)
      X8.3 B5-6 15) X8-6 P2.1 16) P5/1 P8/1 17) M4.6 P2/1 18) M6.7 P8-3 19) P4-5 P3-1 20) Xt.5
      P1.1 21) B7.1 B6.1 22) B7.1 P2.3 23) Ps.5 P2-5 24) S4.5 M3.5 25) Tg5-4 M8/7 26) B7-6 B6.1
      27) S5.4 P5-6 28) Tg4-5 M5.6 29) Xs.3 M6/7 30) Xs-4 P6-4 31) B6-5 P1-4 32) X4-6 Pt-5 33)
      Tg5-4 P5-6 34) Tg4-5 Ms.5 35) Xs.2 M5.6 36) M1/3 P6-5 37) Tg5-4 M6.5 38) T3.5 M7.5 39)
      Xs/1 M5/6 40) Xt-7 X2.6 41) X6-4 P5-9 42) M3.1 P9-8 43) X7/4 B9.1 44) S4/5 P8/5 45) Tg4-5
      B9.1 46) M1/2 P8-6 47) X4-6 X2-7 48) B9.1 B9-8 49) X7-2 P6-9 50) X2-1 P9-8 51) M2.1 B8.1
      52) M1.2 M6.8 53) X1.2 P8.4 54) X1-2 P8-5 55) X6-4 B8-7 56) X2-5 P5.1 57) X5-4 X7-9 58)
      Xs/2 X9.3 59) Xs/3 X9/1 60) Xs.3 P5/1 61) Xs-5 P5-8 62) X4/3 P8.4 63) X4-1 X9-8 64) X1/3
      Bt.1 65) X5-1 Bt.1 66) S5/4 X8-6`);
  });

  it('Chung kết, ván (1), 23.07.2023 (trang 52): Bt, Bs, Tốt cùng cột đi ngang "B7-6"', () => {
    replayRecord(`
      1) B7.1 P2-3 2) P2-5 T3.5 3) T7.9 M8.7 4) M2.3 B7.1 5) P8-6 M2.4 6) M8.7 X1-2 7) M7.6 X2.1
      8) X1-2 X9-8 9) X2.4 P8-9 10) X2.5 M7/8 11) X9.1 S4.5 12) X9-4 M8.7 13) X4.3 P9/1 14) X4.4
      P9.1 15) B5.1 B3.1 16) B7.1 X2.4 17) P6.6 X2-4 18) P6-9 T5.3 19) X4/5 P3-5 20) X4-8 P5.3
      21) S4.5 Tg5-4 22) M3.5 M7.6 23) P5.2 M6.5 24) X8-5 B5.1 25) X5-7 B5.1 26) X7.2 P9-5 27)
      X7-5 B5.1 28) P9-8 B5-6 29) T3.5 B6-7 30) T9.7 Bt.1 31) P8/7 X4.1 32) B1.1 Bs.1 33) Tg5-4
      X4-8 34) T5/3 X8-6 35) Tg4-5 X6-4 36) Tg5-4 X4-1 37) T7/5 X1-6 38) Tg4-5 X6-4 39) Tg5-4
      Bs.1 40) X5.1 B1.1 41) X5-1 B1.1 42) X1-5 B1-2 43) P8-9 B2.1 44) X5-8 X4-6 45) Tg4-5 B7-6
      46) X8.3 Tg4.1 47) X8/4 B6.1 48) X8-6 S5.4 49) X6-5 B2-3 50) B1.1 B7.1 51) B1-2 B7.1`);
  });
});
