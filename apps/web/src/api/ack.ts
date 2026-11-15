import { ERROR_CODES } from '@cotuong/shared';

/** Mã lỗi (trong ack) khi không gửi được / không có trả lời: lỗi tạm thời, phân biệt với lỗi máy chủ trả về */
export const NETWORK_ACK_CODE = 'network';

/** Mã máy chủ dùng khi từ chối vì gửi sự kiện quá dồn dập (game.gateway.ts) */
const RATE_ACK_CODES = new Set<string>(['rate', ERROR_CODES.RATE_LIMITED]);

/** Lời nhắn máy chủ trả khi gặp lỗi không lường trước (không kèm mã) */
const SERVER_ERROR_MESSAGE = 'Lỗi hệ thống, vui lòng thử lại';

/**
 * Lỗi tạm thời khi gửi sự kiện realtime: thao tác quá nhanh, mất kết nối / hết thời gian chờ, máy chủ trục trặc, máy chủ
 * chưa nhận ra danh tính. Thử lại sau là được — khác với lỗi "thật" (phòng không còn, mã sai…).
 */
export function isTransientAck(r: { error: string; code?: string }): boolean {
  if (r.code === NETWORK_ACK_CODE || r.code === ERROR_CODES.NOT_AUTHENTICATED) return true;
  if (r.code !== undefined && RATE_ACK_CODES.has(r.code)) return true;
  return r.code === undefined && r.error === SERVER_ERROR_MESSAGE;
}
