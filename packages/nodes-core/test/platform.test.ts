import { describe, expect, it } from 'vitest';

import { createNodeHarness, MockHttp, runNode } from '@goblin/node-sdk';
import { coreCredentialResolvers, coreManifests, coreNodes } from '@goblin/nodes-core';
import { migrateNodes, type WorkflowDocument } from '@goblin/spec';
import { checkCredentialPack } from '@goblin/testing';
import { nodeMigrations } from '@goblin/node-sdk';

const http2 = coreNodes.find((n) => n.manifest.type === 'core.http.request' && n.manifest.version === 2)!;
const split = coreNodes.find((n) => n.manifest.type === 'core.transform.split')!;

describe('HTTP Request v2, on ctx.http', () => {
  it('adds size and timing to every result', async () => {
    const t = createNodeHarness(http2);
    t.http.mock('GET https://api.test/orders').reply(200, { orders: [1, 2] }, { ttfbMs: 30, totalMs: 75, headers: { 'x-request-id': 'r1' } });
    const run = await t.run({ config: { url: 'https://api.test/orders' } });
    expect(run.items()[0]?.data).toMatchObject({ status: 200, body: { orders: [1, 2] }, bytes: '{"orders":[1,2]}'.length, timing: { ttfbMs: 30, totalMs: 75 }, headers: { 'x-request-id': 'r1' } });
  });

  it('applies a picked credential, whichever kind it is', async () => {
    const t = createNodeHarness(http2, { credentialTypes: coreCredentialResolvers });
    t.http.mock('GET https://api.test/*').reply(200, {});
    const header = await t.addCredential('http.headerKey', { header: 'X-Api-Key', value: 'k-123456' });
    const query = await t.addCredential('http.queryKey', { param: 'key', value: 'q-123456' });
    await t.run({ config: { url: 'https://api.test/a' }, credentials: { auth: header } });
    await t.run({ config: { url: 'https://api.test/b?x=1' }, credentials: { auth: query } });
    expect(t.http.calls[0]!.headers['x-api-key']).toBe('k-123456');
    expect(t.http.calls[1]!.url).toBe('https://api.test/b?x=1&key=q-123456');
  });

  it('classifies failures so the engine retries the right ones', async () => {
    const t = createNodeHarness(http2);
    t.http.mock('GET https://api.test/missing').reply(404, {});
    t.http.mock('GET https://api.test/busy').reply(503, {});
    await expect(t.run({ config: { url: 'https://api.test/missing' } })).rejects.toMatchObject({ code: 'HTTP_404', errorClass: 'validation', retryable: false });
    await expect(t.run({ config: { url: 'https://api.test/busy' } })).rejects.toMatchObject({ code: 'HTTP_503', errorClass: 'transient', retryable: true });
  });

  it('upgrades a saved v1 box to v2 with its settings intact (migrations are total)', () => {
    const doc: WorkflowDocument = {
      schemaVersion: 1,
      id: 'wf',
      tenantId: 'local',
      name: 'old',
      nodes: [{ id: 'h', type: 'core.http.request', typeVersion: 1, config: { method: 'POST', url: 'https://x.test', body: { a: 1 } } }],
      edges: [],
    };
    const { document } = migrateNodes(doc, nodeMigrations(coreNodes));
    expect(document.nodes[0]).toMatchObject({ typeVersion: 2, config: { method: 'POST', url: 'https://x.test', body: { a: 1 } } });
    // And v1 is still registered, so a document nobody reopened still runs.
    expect(coreManifests.filter((m) => m.type === 'core.http.request').map((m) => m.version)).toEqual([1, 2]);
  });
});

describe('Split list', () => {
  it('makes one item per entry, tracing each back to the item it came from', async () => {
    const out = await runNode(split, { config: { list: '{{ $json.targets }}' }, items: [{ data: { targets: [{ key: 'a' }, { key: 'b' }, 'plain'] } }] });
    expect(out['main']?.items.map((i) => i.data)).toEqual([{ key: 'a' }, { key: 'b' }, { value: 'plain' }]);
    expect(out['main']?.items[1]?.lineage).toEqual([{ sourceNode: 'test', sourcePort: 'main', itemIndex: 0 }]);
  });

  it('says so when the list is not a list', async () => {
    await expect(runNode(split, { config: { list: '{{ $json.nothing }}' }, items: [{ data: {} }] })).rejects.toThrow(/is not a list here \(it is empty\)/);
  });
});

describe('the generic HTTP credential types', () => {
  it('pass the credential contract, resolving to what they promise', async () => {
    const problems = await checkCredentialPack({
      types: coreCredentialResolvers,
      samples: {
        'http.bearerToken': { token: 't' },
        'http.headerKey': { header: 'x-api-key', value: 'v' },
        'http.basicAuth': { username: 'ada', password: 'pässword' },
        'http.queryKey': { param: 'api_key', value: 'v' },
      },
      http: new MockHttp().client(),
    });
    expect(problems).toEqual([]);
  });

  it('basic auth encodes UTF-8 the way servers expect', async () => {
    const basic = coreCredentialResolvers.find((t) => t.manifest.type === 'http.basicAuth')!;
    const out = await basic.resolve({ username: 'ada', password: 'pässword' }, { http: new MockHttp().client(), signal: new AbortController().signal, logger: { info() {}, warn() {} }, now: Date.now });
    expect(out.value).toEqual({ headers: { authorization: `Basic ${Buffer.from('ada:pässword', 'utf8').toString('base64')}` } });
  });
});
