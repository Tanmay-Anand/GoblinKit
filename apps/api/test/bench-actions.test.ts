import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { InMemoryStateStore, MockHttp } from '@goblin/node-sdk';
import { MapRegistry, type WorkflowDocument } from '@goblin/spec';

import { MemoryAuditLog } from '../src/audit.js';
import { credentialTypes, manifests, nodes } from '../src/packs.js';
import type { ActionResult, RunRecord } from '../src/protocol.js';
import { createApi } from '../src/server.js';
import { FileActivationStore, FileRunStore, FileWorkflowStore } from '../src/stores.js';

/**
 * The endpoint-latency example through the real API: runs, the report as a
 * download, and "Accept as baseline" — which only a person in the run view
 * can do, never a webhook.
 */

const BASE = 'http://dev.stub';
let dir: string;
let origin: string;
let api: ReturnType<typeof createApi>;
let http: MockHttp;
let state: InMemoryStateStore;
let audit: MemoryAuditLog;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'goblin-bench-'));
  http = new MockHttp();
  http.mock(`GET ${BASE}/*`).reply(200, { rows: [1, 2, 3] }, { ttfbMs: 20, totalMs: 100 });
  state = new InMemoryStateStore();
  audit = new MemoryAuditLog();
  api = createApi({
    workflows: new FileWorkflowStore(join(dir, 'workflows')),
    runs: new FileRunStore(join(dir, 'runs')),
    activations: new FileActivationStore(join(dir, 'activations.json')),
    registry: new MapRegistry(manifests),
    manifests,
    nodes,
    credentialTypes,
    state,
    audit,
    http: http.client(),
    hooksBase: 'http://127.0.0.1:0',
  });
  await new Promise<void>((r) => api.server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  api.triggers.stop();
  await api.runs.settle();
  await new Promise((r) => api.server.close(r));
  await rm(dir, { recursive: true, force: true });
});

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
});

async function importExample(): Promise<WorkflowDocument> {
  const path = fileURLToPath(new URL('../../../examples/endpoint-latency.json', import.meta.url));
  const example = JSON.parse(await readFile(path, 'utf8')) as WorkflowDocument;
  const res = await fetch(`${origin}/api/workflows`, json('POST', { document: { ...example, variables: { ...example.variables, baseUrl: BASE } } }));
  expect(res.status).toBe(201);
  return (await res.json()) as WorkflowDocument;
}

async function runAndWait(id: string): Promise<RunRecord> {
  const record = (await (await fetch(`${origin}/api/workflows/${id}/runs`, json('POST', {}))).json()) as RunRecord;
  const done = await api.runs.waitFor(record.runId, 10_000);
  expect(done?.status).toBe('succeeded');
  return done!;
}

const baselineOf = async (workflowId: string, key: string) => (await state.get(workflowId, 'baseline', key))?.value as { medianMs: number; accepted?: boolean } | undefined;

