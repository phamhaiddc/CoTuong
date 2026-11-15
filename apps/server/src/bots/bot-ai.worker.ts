/**
 * Luồng phụ (worker_threads) tính nước cho tài khoản máy, để việc tìm nước (mức Khó tới ~3 giây)
 * không chặn vòng lặp sự kiện của server.
 */
import { parentPort } from 'worker_threads';
import { handleAiRequest, type AiWorkerRequest } from '@cotuong/ai';

if (!parentPort) throw new Error('bot-ai.worker phải chạy trong worker_threads');
const port = parentPort;
port.on('message', (msg: AiWorkerRequest) => {
  port.postMessage(handleAiRequest(msg));
});
