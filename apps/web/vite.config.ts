import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const API = process.env.API_URL ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Dùng thẳng mã nguồn TypeScript của các package trong monorepo
      '@cotuong/game-core': src('../../packages/game-core/src/index.ts'),
      '@cotuong/shared': src('../../packages/shared/src/index.ts'),
      '@cotuong/ai': src('../../packages/ai/src/index.ts'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': API,
      '/socket.io': { target: API, ws: true },
    },
  },
  worker: { format: 'es' },
  // Không xuất source map: bản build phục vụ công khai sẽ lộ toàn bộ mã nguồn gốc
  build: { target: 'es2020', sourcemap: false },
});
