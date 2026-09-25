import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const at = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Overridable so the end-to-end tests can run their own pair of servers next
// to a `pnpm dev` you already have open, without the two fighting over ports.
const webPort = Number(process.env['GOBLIN_WEB_PORT'] ?? 5173);
const apiPort = Number(process.env['GOBLIN_API_PORT'] ?? 8787);

/**
 * The canvas dev server. `/api` is proxied to the local GoblinKit server, so
 * the browser only ever talks to one origin.
 */
export default defineConfig({
  root: at('.'),
  plugins: [react()],
  resolve: {
    alias: {
      '@goblin/spec': at('../../packages/spec/src/index.ts'),
      '@goblin/graph': at('../../packages/graph/src/index.ts'),
      '@goblin/expressions': at('../../packages/expressions/src/index.ts'),
      '@goblin/runtime': at('../../packages/runtime/src/index.ts'),
      '@goblin/editor': at('../../packages/editor/src/index.ts'),
      '@goblin/api/protocol': at('../api/src/protocol.ts'),
    },
  },
  server: {
    host: '127.0.0.1',
    port: webPort,
    strictPort: true,
    proxy: { '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false } },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Served from this machine, not over the internet: one ~500 kB bundle
    // (React + React Flow) loads instantly, and splitting it buys nothing.
    chunkSizeWarningLimit: 800,
  },
});
