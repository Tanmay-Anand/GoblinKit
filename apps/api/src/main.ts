/**
 * Start the local GoblinKit server.
 *
 *   GOBLIN_PORT        port to listen on (default 8787)
 *   GOBLIN_WORKSPACE   folder for workflows and runs (default ./workspace)
 *
 * It listens on 127.0.0.1 only. Local mode has no login, so it must never be
 * reachable from the network.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { coreManifests, coreNodes } from '@goblin/nodes-core';
import { MapRegistry, type WorkflowDocument } from '@goblin/spec';

import { LOCAL_TENANT } from './protocol.js';
import { createApi } from './server.js';
import { FileActivationStore, FileRunStore, FileWorkflowStore, type WorkflowStore } from './stores.js';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const port = Number(process.env['GOBLIN_PORT'] ?? 8787);
const workspace = resolve(process.env['GOBLIN_WORKSPACE'] ?? join(repo, 'workspace'));
const webDist = join(repo, 'apps', 'web', 'dist');

const workflows = new FileWorkflowStore(join(workspace, 'workflows'));
const runStore = new FileRunStore(join(workspace, 'runs'));
const activations = new FileActivationStore(join(workspace, 'activations.json'));

await seed(workflows);

const { server, runs, triggers } = createApi({
  workflows,
  runs: runStore,
  activations,
  hooksBase: `http://127.0.0.1:${port}`,
  registry: new MapRegistry(coreManifests),
  manifests: coreManifests,
  nodes: coreNodes,
  ...(existsSync(webDist) ? { staticDir: webDist } : {}),
  allowedOrigins: ['http://localhost:5173', 'http://127.0.0.1:5173'],
});

// Runs that were under way when GoblinKit last stopped carry on from their
// journals; then switched-on workflows start listening and ticking again.
const resumed = await runs.resumeUnfinished();
await triggers.start();

server.listen(port, '127.0.0.1', () => {
  console.log(`GoblinKit local server on http://127.0.0.1:${port}  (workspace: ${workspace})`);
  if (resumed.length) console.log(`Resumed ${resumed.length} run${resumed.length === 1 ? '' : 's'} left unfinished last time.`);
});

const shutdown = () => {
  triggers.stop();
  server.close();
  // No need to wait for runs to finish: every step is already on disk, and
  // they resume on the next start. A moment lets the last appends land.
  setTimeout(() => process.exit(0), 300);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

/**
 * A first start gets the order-triage example, so the canvas opens on
 * something that runs.
 *
 * The CLI example was drawn left to right; the canvas flows top to bottom,
 * so its positions are turned a quarter and spaced for card-sized boxes.
 */
async function seed(store: WorkflowStore): Promise<void> {
  if ((await store.list()).length > 0) return;
  const example = JSON.parse(await readFile(join(repo, 'examples', 'order-triage.json'), 'utf8')) as WorkflowDocument;
  await store.put({
    ...example,
    tenantId: LOCAL_TENANT,
    nodes: example.nodes.map((node) => {
      const p = node.ui?.position ?? { x: 0, y: 0 };
      const config =
        node.type === 'core.trigger.manual'
          ? {
              ...node.config,
              testInput: {
                total: 250,
                lines: [
                  { sku: 'A-1140', qty: 2, price: 30 },
                  { sku: 'B-0072', qty: 1, price: 190 },
                ],
              },
            }
          : node.config;
      return { ...node, config, ui: { ...node.ui, position: { x: p.y * 3.2, y: p.x * 0.78 } } };
    }),
  });
}
