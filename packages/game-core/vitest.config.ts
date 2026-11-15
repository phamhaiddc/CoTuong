import { defineConfig } from 'vitest/config';

// Một số test (perft, ván ngẫu nhiên cờ úp, dựng lại biên bản) mất 1–3 giây; khi máy đang bận (build / test song song)
// dễ vượt hạn mặc định 5 giây của vitest dù không có lỗi — nới hạn mỗi test lên 30 giây
export default defineConfig({
  test: {
    testTimeout: 30_000,
  },
});
