/**
 * Tên miền dành riêng cho email của tài khoản máy chơi (botNN@bots.invalid). Tên miền .invalid không bao giờ nhận thư;
 * người dùng không được đăng ký / tạo tài khoản bằng email thuộc tên miền này (để không ai chiếm trước email của máy).
 */
export const BOT_EMAIL_DOMAIN = 'bots.invalid';

export function botEmail(n: number): string {
  return `bot${String(n).padStart(2, '0')}@${BOT_EMAIL_DOMAIN}`;
}

/** Tên miền dành riêng cho email nội bộ của tài khoản KHÁCH (guest-<uuid>@guests.invalid) — không ai đăng ký được */
export const GUEST_EMAIL_DOMAIN = 'guests.invalid';

/** Email (đã hoặc chưa chuẩn hoá) thuộc tên miền dành riêng cho máy hoặc cho khách */
export function isReservedBotEmail(email: string): boolean {
  const e = email.trim().toLowerCase();
  return e.endsWith(`@${BOT_EMAIL_DOMAIN}`) || e.endsWith(`@${GUEST_EMAIL_DOMAIN}`);
}

/**
 * Danh sách tài khoản máy (theo yêu cầu chủ sản phẩm 08/11/2026): mỗi loại tìm trận xếp hạng có 7 máy riêng —
 * cờ tướng 7 máy, cờ vua 7 máy; mỗi nhóm 3 máy mức Trung bình + 4 máy mức Khó. Máy chỉ được ghép đúng game của nó.
 * Tên là tên đặt ra (không phải người thật). `n` = số trong email botNN@bots.invalid (giữ cố định để seed không tạo trùng).
 */
export interface BotRosterEntry {
  n: number;
  username: string;
  game: 'xiangqi' | 'chess';
  level: 'medium' | 'hard';
}

export const BOT_ROSTER: readonly BotRosterEntry[] = [
  // Cờ tướng: 4 Khó + 3 Trung bình
  { n: 1, username: 'Tuấn Kiệt 92', game: 'xiangqi', level: 'hard' },
  { n: 3, username: 'haidang.dn', game: 'xiangqi', level: 'hard' },
  { n: 4, username: 'thanhtung.88', game: 'xiangqi', level: 'hard' },
  { n: 8, username: 'Hoàng Nam 87', game: 'xiangqi', level: 'hard' },
  { n: 2, username: 'minhquan_hn', game: 'xiangqi', level: 'medium' },
  { n: 6, username: 'Phúc Lâm', game: 'xiangqi', level: 'medium' },
  { n: 11, username: 'Văn Thắng 79', game: 'xiangqi', level: 'medium' },
  // Cờ vua: 4 Khó + 3 Trung bình
  { n: 5, username: 'Bảo Long 2k', game: 'chess', level: 'hard' },
  { n: 7, username: 'quochuy1990', game: 'chess', level: 'hard' },
  { n: 12, username: 'trungkien.hp', game: 'chess', level: 'hard' },
  { n: 13, username: 'Gia Huy 05', game: 'chess', level: 'hard' },
  { n: 9, username: 'duc_anh_hp', game: 'chess', level: 'medium' },
  { n: 10, username: 'ngoc.khanh', game: 'chess', level: 'medium' },
  { n: 14, username: 'lehoang_sg', game: 'chess', level: 'medium' },
];

/** Game của tài khoản máy theo email (null nếu email không có trong danh sách) */
export function botGameOfEmail(email: string): 'xiangqi' | 'chess' | null {
  const e = email.trim().toLowerCase();
  return BOT_ROSTER.find((b) => botEmail(b.n) === e)?.game ?? null;
}
