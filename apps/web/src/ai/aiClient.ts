import type { AiRequest, AiResponse, AiWorkerRequest, AiWorkerResponse } from '@cotuong/ai';

type Pending = { resolve: (r: AiResponse | null) => void; reject: (e: Error) => void };
/** Omit phân phối trên từng nhánh của union */
type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never;

/**
 * Worker hỏng liên tiếp chừng này lần mà chưa trả lời được lần nào thì thôi tạo lại. Thường là do Xe Pháo Mã vừa được cập
 * nhật: tệp worker cũ (tên có mã băm) không còn trên máy chủ, tạo lại bao nhiêu lần cũng hỏng — chỉ gửi yêu cầu vô ích
 * liên tục tới máy chủ.
 */
const MAX_CRASHES = 3;

/** Lời báo khi máy cờ không tải được nữa (cần tải lại trang) */
export const AI_UNAVAILABLE_MESSAGE = 'Không tải được máy cờ, có thể Xe Pháo Mã vừa được cập nhật. Bạn tải lại trang nhé.';

/** Bọc Web Worker của AI thành API dạng Promise */
export class AiClient {
  /** null = chưa có / vừa hỏng: lần gửi sau mới tạo worker mới (không tạo lại ngay trong onerror) */
  private worker: Worker | null;
  private seq = 0;
  private readonly pending = new Map<number, Pending>();
  /** Số lần hỏng liên tiếp kể từ lần trả lời thành công gần nhất */
  private crashes = 0;
  /** Đã thôi tạo lại worker (xem MAX_CRASHES) */
  private dead = false;
  /** Đã terminate() (trang đóng): không tạo worker nào nữa */
  private closed = false;

  constructor() {
    this.worker = this.spawn();
  }

  /** true khi máy cờ không dùng được nữa trong trang này — người chơi cần tải lại trang */
  get unavailable(): boolean {
    return this.dead;
  }

  private crashed(): void {
    this.crashes++;
    if (this.crashes >= MAX_CRASHES) this.dead = true;
  }

  private spawn(): Worker | null {
    if (this.dead || this.closed) return null;
    let w: Worker;
    try {
      w = new Worker(new URL('./ai.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      this.crashed();
      return null;
    }
    w.onmessage = (ev: MessageEvent<AiWorkerResponse>) => {
      this.crashes = 0;
      const msg = ev.data;
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error));
    };
    w.onerror = (e) => {
      // Worker cũ (đã bị thay khi chơi lại): các yêu cầu của nó đã được trả lời lúc thay
      if (this.worker !== w) return;
      e.preventDefault?.();
      w.terminate();
      this.worker = null;
      this.crashed();
      const err = new Error(this.dead ? AI_UNAVAILABLE_MESSAGE : (e as ErrorEvent).message || 'AI gặp lỗi');
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      // KHÔNG tạo worker mới ở đây: tệp worker không tải được (vd. sau khi cập nhật) thì tạo → hỏng → tạo… liên tục.
      // Lần gửi sau (máy đi nước tiếp, bấm Thử lại) mới tạo lại — tối đa MAX_CRASHES lần.
    };
    return w;
  }

  private send(msg: WithoutId<AiWorkerRequest>): Promise<AiResponse | null> {
    if (this.closed) return Promise.resolve(null);
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.worker ??= this.spawn();
      const w = this.worker;
      if (!w) {
        reject(new Error(AI_UNAVAILABLE_MESSAGE));
        return;
      }
      this.pending.set(id, { resolve, reject });
      w.postMessage({ ...msg, id } as AiWorkerRequest);
    });
  }

  search(request: Omit<AiRequest, 'random'>): Promise<AiResponse | null> {
    return this.send({ type: 'search', request });
  }

  /** Huỷ mọi tìm kiếm đang chạy (dùng khi chơi lại) */
  restart(): void {
    this.worker?.terminate();
    for (const p of this.pending.values()) p.resolve(null);
    this.pending.clear();
    this.worker = this.spawn();
  }

  terminate(): void {
    this.closed = true;
    this.worker?.terminate();
    this.worker = null;
    for (const p of this.pending.values()) p.resolve(null);
    this.pending.clear();
  }
}
