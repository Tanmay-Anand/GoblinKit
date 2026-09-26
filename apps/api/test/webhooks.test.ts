import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { coreManifests, coreNodes } from '@goblin/nodes-core';
import { MapRegistry, type WorkflowDocument } from '@goblin/spec';

import type { ActivationStatus, RunDetail, RunRecord } from '../src/protocol.js';
import { createApi } from '../src/server.js';
import { FileActivationStore, FileRunStore, FileWorkflowStore } from '../src/stores.js';

/** Webhooks over real HTTP, the way another program on this machine calls them. */

let dir: string;
let origin: string;
let api: ReturnType<typeof createApi>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'goblin-hooks-'));
  api = createApi({
    workflows: new FileWorkflowStore(join(dir, 'workflows')),
    runs: new FileRunStore(join(dir, 'runs')),
    activations: new FileActivationStore(join(dir, 'activations.json')),
    registry: new MapRegistry(coreManifests),
    manifests: coreManifests,
    nodes: coreNodes,
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

const json = (method: string, body: unknown, headers: Record<string, string> = {}) => ({
  method,
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

/** Webhook → Set a greeting from the caller's body, answering when the run finishes. */
async function greeter(respond: 'immediately' | 'when the run finishes'): Promise<WorkflowDocument> {
  const created = (await (await fetch(`${origin}/api/workflows`, json('POST', { name: 'Greeter hook' }))).json()) as WorkflowDocument;
  const doc: WorkflowDocument = {
    ...created,
    nodes: [
      { id: 'hook', type: 'core.trigger.webhook', typeVersion: 1, config: { method: 'POST', respond } },
      { id: 'greet', type: 'core.transform.set', typeVersion: 1, config: { values: { greeting: 'Hello {{ $json.body.name }}' }, keepInput: false } },
    ],
    edges: [{ id: 'e1', from: { node: 'hook', port: 'main' }, to: { node: 'greet', port: 'main' } }],
  };
  await fetch(`${origin}/api/workflows/${doc.id}`, json('PUT', doc));
  return doc;
}

const activate = async (id: string, active = true) => fetch(`${origin}/api/workflows/${id}/activation`, json('PUT', { active }));

describe('a Webhook box', () => {
  it('is silent until its workflow is switched on', async () => {
    const doc = await greeter('when the run finishes');
    const res = await fetch(`${origin}/hooks/${doc.id}/hook`, json('POST', { name: 'world' }));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toMatch(/Switch the workflow on/);
  });

  it('once switched on, runs the workflow and answers with its result', async () => {
    const doc = await greeter('when the run finishes');
    const status = (await (await activate(doc.id)).json()) as ActivationStatus;
    expect(status.active).toBe(true);
    expect(status.triggers[0]).toMatchObject({ kind: 'webhook', method: 'POST', url: expect.stringMatching(new RegExp(`/hooks/${doc.id}/hook$`)) });

    const res = await fetch(`${origin}/hooks/${doc.id}/hook`, json('POST', { name: 'world' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ greeting: 'Hello world' });

    const [run] = (await (await fetch(`${origin}/api/workflows/${doc.id}/runs`)).json()) as RunRecord[];
    expect(run).toMatchObject({ status: 'succeeded', trigger: { kind: 'webhook', nodeId: 'hook' } });
  });

  it('answering immediately gives the caller the run id to look up later', async () => {
    const doc = await greeter('immediately');
    await activate(doc.id);
    const res = await fetch(`${origin}/hooks/${doc.id}/hook`, json('POST', { name: 'later' }));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ runId: expect.stringMatching(/^run_/) });
  });

  it('keeps credentials the caller sent out of the run it records', async () => {
    const doc = await greeter('when the run finishes');
    await activate(doc.id);
    await fetch(`${origin}/hooks/${doc.id}/hook`, json('POST', { name: 'x' }, { authorization: 'Bearer secret', 'x-source': 'scraper' }));

    const [run] = (await (await fetch(`${origin}/api/workflows/${doc.id}/runs`)).json()) as RunRecord[];
    const detail = (await (await fetch(`${origin}/api/runs/${run!.runId}`)).json()) as RunDetail;
    const headers = (detail.record.input.items[0]!.data as { headers: Record<string, string> }).headers;
    expect(headers['x-source']).toBe('scraper');
    expect(headers['authorization']).toBeUndefined();
  });

  it('refuses the wrong method, and a call from a web page', async () => {
    const doc = await greeter('when the run finishes');
    await activate(doc.id);
    expect((await fetch(`${origin}/hooks/${doc.id}/hook`)).status).toBe(405);
    const fromPage = await fetch(`${origin}/hooks/${doc.id}/hook`, json('POST', {}, { origin: 'https://some-site.example' }));
    expect(fromPage.status).toBe(403);
  });

  it('takes a form post as well as JSON', async () => {
    const doc = await greeter('when the run finishes');
    await activate(doc.id);
    const res = await fetch(`${origin}/hooks/${doc.id}/hook`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'name=form',
    });
    expect(await res.json()).toEqual({ greeting: 'Hello form' });
  });
});

describe('the Active switch over the API', () => {
  it('says why it will not switch on a workflow nothing could start', async () => {
    const created = (await (await fetch(`${origin}/api/workflows`, json('POST', { name: 'Manual only' }))).json()) as WorkflowDocument;
    const res = await activate(created.id);
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toMatch(/Add a Schedule or Webhook box first/);
  });

  it('shows in the workflow list, and deleting a workflow switches it off', async () => {
    const doc = await greeter('immediately');
    await activate(doc.id);
    const list = (await (await fetch(`${origin}/api/workflows`)).json()) as { id: string; active: boolean }[];
    expect(list.find((w) => w.id === doc.id)?.active).toBe(true);

    await fetch(`${origin}/api/workflows/${doc.id}`, { method: 'DELETE' });
    expect((await fetch(`${origin}/hooks/${doc.id}/hook`, json('POST', {}))).status).toBe(404);
  });
});
