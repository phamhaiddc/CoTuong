import { ADVISOR, PAWN } from '../xiangqi/board';
import { JIEQI_SETUP_SQUARES, JQ_INITIAL_COUNT, JQ_LETTER_TYPE } from './board';

/**
 * Chuỗi xếp quân Cờ úp ("setup") — xác định đầy đủ danh tính 30 quân úp của thế bắt đầu.
 * Đây là BÍ MẬT: server giữ kín cho tới khi ván kết thúc (lưu ở cột `matches.setup`).
 *
 * Định dạng: đúng 31 ký tự `<15 chữ của Đỏ>/<15 chữ của Đen>`.
 * Chữ thứ i của mỗi nửa là loại thật của quân úp đứng ở ô thứ i của bên đó (JIEQI_SETUP_SQUARES):
 *   Đỏ:  a0 b0 c0 d0 f0 g0 h0 i0 b2 h2 a3 c3 e3 g3 i3
 *   Đen: a9 b9 c9 d9 f9 g9 h9 i9 b7 h7 a6 c6 e6 g6 i6
 * (hàng cuối, hàng pháo, hàng tốt tính từ phía bên đó; mỗi hàng cột a → i; bỏ ô Tướng).
 * Chữ cái là ký hiệu loại quân cờ tướng của game-core, chữ thường:
 *   r = Xe, h = Mã, e = Tượng, a = Sĩ, c = Pháo, p = Tốt.
 * Mỗi nửa có đúng 2 r, 2 h, 2 e, 2 a, 2 c và 5 p. Không có khoảng trắng, không phân biệt gì thêm.
 *
 * Ví dụ: xếp y như cờ tướng thường = "rheaaehrccppppp/rheaaehrccppppp" (JIEQI_STANDARD_SETUP);
 * "crheaaehrcppppp/..." nghĩa là quân úp ở a0 của Đỏ là Pháo, ở b0 là Xe, v.v.
 */
export const JIEQI_STANDARD_SETUP = 'rheaaehrccppppp/rheaaehrccppppp';

const SETUP_RE = /^[rheacp]{15}\/[rheacp]{15}$/;

/** Kiểm tra chuỗi xếp quân. Trả về thông báo lỗi (tiếng Việt) hoặc null nếu hợp lệ. */
export function validateJieqiSetup(setup: unknown): string | null {
  if (typeof setup !== 'string') return 'Thiếu chuỗi xếp quân cờ úp';
  if (!SETUP_RE.test(setup)) return 'Chuỗi xếp quân cờ úp sai định dạng';
  for (const half of setup.split('/')) {
    const n = [0, 0, 0, 0, 0, 0, 0, 0];
    for (const ch of half) n[JQ_LETTER_TYPE[ch]]++;
    for (let t = ADVISOR; t <= PAWN; t++) {
      if (n[t] !== JQ_INITIAL_COUNT[t]) return 'Chuỗi xếp quân cờ úp sai số lượng quân';
    }
  }
  return null;
}

export function isValidJieqiSetup(setup: unknown): setup is string {
  return validateJieqiSetup(setup) === null;
}

/**
 * Đọc chuỗi xếp quân thành bảng loại quân theo ô: kết quả[ô] = loại thật (mã loại của game-core,
 * ADVISOR..PAWN) của quân úp ở ô xuất phát đó, 0 ở các ô khác. Ném lỗi nếu chuỗi không hợp lệ.
 */
export function parseJieqiSetup(setup: string): Int8Array {
  const err = validateJieqiSetup(setup);
  if (err) throw new Error(err);
  const out = new Int8Array(90);
  const halves = setup.split('/');
  for (let color = 0; color < 2; color++) {
    const squares = JIEQI_SETUP_SQUARES[color];
    for (let i = 0; i < 15; i++) out[squares[i]] = JQ_LETTER_TYPE[halves[color][i]];
  }
  return out;
}

interface CryptoLike {
  getRandomValues(a: Uint32Array): Uint32Array;
}

/** Số ngẫu nhiên [0, 1) — dùng crypto.getRandomValues nếu có (Node ≥ 19, trình duyệt, Web Worker) */
function defaultRandom(): number {
  const c = (globalThis as { crypto?: Partial<CryptoLike> }).crypto;
  if (c && typeof c.getRandomValues === 'function') {
    const a = new Uint32Array(1);
    c.getRandomValues(a);
    return a[0] / 4294967296;
  }
  return Math.random();
}

/** Chỉ số ngẫu nhiên 0..n-1 từ rng() trong [0, 1) (an toàn với giá trị biên / không hợp lệ) */
function randomIndex(rng: () => number, n: number): number {
  const x = rng();
  const v = Math.floor((Number.isFinite(x) ? x : 0) * n);
  return v < 0 ? 0 : v >= n ? n - 1 : v;
}

/**
 * Tạo chuỗi xếp quân ngẫu nhiên: mỗi bên xáo đều (Fisher–Yates) 15 quân của mình trên 15 ô xuất phát.
 * `rng` trả về số trong [0, 1); mặc định dùng crypto.getRandomValues (khó đoán), có thể truyền vào
 * hàm có seed để test.
 */
export function randomJieqiSetup(rng: () => number = defaultRandom): string {
  const half = (): string => {
    const a = 'rrhheeaaccppppp'.split('');
    for (let i = a.length - 1; i > 0; i--) {
      const j = randomIndex(rng, i + 1);
      const t = a[i];
      a[i] = a[j];
      a[j] = t;
    }
    return a.join('');
  };
  const red = half();
  const black = half();
  return `${red}/${black}`;
}
