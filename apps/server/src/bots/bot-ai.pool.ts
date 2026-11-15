import type { Logger } from '@nestjs/common';
import { Worker } from 'worker_threads';
import type { AiRequest, AiResponse, AiWorkerRequest, AiWorkerResponse } from '@cotuong/ai';

export type BotSearchRequest = Omit<AiRequest, 'random'>;

interface Job {
  id: number;
  request: BotSearchRequest;
  /** Hạn chót (tính cả thời gian xếp hàng chờ luồng rảnh) */
  deadline: number;
  resolve: (r: AiResponse) => void;
  reject: (e: Error) => void;
}

interface Slot {
  worker: Worker | null;
  job: Job | null;
  timer: NodeJS.Timeout | null;
}

/**
 * Nhóm luồng phụ (worker_threads) tính nước cho tài khoản máy. Luồng được tạo khi cần; luồng treo quá hạn bị
 * dừng hẳn và tạo lại ở lần sau, luồng chết giữa chừng thì yêu cầu đang chạy bị từ chối (bên gọi đi nước dự phòng).
 */
export class BotAiPool {
  private readonly slots: Slot[];
  private readonly queue: Job[] = [];
  private nextId = 1;
  private closed = false;

  constructor(
    size: number,
    private readonly file: string,
    private readonly logger: Logger,
  ) {
    this.slots = Array.from({ length: Math.max(1, size) }, () => ({ worker: null, job: null, timer: null }));
  }

  search(request: BotSearchRequest, timeoutMs: number): Promise<AiResponse> {
    if (this.closed) return Promise.reject(new Error('Nhóm luồng AI đã đóng'));
    return new Promise<AiResponse>((resolve, reject) => {
      this.queue.push({ id: this.nextId++, request, deadline: Date.now() + timeoutMs, resolve, reject });
      this.dispatch();
    });
  }

  private dispatch(): void {
    if (this.closed) return;
    for (const slot of this.slots) {
      if (slot.job) continue;
      let job = this.queue.shift();
      while (job && job.deadline <= Date.now()) {
        job.reject(new Error('Hết thời gian chờ luồng AI rảnh'));
        job = this.queue.shift();
      }
      if (!job) return;
      this.run(slot, job);
    }
  }

  private run(slot: Slot, job: Job): void {
    // Việc phải xếp hàng chờ luồng rảnh thì chỉ còn phần thời gian còn lại: rút ngắn thời gian tìm nước cho vừa hạn
    // (không thì luồng bị dừng vì quá hạn và máy phải đi nước dự phòng)
    const left = job.deadline - Date.now() - 500;
    if (left < 300) {
      job.reject(new Error('Không còn đủ thời gian để tìm nước'));
      this.dispatch();
      return;
    }
    const cfgTime = job.request.config?.timeMs;
    job = { ...job, request: { ...job.request, config: { ...job.request.config, timeMs: Math.min(cfgTime ?? left, left) } } };
    let worker: Worker;
    try {
      worker = slot.worker ?? this.spawn(slot);
    } catch (e) {
      job.reject(e as Error);
      return;
    }
    slot.job = job;
    slot.timer = setTimeout(() => {
      this.logger.warn(`Luồng AI quá hạn (yêu cầu #${job.id}), dừng luồng`);
      this.finish(slot, null, new Error('Luồng AI quá hạn'));
      const w = slot.worker;
      slot.worker = null;
      if (w) void w.terminate().catch(() => undefined);
      this.dispatch();
    }, Math.max(1, job.deadline - Date.now()));
    const msg: AiWorkerRequest = { id: job.id, type: 'search', request: job.request };
    worker.postMessage(msg);
  }

  private spawn(slot: Slot): Worker {
    const w = new Worker(this.file);
    w.on('message', (res: AiWorkerResponse) => {
      if (slot.worker !== w || !slot.job || slot.job.id !== res.id) return;
      if (res.ok && res.result) this.finish(slot, res.result, null);
      else this.finish(slot, null, new Error(res.ok ? 'Luồng AI không trả nước đi' : res.error));
      this.dispatch();
    });
    w.on('error', (e) => {
      this.logger.warn(`Luồng AI lỗi: ${e.message}`);
      if (slot.worker !== w) return;
      slot.worker = null;
      this.finish(slot, null, e);
      this.dispatch();
    });
    w.on('exit', (code) => {
      if (slot.worker !== w) return;
      slot.worker = null;
      this.finish(slot, null, new Error(`Luồng AI dừng (mã ${code})`));
      this.dispatch();
    });
    slot.worker = w;
    return w;
  }

  private finish(slot: Slot, result: AiResponse | null, error: Error | null): void {
    const job = slot.job;
    slot.job = null;
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = null;
    if (!job) return;
    if (error || !result) job.reject(error ?? new Error('Luồng AI không trả kết quả'));
    else job.resolve(result);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const job of this.queue.splice(0)) job.reject(new Error('Nhóm luồng AI đã đóng'));
    await Promise.all(
      this.slots.map(async (slot) => {
        this.finish(slot, null, new Error('Nhóm luồng AI đã đóng'));
        const w = slot.worker;
        slot.worker = null;
        if (w) await w.terminate().catch(() => undefined);
      }),
    );
  }
}
