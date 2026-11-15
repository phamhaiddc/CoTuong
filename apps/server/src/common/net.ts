import { isIPv6 } from 'net';

/** IPv4 dạng ::ffff:a.b.c.d → a.b.c.d; ngược lại null */
function mappedIpv4(v: string): string | null {
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(v);
  return m ? m[1] : null;
}

/** IPv6 → `n` nhóm đầu (đã mở rộng "::", bỏ số 0 đứng đầu, chữ thường) */
function ipv6Prefix(v: string, n: number): string {
  const [head, tail = ''] = v.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = v.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
  return groups
    .slice(0, n)
    .map((g) => g.toLowerCase().replace(/^0+(?=.)/, ''))
    .join(':');
}

/**
 * Khoá giới hạn số lần theo IP: IPv4 giữ nguyên; IPv6 gộp theo dải /64 (một người thường có cả dải /64, nếu tính từng
 * địa chỉ thì họ có vô số "IP khác nhau" để vượt giới hạn). Địa chỉ IPv4 dạng ::ffff:a.b.c.d trả về a.b.c.d.
 */
export function ipBucket(ip: string | undefined | null): string {
  const v = (ip ?? '').trim();
  if (!v) return 'unknown';
  const mapped = mappedIpv4(v);
  if (mapped) return mapped;
  if (!isIPv6(v)) return v;
  return `${ipv6Prefix(v, 4)}::/64`;
}

/**
 * Khoá theo "mạng" cho các giới hạn dễ bị lạm dụng bằng nhiều IP (tạo khách, gửi thư, đăng nhập sai): IPv6 gộp theo
 * dải /48 (dải thường cấp cho MỘT khách hàng / máy chủ thuê — trong đó có 65.536 dải /64, tức 65.536 "IP" theo
 * ipBucket). IPv4 giữ nguyên địa chỉ: không gộp /24 vì nhiều nhà mạng cho rất nhiều người dùng chung một dải /24.
 * Dùng KÈM ipBucket (giới hạn riêng, cao hơn), không thay thế.
 */
export function ipNetBucket(ip: string | undefined | null): string {
  const v = (ip ?? '').trim();
  if (!v) return 'unknown';
  const mapped = mappedIpv4(v);
  if (mapped) return mapped;
  if (!isIPv6(v)) return v;
  return `${ipv6Prefix(v, 3)}::/48`;
}
