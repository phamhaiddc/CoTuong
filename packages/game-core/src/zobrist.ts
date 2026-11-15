/**
 * Bộ sinh số ngẫu nhiên có seed (mulberry32) để khoá Zobrist giống nhau trên
 * trình duyệt và server.
 */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) | 0;
  };
}

/** Tạo bảng khoá [piece][square] gồm 2 nửa 32-bit (lo, hi). */
export function zobristTable(pieces: number, squares: number, seed: number): { lo: Int32Array; hi: Int32Array } {
  const rnd = seededRandom(seed);
  const lo = new Int32Array(pieces * squares);
  const hi = new Int32Array(pieces * squares);
  for (let i = 0; i < lo.length; i++) {
    lo[i] = rnd();
    hi[i] = rnd();
  }
  return { lo, hi };
}
