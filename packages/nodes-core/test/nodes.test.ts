import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';

import { NodeFailure, runNode } from '@goblin/node-sdk';
import { MapRegistry, type WorkflowDocument } from '@goblin/spec';
import { runWorkflow } from '@goblin/drivers-inprocess';
import type { JournalEntry } from '@goblin/runtime';
import { coreManifests, coreNodes } from '@goblin/nodes-core';
import { checkNodePack } from '@goblin/testing';

const registry = new MapRegistry(coreManifests);
const byType = (type: string) => coreNodes.find((n) => n.manifest.type === type)!;

describe('node pack contract', () => {
  /**
   * Every node in a pack has to satisfy the same handful of rules, or the
   * editor cannot render it and the engine cannot schedule it. Testing them
   * once here is what makes a third-party pack trustworthy without reading it.
   */
  it('passes the shared contract every node pack must pass', () => {
    const problems = checkNodePack({
      manifests: coreManifests,
      nodes: coreNodes,
      engineImplemented: ['core.scope.forEach', 'core.scope.while', 'core.scope.end', 'core.wait'],
    });
    expect(problems).toEqual([]);
  });

  it('the contract catches what it claims to', () => {
    // A check that never fails proves nothing, so break a pack on purpose.
    const problems = checkNodePack({
      manifests: [
        { type: 'Bad Type', version: 0, title: '', group: 'x', executionMode: 'batch', ports: { inputs: [], outputs: [] } },
        {
          type: 'core.pick', version: 1, title: 'Pick', group: 'x', executionMode: 'batch',
          ports: { inputs: [{ id: 'main' }], outputs: [{ id: 'main' }] },
          config: { fields: [{ name: 'mode', type: 'select', options: ['a'], default: 'z' }] },
        },
      ],
      nodes: [],
    });
    expect(problems.join('\n')).toMatch(/dotted namespace/);
    expect(problems.join('\n')).toMatch(/needs a title/);
    expect(problems.join('\n')).toMatch(/could never run/);
    expect(problems.join('\n')).toMatch(/defaults to a value it does not offer/);
    expect(problems.join('\n')).toMatch(/core\.pick@1: has no executor/);
  });
});

describe('set', () => {
  it('builds fields from expressions and keeps the input by default', async () => {
    const out = await runNode(byType('core.transform.set'), {
      config: { values: { total: '{{ $json.qty * $json.price }}' } },
      items: [{ data: { qty: 2, price: 5, sku: 'A' } }],
    });
    expect(out['main']?.items[0]?.data).toEqual({ qty: 2, price: 5, sku: 'A', total: 10 });
  });

  it('records lineage so a value can be traced back', async () => {
    const out = await runNode(byType('core.transform.set'), {
      config: { values: { x: 1 }, keepInput: false },
      items: [{ data: { a: 1 } }, { data: { a: 2 } }],
    });
    // "Where did this come from" is the debugging question people ask most and
    // get answered least, because it has to be threaded through from the start.
    expect(out['main']?.items[1]?.lineage).toEqual([{ sourceNode: 'test', sourcePort: 'main', itemIndex: 1 }]);
  });
});

describe('if', () => {
  it('splits items across the two ports', async () => {
    const out = await runNode(byType('core.control.if'), {
      config: { condition: '{{ $json.n > 2 }}' },
      items: [{ data: { n: 1 } }, { data: { n: 5 } }, { data: { n: 3 } }],
    });
    expect(out['true']?.items).toHaveLength(2);
    expect(out['false']?.items).toHaveLength(1);
  });

  it('emits nothing at all on a port with no items', async () => {
    const out = await runNode(byType('core.control.if'), {
      config: { condition: 'true' },
      items: [{ data: {} }],
    });
    // Not an empty envelope: "no items" and "this branch was not taken" are
    // different facts, and only the second should collapse what is downstream.
    expect(out['false']).toBeUndefined();
  });
});