describe('Accept as baseline', () => {
  it('makes a regressed run’s numbers the baseline, from what it recorded, without measuring again', async () => {
    const doc = await importExample();
    await runAndWait(doc.id);
    expect(await baselineOf(doc.id, 'baseline:projects:new@' + BASE)).toMatchObject({ medianMs: 100 });

    // The new endpoint now does more work on purpose: 300 ms, every time.
    http.mock(`GET ${BASE}/platform/projects/autocomplete?limit=20`).reply(200, { items: [] }, { totalMs: 300 });
    const regressed = await runAndWait(doc.id);
    expect(regressed.output?.items.map((i) => i.data)).toContainEqual(expect.objectContaining({ summary: '15 targets: 1 regression (projects/new)' }));
    // A regression leaves the baseline where it was.
    expect(await baselineOf(doc.id, 'baseline:projects:new@' + BASE)).toMatchObject({ medianMs: 100 });

    const calls = http.calls.length;
    const res = await fetch(`${origin}/api/runs/${regressed.runId}/nodes/baseline/actions/acceptBaseline`, json('POST', {}));
    expect(res.status).toBe(200);
    expect((await res.json()) as ActionResult).toEqual({ message: 'This run’s numbers are now the baseline for 15 endpoints.', conflicts: [] });
    expect(http.calls.length).toBe(calls); // nothing was measured
    expect(await baselineOf(doc.id, 'baseline:projects:new@' + BASE)).toMatchObject({ medianMs: 300, accepted: true });
    expect(audit.events.at(-1)).toMatchObject({ action: 'box.acceptBaseline', subject: `${doc.id}/baseline` });

    // And the next run at 300 ms is normal again.
    const after = await runAndWait(doc.id);
    expect(after.output?.items.map((i) => i.data)).toContainEqual(expect.objectContaining({ summary: '15 targets: no regressions' }));
  });

  it('cannot be done by a webhook: a deploy calling with "accept" in its body still gets its regression', async () => {
    const doc = await importExample();
    await runAndWait(doc.id);
    http.mock(`GET ${BASE}/platform/projects/autocomplete?limit=20`).reply(200, { items: [] }, { totalMs: 300 });
    expect((await fetch(`${origin}/api/workflows/${doc.id}/activation`, json('PUT', { active: true }))).status).toBe(200);

    const hook = await fetch(`${origin}/hooks/${doc.id}/deploy`, json('POST', { acceptBaseline: true, accept: true }));
    expect(hook.status).toBe(202);
    const { runId } = (await hook.json()) as { runId: string };
    const record = await api.runs.waitFor(runId, 10_000);
    expect(record?.trigger?.kind).toBe('webhook');
    expect(record?.output?.items.map((i) => i.data)).toContainEqual(expect.objectContaining({ regressions: 1 }));
    expect(await baselineOf(doc.id, 'baseline:projects:new@' + BASE)).toMatchObject({ medianMs: 100 });
    expect((await baselineOf(doc.id, 'baseline:projects:new@' + BASE))?.accepted).toBeUndefined();
  });

  it('is only offered on a box that has it, in a run that finished', async () => {
    const doc = await importExample();
    const done = await runAndWait(doc.id);
    expect((await fetch(`${origin}/api/runs/${done.runId}/nodes/measure/actions/acceptBaseline`, json('POST', {}))).status).toBe(404);
    expect((await fetch(`${origin}/api/runs/run_nope/nodes/baseline/actions/acceptBaseline`, json('POST', {}))).status).toBe(404);
  });
});

describe('the report', () => {
  it('downloads as an attachment that the browser will not run', async () => {
    const doc = await importExample();
    const done = await runAndWait(doc.id);
    const report = done.output?.items.find((i) => i.binary?.['report']);
    // Log passes items through untouched, binary references included.
    const ref = report!.binary!['report']!;
    const res = await fetch(`${origin}/api/blobs/${ref.key}?name=${encodeURIComponent(ref.fileName!)}&type=${encodeURIComponent(ref.mimeType)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="endpoint-latency.md"');
    expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await res.text()).toMatch(/^# Endpoint latency — BM-1496\n\n\*\*15 targets: no regressions\.\*\*/);
  });

  it('serves the chart as an image the editor can show, still an attachment, sandboxed if opened directly', async () => {
    const doc = await importExample();
    const done = await runAndWait(doc.id);
    const chart = done.output?.items.find((i) => i.binary?.['chart']);
    const ref = chart!.binary!['chart']!;
    const res = await fetch(`${origin}/api/blobs/${ref.key}?name=${encodeURIComponent(ref.fileName!)}&type=${encodeURIComponent(ref.mimeType)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/svg+xml; charset=utf-8');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="before-after.svg"');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
    expect(await res.text()).toMatch(/^<svg /);
    // Any other type still comes back as bytes to save, never as a page.
    const html = await fetch(`${origin}/api/blobs/${ref.key}?type=text%2Fhtml`);
    expect(html.headers.get('content-type')).toBe('application/octet-stream');
  });

  it('serves nothing for a key that is not a content hash', async () => {
    expect((await fetch(`${origin}/api/blobs/..%2F..%2Fsecrets`)).status).toBe(404);
    expect((await fetch(`${origin}/api/blobs/${'0'.repeat(64)}`)).status).toBe(404);
  });
});
