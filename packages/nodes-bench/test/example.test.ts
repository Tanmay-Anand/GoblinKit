import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { runWorkflow } from '@goblin/drivers-inprocess';
import { CredentialRuntime, InMemoryBlobStore, InMemoryCredentialStore, InMemoryStateStore, MockHttp } from '@goblin/node-sdk';
import { benchManifests, benchNodes } from '@goblin/nodes-bench';
import { coreCredentialResolvers, coreManifests, coreNodes } from '@goblin/nodes-core';
import { MapRegistry, validateDocument, type WorkflowDocument } from '@goblin/spec';
import { findSecrets, formatTrace, matchGolden } from '@goblin/testing';

const manifests = [...coreManifests, ...benchManifests];
const registry = new MapRegistry(manifests);
const nodes = [...coreNodes, ...benchNodes];
const TOKEN = 'eyJraWQiOi-example-id-token';
const BASE = 'http://dev.stub';

async function example(): Promise<WorkflowDocument> {
  const path = fileURLToPath(new URL('../../../examples/endpoint-latency.json', import.meta.url));
  return JSON.parse(await readFile(path, 'utf8')) as WorkflowDocument;
}

/**
 * The example against a stubbed dev API: old endpoints return whole rows
 * slowly, new ones a few fields quickly — except one old endpoint, which is
 * broken, so the failure path runs too.
 */
async function setup() {
  const doc = await example();
  const store = new InMemoryCredentialStore();
  const cred = await store.create({ type: 'http.bearerToken', name: 'Dev', values: { token: TOKEN } });
  const auth = { auth: { id: cred.id, type: 'http.bearerToken' } };
  const document: WorkflowDocument = {
    ...doc,
    variables: { ...doc.variables, baseUrl: BASE, tenantId: 'acme' },
    nodes: doc.nodes.map((n) => (n.type === 'bench.http.measure' || n.type === 'bench.baseline' ? { ...n, credentials: auth } : n)),
  };

  const http = new MockHttp();
  const rows = (n: number) => ({ rows: Array.from({ length: n }, (_, i) => ({ id: i, name: `Row ${i}`, address: 'A long address line', notes: 'x'.repeat(40) })) });
  http.mock(`GET ${BASE}/*`).reply(200, rows(50), { ttfbMs: 90, totalMs: 180 });
  for (const path of ['projects', 'users', 'channel-partners']) http.mock(`GET ${BASE}/platform/${path}/autocomplete?limit=20`).reply(200, { items: [{ id: 1, name: 'A' }] }, { ttfbMs: 20, totalMs: 30 });
  for (const path of ['buyers', 'banks']) http.mock(`GET ${BASE}/post-sales/${path}/autocomplete?limit=20`).reply(200, { items: [{ id: 1, name: 'A' }] }, { ttfbMs: 20, totalMs: 30 });
  for (const path of ['cancellations', 'cancellations/refunds']) http.mock(`GET ${BASE}/post-sales/${path}?page=0&size=50&view=list`).reply(200, rows(10), { ttfbMs: 60, totalMs: 120 });
  http.mock(`GET ${BASE}/post-sales/banks/names`).reply(500, { error: 'boom' });

  const services = {
    http: http.client(),
    credentials: new CredentialRuntime({ store, types: coreCredentialResolvers, http: http.client() }),
    state: new InMemoryStateStore(),
    blobs: new InMemoryBlobStore(),
  };
  const run = (runId: string) => runWorkflow({ document, registry, nodes, runId, triggerNode: 'manual', realTimers: false, clock: () => 0, services });
  return { document, http, services, run };
}

describe('examples/endpoint-latency.json', () => {
  it('is a valid workflow of shipped boxes', async () => {
    expect(validateDocument(await example(), registry).filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('runs end to end against stubs, and its trace matches the golden file', async () => {
    const { run, http } = await setup();
    const first = await run('golden_1');
    expect(first.state.status).toBe('succeeded');

    const trace = formatTrace(first.journal);
    const golden = await matchGolden(fileURLToPath(new URL('./golden/endpoint-latency.trace', import.meta.url)), trace);
    expect(golden.ok ? trace : golden.expected).toBe(trace);

    // Every request carried the credential and the tenant; none of it reached the journal.
    expect(http.calls.every((c) => c.headers['authorization'] === `Bearer ${TOKEN}` && c.headers['x-tenant-id'] === 'acme')).toBe(true);
    expect(findSecrets(first.journal, [TOKEN])).toEqual([]);
    // 14 targets measured × (1 warm-up + 5), plus the broken one's single try.
    expect(http.calls).toHaveLength(14 * 6 + 1);
  });

  it('flags a regression on a later run, confirmed by measuring again, and reports it', async () => {
    const { run, http, services } = await setup();
    await run('run_1');
    // The new projects endpoint gets much slower, and stays that way.
    http.mock(`GET ${BASE}/platform/projects/autocomplete?limit=20`).reply(200, { items: [] }, { ttfbMs: 20, totalMs: 400 });
    const second = await run('run_2');

    const regressed = second.state.outputs['baseline:regressions#']?.items.map((i) => i.data);
    expect(regressed).toEqual([expect.objectContaining({ key: 'projects', label: 'new', verdict: 'regression', remeasured: true, baselineMs: 30, medianMs: 400 })]);

    const report = second.state.outputs['baseline:report#']!.items[0]!;
    const markdown = new TextDecoder().decode(await services.blobs.get(report.binary!['report']!));
    expect(markdown).toContain('| projects | new | 400.0 | 30.0 | +1233.3% |');
    expect(markdown).toContain('**13 targets: 1 regression.**');
    expect(second.state.outputs['report:main#']?.items[0]?.data).toMatchObject({ summary: '13 targets: 1 regression (projects/new)' });
  });
});
