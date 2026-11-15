import type { VisitRequest } from '@cotuong/shared';

/**
 * Đếm lượt xem trang cho bảng theo dõi của admin. Mỗi trình duyệt có một mã ngẫu nhiên (localStorage, không chứa thông
 * tin cá nhân) để đếm số người xem; server không lưu IP. Lỗi mạng / bị chặn thì bỏ qua, không ảnh hưởng người chơi.
 */
const VID_KEY = 'vc.vid';
const VID_RE = /^[A-Za-z0-9_-]{16,64}$/;
let memoryVid: string | null = null;

function newVid(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function visitorId(): string {
  try {
    const saved = localStorage.getItem(VID_KEY);
    if (saved && VID_RE.test(saved)) return saved;
    const id = newVid();
    localStorage.setItem(VID_KEY, id);
    return id;
  } catch {
    // Trình duyệt chặn bộ nhớ (chế độ riêng tư…): dùng mã tạm cho lần mở trang này
    return (memoryVid ??= newVid());
  }
}

let last = { path: '', at: 0 };

/** Gửi một lượt xem trang (gọi mỗi khi đường dẫn đổi) */
export function trackPageView(path: string): void {
  const now = Date.now();
  // Effect chạy hai lần (StrictMode khi dev) / chuyển trang lặp lại ngay: chỉ tính một lần
  if (path === last.path && now - last.at < 2_000) return;
  last = { path, at: now };
  const body: VisitRequest = { vid: visitorId(), path };
  try {
    void fetch('/api/analytics/visit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'same-origin',
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    /* bỏ qua */
  }
}
