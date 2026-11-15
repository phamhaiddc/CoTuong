import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ERROR_CODES } from '@cotuong/shared';
import { AI_UNAVAILABLE_MESSAGE, AiClient } from '../src/ai/aiClient';
import { NETWORK_ACK_CODE, isTransientAck } from '../src/api/ack';
import { messageFor } from '../src/api/http';

describe('messageFor (tra lời nhắn theo mã trên đường dẫn)', () => {
  const table = { exchange: 'mặc định', denied: 'bị từ chối' };
  it('mã có trong bảng', () => {
    expect(messageFor(table, 'denied', table.exchange)).toBe('bị từ chối');
  });
  it('mã lạ và khoá của Object.prototype đều trả lời nhắn mặc định (chữ)', () => {
    for (const k of ['khong-co', '__proto__', 'constructor', 'valueOf', 'hasOwnProperty', 'toString']) {
      const m = messageFor(table, k, table.exchange);
      expect(typeof m).toBe('string');
      expect(m).toBe('mặc định');
    }
  });
});

describe('isTransientAck (lỗi tạm thời khi hỏi / vào phòng)', () => {
  it('lỗi tạm thời', () => {
    expect(isTransientAck({ error: 'Mất kết nối', code: NETWORK_ACK_CODE })).toBe(true);
    expect(isTransientAck({ error: 'Bạn thao tác quá nhanh', code: 'rate' })).toBe(true);
    expect(isTransientAck({ error: 'x', code: ERROR_CODES.RATE_LIMITED })).toBe(true);
    expect(isTransientAck({ error: 'Bạn cần đăng nhập', code: ERROR_CODES.NOT_AUTHENTICATED })).toBe(true);
    expect(isTransientAck({ error: 'Lỗi hệ thống, vui lòng thử lại' })).toBe(true);
  });
  it('phòng không còn / mã sai không phải lỗi tạm thời', () => {
    expect(isTransientAck({ error: 'Phòng này không còn nữa: có thể đã hết hạn' })).toBe(false);
    expect(isTransientAck({ error: 'Mã phòng gồm 6 chữ hoặc số' })).toBe(false);
    expect(isTransientAck({ error: 'Chủ phòng đang mất kết nối', code: ERROR_CODES.HOST_OFFLINE })).toBe(false);
  });
});

/** Worker giả: `mode` quyết định worker tải hỏng (onerror ngay) hay trả lời bình thường */
let mode: 'broken' | 'ok' = 'broken';
let created = 0;
class FakeWorker {
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: { message?: string; preventDefault?: () => void }) => void) | null = null;
  terminated = false;
  private readonly broken: boolean;
  constructor() {
    created++;
    this.broken = mode === 'broken';
    // Như trình duyệt: tệp worker không tải được thì báo lỗi sau một nhịp
    if (this.broken) setTimeout(() => !this.terminated && this.onerror?.({ preventDefault: () => undefined }), 0);
  }
  postMessage(msg: { id: number }): void {
    if (this.broken) return;
    setTimeout(() => !this.terminated && this.onmessage?.({ data: { id: msg.id, ok: true, result: { move: 'h2e2' } } }), 0);
  }
  terminate(): void {
    this.terminated = true;
  }
}
const tick = () => new Promise((r) => setTimeout(r, 5));
const req = { game: 'xiangqi', startFen: '', moves: [] } as unknown as Parameters<AiClient['search']>[0];

describe('AiClient (tệp worker không tải được)', () => {
  const g = globalThis as unknown as { Worker?: unknown };
  let prev: unknown;
  beforeEach(() => {
    prev = g.Worker;
    g.Worker = FakeWorker;
    created = 0;
  });
  afterEach(() => {
    g.Worker = prev;
  });

  it('không tạo lại worker liên tục; sau 3 lần hỏng thì báo cần tải lại trang', async () => {
    mode = 'broken';
    const ai = new AiClient();
    await tick();
    await tick();
    // Không có yêu cầu nào: hỏng một lần là dừng (không vòng lặp tạo → hỏng → tạo)
    expect(created).toBe(1);
    await expect(ai.search(req)).rejects.toThrow();
    expect(ai.unavailable).toBe(false);
    await expect(ai.search(req)).rejects.toThrow(AI_UNAVAILABLE_MESSAGE);
    expect(ai.unavailable).toBe(true);
    expect(created).toBe(3);
    // Sau đó trả lỗi ngay, không tạo thêm worker
    await expect(ai.search(req)).rejects.toThrow(AI_UNAVAILABLE_MESSAGE);
    ai.restart();
    await expect(ai.search(req)).rejects.toThrow(AI_UNAVAILABLE_MESSAGE);
    await tick();
    expect(created).toBe(3);
    ai.terminate();
  });

  it('worker hỏng một lần rồi tải được: vẫn chạy, đếm lỗi về 0', async () => {
    mode = 'broken';
    const ai = new AiClient();
    await tick();
    mode = 'ok';
    await expect(ai.search(req)).resolves.toEqual({ move: 'h2e2' });
    expect(ai.unavailable).toBe(false);
    expect(created).toBe(2);
    ai.terminate();
  });

  it('sau terminate() không tạo worker mới', async () => {
    mode = 'ok';
    const ai = new AiClient();
    ai.terminate();
    await expect(ai.search(req)).resolves.toBeNull();
    expect(created).toBe(1);
  });
});
