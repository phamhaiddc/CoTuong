import { io, type Socket } from 'socket.io-client';
import type { Ack, ClientToServerEvents, ServerToClientEvents } from '@cotuong/shared';
import { NETWORK_ACK_CODE } from './ack';

export type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/** Một kết nối Socket.IO dùng chung cho cả ứng dụng (cookie phiên gửi kèm vì cùng origin) */
export const socket: AppSocket = io({
  path: '/socket.io',
  transports: ['websocket', 'polling'],
  autoConnect: true,
  withCredentials: true,
});

/*
 * Tự kết nối lại trong hai trường hợp socket.io KHÔNG tự làm:
 *  - máy chủ chủ động ngắt ("io server disconnect"): đăng xuất ở tab khác, đặt lại mật khẩu, tài khoản bị khoá…
 *    Kết nối lại bằng cookie hiện tại (còn phiên thì vẫn là người đó, hết phiên thì thành chưa đăng nhập) — khi kết nối
 *    lại, RealtimeProvider tải lại thông tin tài khoản nên giao diện theo đúng máy chủ.
 *  - máy chủ từ chối lúc bắt tay (connect_error từ middleware, vd. Redis / Postgres trục trặc trong chốc lát): socket.io
 *    huỷ socket và không thử lại nữa.
 * Chờ lâu dần giữa các lần thử; thử ngay khi máy có mạng trở lại hoặc người dùng quay lại trang.
 */
const RETRY_DELAYS_MS = [500, 2_000, 5_000, 10_000, 30_000];
/** Kết nối giữ được chừng này thì coi như ổn định: lần trục trặc sau lại bắt đầu chờ ngắn */
const STABLE_MS = 15_000;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let stableTimer: ReturnType<typeof setTimeout> | null = null;
let retries = 0;

function clearRetry(): void {
  if (retryTimer !== null) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}

function scheduleRetry(delayMs?: number): void {
  // Đã hẹn rồi, hoặc socket.io đang tự kết nối lại (socket.active) / đã kết nối: không làm gì
  if (retryTimer !== null || socket.connected || socket.active) return;
  const delay = delayMs ?? RETRY_DELAYS_MS[Math.min(retries, RETRY_DELAYS_MS.length - 1)];
  retries++;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (!socket.connected && !socket.active) socket.connect();
  }, delay);
}

socket.on('connect', () => {
  clearRetry();
  if (stableTimer !== null) clearTimeout(stableTimer);
  stableTimer = setTimeout(() => {
    stableTimer = null;
    retries = 0;
  }, STABLE_MS);
});
socket.on('disconnect', (reason) => {
  if (stableTimer !== null) {
    clearTimeout(stableTimer);
    stableTimer = null;
  }
  if (reason === 'io server disconnect') scheduleRetry();
});
socket.on('connect_error', () => {
  // socket.active = true: socket.io tự thử lại (lỗi mạng thông thường); false: bị máy chủ từ chối → tự hẹn
  if (!socket.active) scheduleRetry();
});
// Máy chủ hỏi "tab này còn đó không" (tab khác của mình muốn vào ván mà tab này đang giữ ghế): trả lời ngay. Không trả
// lời (kết nối đã treo sau khi đổi mạng…) thì máy chủ chuyển ghế sang kết nối mới.
socket.on('conn:probe', (ack) => {
  if (typeof ack === 'function') ack(true);
});

function retryNow(): void {
  if (retryTimer === null) return;
  clearRetry();
  scheduleRetry(0);
}
if (typeof window !== 'undefined') {
  window.addEventListener('online', retryNow);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') retryNow();
  });
}

/** Kết nối lại để server nhận phiên đăng nhập mới (sau đăng nhập / đăng xuất) */
export function reconnectSocket(): void {
  clearRetry();
  socket.disconnect();
  socket.connect();
}

type Payload<E extends keyof ClientToServerEvents> = Parameters<ClientToServerEvents[E]>[0];
type AckData<E extends keyof ClientToServerEvents> =
  Parameters<ClientToServerEvents[E]>[1] extends (res: infer R) => void ? R : never;

/** Gửi sự kiện và chờ phản hồi (ack); lỗi mạng / quá thời gian trả về { ok: false, code: 'network' } */
export async function emit<E extends keyof ClientToServerEvents>(
  event: E,
  payload: Payload<E>,
  timeoutMs = 10_000,
): Promise<AckData<E>> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (await (socket.timeout(timeoutMs) as any).emitWithAck(event, payload)) as AckData<E>;
  } catch {
    return { ok: false, error: 'Mất kết nối tới máy chủ, vui lòng thử lại', code: NETWORK_ACK_CODE } as Ack as AckData<E>;
  }
}
