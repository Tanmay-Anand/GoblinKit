import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import type { WorkflowDocument } from '@goblin/spec';

import type { RunDetail, RunRecord } from '../src/protocol.js';

/**
 * The Stage 4 promise, tested the only honest way: start the real server, get
 * a run under way, kill the process outright — no shutdown, no warning, as a
 * closed window or a power cut would — start it again, and see the run finish.
 */

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const tsx = join(repo, 'node_modules', 'tsx', 'dist', 'cli.mjs');
let server: ChildProcess | undefined;
let workspace: string | undefined;

afterEach(async () => {
  server?.kill();
  if (workspace) await rm(workspace, { recursive: true, force: true });
});

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address() as { port: number };
  await new Promise((r) => s.close(r));
  return port;
}

async function startServer(port: number, dir: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, [tsx, 'apps/api/src/main.ts'], {
    cwd: repo,
    env: { ...process.env, GOBLIN_PORT: String(port), GOBLIN_WORKSPACE: dir },
    stdio: 'ignore',
  });
  await until(async () => (await fetch(`http://127.0.0.1:${port}/api/health`).catch(() => undefined))?.ok === true, 20_000);
  return child;
}

async function until(check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('Timed out waiting.');
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('a run in progress when GoblinKit is killed', () => {
  it('carries on from where it was when GoblinKit starts again', { timeout: 60_000 }, async () => {
    workspace = await mkdtemp(join(tmpdir(), 'goblin-durable-'));
    const port = await freePort();
    const base = `http://127.0.0.1:${port}/api`;
    const post = (path: string, body: unknown, method = 'POST') =>
      fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

    server = await startServer(port, workspace);

    // Start → Wait 3 s → Set. The kill lands during the Wait.
    const created = (await (await post('/workflows', { name: 'Survives a kill' })).json()) as WorkflowDocument;
    const doc: WorkflowDocument = {
      ...created,
      nodes: [
        { ...created.nodes[0]!, config: { testInput: { name: 'world' } } },
        { id: 'pause', type: 'core.wait', typeVersion: 1, config: { ms: 3000 } },
        { id: 'greet', type: 'core.transform.set', typeVersion: 1, config: { values: { greeting: 'Hello {{ $json.name }}' }, keepInput: false } },
      ],
      edges: [
        { id: 'e1', from: { node: 'start', port: 'main' }, to: { node: 'pause', port: 'main' } },
        { id: 'e2', from: { node: 'pause', port: 'main' }, to: { node: 'greet', port: 'main' } },
      ],
    };
    await post(`/workflows/${doc.id}`, doc, 'PUT');
    const { runId } = (await (await post(`/workflows/${doc.id}/runs`, {})).json()) as RunRecord;

    const detail = async () => (await (await fetch(`${base}/runs/${runId}`)).json()) as RunDetail;
    await until(async () => (await detail()).journal.some((e) => e.kind === 'TimerScheduled'), 10_000);

    // Pull the plug.
    server.kill('SIGKILL');
    await new Promise((r) => server!.once('exit', r));
    server = await startServer(port, workspace);

    await until(async () => (await detail()).record.finishedAt !== undefined, 15_000);
    const { record, journal } = await detail();
    expect(record.status).toBe('succeeded');
    expect(record.resumedAt).toBeDefined();
    expect(record.output?.items[0]?.data).toEqual({ greeting: 'Hello world' });
    // One run, continued — not a second run started over.
    expect(journal.filter((e) => e.kind === 'RunStarted')).toHaveLength(1);
    expect(journal.filter((e) => e.kind === 'NodeRunStarted' && e.nodeId === 'start')).toHaveLength(1);
  });
});