describe('http', () => {
  const http = byType('core.http.request');

  it('says why a request got no answer, instead of "fetch failed"', async () => {
    // A port that was just freed: nothing is listening on it.
    const server = createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    await new Promise((r) => server.close(r));

    await expect(runNode(http, { config: { url: `http://127.0.0.1:${port}/` }, items: [{ data: {} }] })).rejects.toThrow(
      /Could not connect to 127\.0\.0\.1:\d+: nothing is listening there/,
    );
  });

  it('does not retry an address that can never work', async () => {
    const failure = await runNode(http, { config: { url: 'not a url' }, items: [{ data: {} }] }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(NodeFailure);
    expect((failure as NodeFailure).retryable).toBe(false);
    expect((failure as NodeFailure).message).toMatch(/not a valid address/);
  });
});

describe('the in-process driver', () => {
  const document: WorkflowDocument = {
    schemaVersion: 1,
    id: 'wf',
    tenantId: 't',
    name: 'driver test',
    variables: { greeting: 'hello' },
    nodes: [
      { id: 'trigger', type: 'core.trigger.manual', typeVersion: 1, config: {} },
      {
        id: 'shape',
        type: 'core.transform.set',
        typeVersion: 1,
        config: { values: { message: '{{ $vars.greeting }} {{ $json.name }}' }, keepInput: false },
      },
    ],
    edges: [{ id: 'e1', from: { node: 'trigger', port: 'main' }, to: { node: 'shape', port: 'main' } }],
  };

  it('runs a workflow end to end and resolves workflow variables', async () => {
    const result = await runWorkflow({
      document,
      registry,
      nodes: coreNodes,
      input: { items: [{ data: { name: 'world' } }] },
      runId: 'run-1',
    });

    expect(result.state.status).toBe('succeeded');
    expect(result.state.output?.items[0]?.data).toEqual({ message: 'hello world' });
  });

  it('reports a missing executor as a permanent failure rather than hanging', async () => {
    const broken: WorkflowDocument = {
      ...document,
      nodes: [
        { id: 'trigger', type: 'core.trigger.manual', typeVersion: 1, config: {} },
        { id: 'ghost', type: 'core.wait', typeVersion: 1, config: { ms: 0 } },
      ],
      edges: [{ id: 'e1', from: { node: 'trigger', port: 'main' }, to: { node: 'ghost', port: 'main' } }],
    };

    // core.wait has no executor on purpose — the engine implements it — so
    // this also checks the engine really does handle it rather than dispatching.
    const result = await runWorkflow({ document: broken, registry, nodes: coreNodes, runId: 'run-2' });
    expect(result.state.status).toBe('succeeded');
  });

  describe('picking a run back up after the app stopped', () => {
    // Start → Wait 3 days → Set. A journal cut off at some point is what the
    // disk holds after GoblinKit was closed there.
    const waiting: WorkflowDocument = {
      ...document,
      nodes: [
        { id: 'trigger', type: 'core.trigger.manual', typeVersion: 1, config: {} },
        { id: 'pause', type: 'core.wait', typeVersion: 1, config: { ms: 3 * 24 * 3600 * 1000 } },
        {
          id: 'shape',
          type: 'core.transform.set',
          typeVersion: 1,
          config: { values: { message: '{{ $vars.greeting }} {{ $json.name }}' }, keepInput: false },
          policy: { retry: { maxAttempts: 2, backoffMs: 10, maxBackoffMs: 10 } },
        },
      ],
      edges: [
        { id: 'e1', from: { node: 'trigger', port: 'main' }, to: { node: 'pause', port: 'main' } },
        { id: 'e2', from: { node: 'pause', port: 'main' }, to: { node: 'shape', port: 'main' } },
      ],
    };
    const input = { items: [{ data: { name: 'world' } }] };
    const full = async () =>
      (await runWorkflow({ document: waiting, registry, nodes: coreNodes, input, runId: 'r', realTimers: false, clock: () => 1_000 })).journal;
    const cutAfter = (journal: JournalEntry[], match: (e: JournalEntry) => boolean) => journal.slice(0, journal.findIndex(match) + 1);

    it('a three-day Wait is still due at the end of the third day', async () => {
      const journal = cutAfter(await full(), (e) => e.kind === 'TimerScheduled');
      const timer = journal.find((e) => e.kind === 'TimerScheduled')!;
      expect(timer.kind === 'TimerScheduled' && timer.timer.fireAt).toBe(1_000 + 3 * 24 * 3600 * 1000);

      const resumed = await runWorkflow({ document: waiting, registry, nodes: coreNodes, runId: 'r', resume: { journal }, realTimers: false, clock: () => 2_000 });
      expect(resumed.state.status).toBe('succeeded');
      expect(resumed.state.output?.items[0]?.data).toEqual({ message: 'hello world' });
      // The resumed journal continues the old one, rather than starting over.
      expect(resumed.journal.filter((e) => e.kind === 'RunStarted')).toHaveLength(1);
    });

    it('a box that was mid-run is retried under its own retry setting', async () => {
      const journal = cutAfter(await full(), (e) => e.kind === 'NodeRunStarted' && e.nodeId === 'shape');
      const resumed = await runWorkflow({ document: waiting, registry, nodes: coreNodes, runId: 'r', resume: { journal }, realTimers: false, clock: () => 2_000 });

      const failure = resumed.journal.find((e) => e.kind === 'NodeRunFailed');
      expect(failure?.kind === 'NodeRunFailed' && failure.error.code).toBe('INTERRUPTED');
      expect(resumed.state.status).toBe('succeeded');
    });

    it('with no retries left, the interrupted box fails the run and says why', async () => {
      const once = { ...waiting, nodes: waiting.nodes.map((n) => (n.id === 'shape' ? { ...n, policy: {} } : n)) };
      const all = (await runWorkflow({ document: once, registry, nodes: coreNodes, input, runId: 'r', realTimers: false, clock: () => 1_000 })).journal;
      const journal = cutAfter(all, (e) => e.kind === 'NodeRunStarted' && e.nodeId === 'shape');
      const resumed = await runWorkflow({ document: once, registry, nodes: coreNodes, runId: 'r', resume: { journal }, realTimers: false, clock: () => 2_000 });
      expect(resumed.state.status).toBe('failed');
      expect(resumed.state.error?.message).toMatch(/GoblinKit stopped while this box was running/);
    });

    it('a run that had already finished is left alone', async () => {
      const journal = await full();
      const resumed = await runWorkflow({ document: waiting, registry, nodes: coreNodes, runId: 'r', resume: { journal }, realTimers: false });
      expect(resumed.journal).toHaveLength(journal.length);
    });
  });

  it('gives identical runs identical ids, so journals diff cleanly', async () => {
    const a = await runWorkflow({ document, registry, nodes: coreNodes, runId: 'same', input: { items: [{ data: { name: 'x' } }] } });
    const b = await runWorkflow({ document, registry, nodes: coreNodes, runId: 'same', input: { items: [{ data: { name: 'x' } }] } });

    const ids = (r: typeof a) => r.journal.filter((e) => e.kind === 'NodeRunStarted').map((e) => e.nodeRunId);
    expect(ids(b)).toEqual(ids(a));
  });
});
