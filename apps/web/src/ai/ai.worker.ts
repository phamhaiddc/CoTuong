/// <reference lib="webworker" />
import { installAiWorker, type AiWorkerScope } from '@cotuong/ai';

// AI chạy trong Web Worker để không làm đơ giao diện
installAiWorker(self as unknown as AiWorkerScope);
