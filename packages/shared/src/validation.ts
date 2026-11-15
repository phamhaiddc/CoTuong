import { CUSTOM_TIME_LIMITS } from './constants';

export function normalizeUsername(name: string): string {
  return name.normalize('NFC').trim().replace(/\s+/g, ' ');
}

/**
 * Khoá so sánh để đảm bảo tên hiển thị là duy nhất: không phân biệt hoa thường, và gộp các dạng "tương thích"
 * (NFKC: chữ toàn khổ ａ → a…) để không ai lấy được tên trông y hệt người khác.
 */
export function usernameKey(name: string): string {
  return normalizeUsername(name).normalize('NFKC').toLocaleLowerCase('vi');
}

/**
 * Chữ cái được phép: a–z và các chữ có dấu của tiếng Việt (sau chuẩn hoá NFC), chữ Hán; số 0–9; _ . -
 * Không nhận chữ Latin "lạ" trông giống chữ thường (ı ɑ ɡ ʜ ǀ…), chữ Kirin / Hy Lạp — tránh giả mạo tên người khác.
 */
const VI_LOWER = 'àáâãèéêìíòóôõùúýăđĩũơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ';
const NAME_CHARS = `a-zA-Z0-9_.\\-${VI_LOWER}${VI_LOWER.toUpperCase()}\\p{Script=Han}`;
const USERNAME_RE = new RegExp(`^[${NAME_CHARS}]+( [${NAME_CHARS}]+)*$`, 'u');

export function validateUsername(name: unknown): string | null {
  if (typeof name !== 'string') return 'Thiếu tên hiển thị';
  const v = normalizeUsername(name);
  if (v.length < 3 || v.length > 20) return 'Tên hiển thị phải dài 3–20 ký tự';
  // Ký tự "vô hình" (vd U+3164 Hangul Filler vẫn được tính là chữ cái) → tên trống trên màn hình
  if (/\p{Default_Ignorable_Code_Point}/u.test(v) || !USERNAME_RE.test(v)) {
    return 'Tên hiển thị chỉ gồm chữ cái (tiếng Việt, chữ Hán), số 0–9, dấu cách và các ký tự _ . -';
  }
  return null;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Khoá "hộp thư" — CHỈ dùng cho giới hạn gửi thư (không dùng làm khoá tài khoản): gộp các biến thể về cùng một hộp
 * thư để không lách được giới hạn bằng ban+1@…, ban+2@… Bỏ phần "+nhãn" ở tên (đa số dịch vụ thư bỏ qua phần này);
 * riêng Gmail bỏ cả dấu chấm và coi googlemail.com là gmail.com. Gộp nhầm hai hộp thư khác nhau chỉ làm giới hạn
 * chặt hơn, không ảnh hưởng tài khoản.
 */
export function mailboxKey(email: string): string {
  const e = normalizeEmail(email);
  const at = e.lastIndexOf('@');
  if (at <= 0) return e;
  let local = e.slice(0, at);
  let domain = e.slice(at + 1);
  const plus = local.indexOf('+');
  if (plus > 0) local = local.slice(0, plus);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replace(/\./g, '') || local;
  return `${local}@${domain}`;
}

export function validateEmail(email: unknown): string | null {
  if (typeof email !== 'string' || !email.trim()) return 'Thiếu email';
  const v = normalizeEmail(email);
  // Chỉ nhận địa chỉ trần dạng a@b.c — không có tên hiển thị "Tên <a@b.c>", dấu ngoặc, dấu phẩy, chấm phẩy… (thư viện
  // gửi mail hiểu các dạng đó thành địa chỉ khác → một hộp thư có vô số tài khoản, lách giới hạn số thư)
  if (v.length > 254 || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(v)) return 'Email không hợp lệ';
  return null;
}

export function validatePassword(password: unknown): string | null {
  if (typeof password !== 'string') return 'Thiếu mật khẩu';
  if (password.length < 8) return 'Mật khẩu phải có ít nhất 8 ký tự';
  // bcrypt chỉ dùng 72 byte đầu
  if (utf8Length(password) > 72) return 'Mật khẩu quá dài (tối đa 72 byte)';
  return null;
}

function utf8Length(s: string): number {
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
}

export interface TimeControl {
  initialMs: number;
  incrementMs: number;
}

export function validateCustomTimeControl(minutes: unknown, incrementSec: unknown): string | null {
  if (typeof minutes !== 'number' || !Number.isInteger(minutes)) return 'Số phút không hợp lệ';
  if (typeof incrementSec !== 'number' || !Number.isInteger(incrementSec)) return 'Số giây cộng thêm không hợp lệ';
  if (minutes < CUSTOM_TIME_LIMITS.minMinutes || minutes > CUSTOM_TIME_LIMITS.maxMinutes) {
    return `Thời gian mỗi bên phải từ ${CUSTOM_TIME_LIMITS.minMinutes} đến ${CUSTOM_TIME_LIMITS.maxMinutes} phút`;
  }
  if (incrementSec < 0 || incrementSec > CUSTOM_TIME_LIMITS.maxIncrementSec) {
    return `Giây cộng thêm mỗi nước phải từ 0 đến ${CUSTOM_TIME_LIMITS.maxIncrementSec}`;
  }
  return null;
}

/** "15+10" = 15 phút mỗi bên + 10 giây mỗi nước */
export function formatTimeControl(tc: TimeControl | null | undefined): string {
  if (!tc) return 'Không giới hạn';
  const min = tc.initialMs / 60_000;
  const inc = tc.incrementMs / 1000;
  return `${Number.isInteger(min) ? min : min.toFixed(1)}+${inc}`;
}

export function parseTimeControl(s: string | null | undefined): TimeControl | null {
  if (!s) return null;
  const m = /^(\d+(?:\.\d+)?)\+(\d+)$/.exec(s);
  if (!m) return null;
  return { initialMs: Math.round(parseFloat(m[1]) * 60_000), incrementMs: parseInt(m[2], 10) * 1000 };
}
