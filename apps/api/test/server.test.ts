import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { coreManifests, coreNodes } from '@goblin/nodes-core';
import { MapRegistry, type WorkflowDocument } from '@goblin/spec';

import type { RunRecord, RunStreamMessage } from '../src/protocol.js';
import { createApi } from '../src/server.js';
import { FileActivationStore, FileRunStore, FileWorkflowStore } from '../src/stores.js';

/**
 * The API end to end, over real HTTP on a random local port: create a
 * workflow, run it, follow the live stream to the end, read the history.
 */

let dir: string;
let base: string;
let api: ReturnType<typeof createApi>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'goblin-api-'));
  api = createApi({
    workflows: new FileWorkflowStore(join(dir, 'workflows')),
    runs: new FileRunStore(join(dir, 'runs')),
    activations: new FileActivationStore(join(dir, 'activations.json')),
    registry: new MapRegistry(coreManifests),
    manifests: coreManifests,
    nodes: coreNodes,
  });
  await new Promise<void>((r) => api.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}/api`;
});

afterEach(async () => {
  await api.runs.settle();
  await new Promise((r) => api.server.close(r));
  await rm(dir, { recursive: true, force: true });
});

const json = (body: unknown, method = 'POST') => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

async function create(): Promise<WorkflowDocument> {
  const res = await fetch(`${base}/workflows`, json({ name: 'Greeter' }));
  expect(res.status).toBe(201);
  const doc = (await res.json()) as WorkflowDocument;
  // Wire the starter trigger to a Set box, the way the canvas would.
  return {
    ...doc,
    nodes: [
      { ...doc.nodes[0]!, config: { testInput: { name: 'world' } } },
      { id: 'greet', type: 'core.transform.set', typeVersion: 1, config: { values: { hello: '{{ $json.name }}' }, keepInput: false } },
    ],
    edges: [{ id: 'e1', from: { node: 'start', port: 'main' }, to: { node: 'greet', port: 'main' } }],
  };
}

/** Read a server-sent event stream until it ends. */
async function follow(runId: string): Promise<RunStreamMessage[]> {
  const res = await fetch(`${base}/runs/${runId}/events`);
  const text = await res.text();
  return text
    .split('\n\n')
    .filter((block) => block.startsWith('event:'))
    .map((block) => JSON.parse(block.split('\ndata: ')[1]!) as RunStreamMessage);
}

describe('the local API', () => {
  it('serves the box manifests the palette is built from', async () => {
    const manifests = (await (await fetch(`${base}/nodes`)).json()) as { type: string }[];
    expect(manifests.map((m) => m.type)).toContain('core.http.request');
  });

  it('runs a workflow, streams it, and keeps it in the history', async () => {
    const doc = await create();
    const started = await fetch(`${base}/workflows/${doc.id}/runs`, json({ document: doc }));
    expect(started.status).toBe(202);
    const { runId } = (await started.json()) as RunRecord;

    const messages = await follow(runId);
    const end = messages.at(-1);
    expect(end?.type).toBe('end');
    expect(end?.type === 'end' && end.record.status).toBe('succeeded');
    // The stream carried the journal, including the box that ran.
    const kinds = messages.flatMap((m) => (m.type === 'entries' ? m.entries.map((e) => e.kind) : []));
    expect(kinds).toContain('NodeRunSucceeded');

    // The trigger's test input was used, since the request gave none.
    const detail = (await (await fetch(`${base}/runs/${runId}`)).json()) as { journal: { kind: string; output?: { items: { data: unknown }[] } }[] };
    const completed = detail.journal.find((e) => e.kind === 'RunCompleted');
    expect(completed?.output?.items[0]?.data).toEqual({ hello: 'world' });

    const history = (await (await fetch(`${base}/workflows/${doc.id}/runs`)).json()) as RunRecord[];
    expect(history.map((r) => r.runId)).toEqual([runId]);
  });

  it('refuses to run a broken workflow and says exactly why', async () => {
    const doc = await create();
    const broken = { ...doc, edges: [{ id: 'e1', from: { node: 'start', port: 'nope' }, to: { node: 'greet', port: 'main' } }] };
    const res = await fetch(`${base}/workflows/${doc.id}/runs`, json({ document: broken }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { diagnostics: { code: string }[] };
    expect(body.diagnostics.map((d) => d.code)).toContain('PORT_MISMATCH');
  });

  it('turns away requests made by other websites', async () => {
    const res = await fetch(`${base}/workflows`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ name: 'x' }),
    });
    expect(res.status).toBe(403);
  });

  it('refuses a form post, which a browser could send cross-site without asking', async () => {
    const res = await fetch(`${base}/workflows`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{"name":"x"}',
    });
    expect(res.status).toBe(415);
  });
});
