import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const pkg = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@goblin/spec': pkg('spec'),
      '@goblin/graph': pkg('graph'),
      '@goblin/expressions': pkg('expressions'),
      '@goblin/runtime': pkg('runtime'),
      '@goblin/node-sdk': pkg('node-sdk'),
      '@goblin/nodes-core': pkg('nodes-core'),
      '@goblin/drivers-inprocess': pkg('drivers-inprocess'),
    },
  },
  test: { include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'] },
});
