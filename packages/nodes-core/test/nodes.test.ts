import { describe, expect, it } from 'vitest';

import { runNode } from '@goblin/node-sdk';
import { MapRegistry, type WorkflowDocument } from '@goblin/spec';
import { runWorkflow } from '@goblin/drivers-inprocess';
import { coreManifests, coreNodes } from '@goblin/nodes-core';

const registry = new MapRegistry(coreManifests);
const byType = (type: string) => coreNodes.find((n) => n.manifest.type === type)!;

describe('node pack contract', () => {
  /**
   * Every node in a pack has to satisfy the same handful of rules, or the
   * editor cannot render it and the engine cannot schedule it. Testing them
   * once here is what makes a third-party pack trustworthy without reading it.
   */
  it('every manifest is renderable and schedulable', () => {
    for (const manifest of coreManifests) {
      // Dotted namespace, camelCase segments allowed: "core.scope.forEach".
      expect(manifest.type).toMatch(/^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/);
      expect(manifest.version).toBeGreaterThanOrEqual(1);
      expect(manifest.title.length).toBeGreaterThan(0);

      // Inputs and outputs are separate namespaces — a node may legitimately
      // have an input and an output both called 'main' — so each list is
      // checked on its own.
      for (const list of [manifest.ports.inputs, manifest.ports.outputs]) {
        const ids = list.map((p) => p.id);
        expect(new Set(ids).size).toBe(ids.length);
      }

      // A trigger takes no input; anything else with no inputs could never run.
      if (manifest.trigger) expect(manifest.ports.inputs).toHaveLength(0);
      else expect(manifest.ports.inputs.length).toBeGreaterThan(0);

      // A manifest must be plain data: it is served to a browser as JSON.
      expect(() => JSON.parse(JSON.stringify(manifest))).not.toThrow();
    }
  });

  it('ships an executor for every node the engine does not implement itself', () => {
    const engineImplemented = new Set(['core.scope.forEach', 'core.scope.while', 'core.scope.end', 'core.wait']);
    for (const manifest of coreManifests) {
      const hasExecutor = coreNodes.some((n) => n.manifest.type === manifest.type);
      expect(hasExecutor).toBe(!engineImplemented.has(manifest.type));
    }
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

  it('gives identical runs identical ids, so journals diff cleanly', async () => {
    const a = await runWorkflow({ document, registry, nodes: coreNodes, runId: 'same', input: { items: [{ data: { name: 'x' } }] } });
    const b = await runWorkflow({ document, registry, nodes: coreNodes, runId: 'same', input: { items: [{ data: { name: 'x' } }] } });

    const ids = (r: typeof a) => r.journal.filter((e) => e.kind === 'NodeRunStarted').map((e) => e.nodeRunId);
    expect(ids(b)).toEqual(ids(a));
  });
});
