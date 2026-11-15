import { findBestMove, resetAi, type AiRequest, type AiResponse } from './engine';

export type AiWorkerRequest =
  | { id: number; type: 'search'; request: Omit<AiRequest, 'random'> }
  | { id: number; type: 'reset' };

export type AiWorkerResponse = { id: number; ok: true; result: AiResponse | null } | { id: number; ok: false; error: string };

export interface AiWorkerScope {
  onmessage: ((ev: MessageEvent<AiWorkerRequest>) => void) | null;
  postMessage(msg: AiWorkerResponse): void;
}

/** Xử lý một yêu cầu (tách riêng để test không cần Worker thật) */
export function handleAiRequest(msg: AiWorkerRequest): AiWorkerResponse {
  try {
    if (msg.type === 'reset') {
      resetAi();
      return { id: msg.id, ok: true, result: null };
    }
    return { id: msg.id, ok: true, result: findBestMove(msg.request) };
  } catch (e) {
    return { id: msg.id, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Gắn bộ xử lý tin nhắn cho Web Worker. AI chạy trong worker để không làm đơ giao diện
 * và không tốn tài nguyên server.
 *
 * Trong file worker: `import { installAiWorker } from '@cotuong/ai'; installAiWorker(self);`
 */
export function installAiWorker(scope: AiWorkerScope): void {
  scope.onmessage = (ev: MessageEvent<AiWorkerRequest>) => {
    scope.postMessage(handleAiRequest(ev.data));
  };
}
