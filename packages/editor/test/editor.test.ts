import { describe, expect, it } from 'vitest';

import { coreManifests } from '@goblin/nodes-core';
import { MapRegistry, type WorkflowDocument } from '@goblin/spec';
import type { JournalEntry } from '@goblin/runtime';

import { applyCommand, newNodeId } from '../src/document/commands.js';
import { History } from '../src/document/history.js';
import { whyNotConnect } from '../src/document/connect.js';
import { idleProjection, projectEntries } from '../src/run/projection.js';
import { tidyLayout } from '../src/layout.js';
import { createEditorStore, freeSpot, type EditorBackend } from '../src/store.js';
import { dominantRankdir, sidesFor, turn } from '../src/rotation.js';

/** The store needs a backend; these tests never save or run. */
const nullBackend: EditorBackend = {
  save: async (d) => d,
  startRun: async () => {
    throw new Error('not in this test');
  },
  follow: () => () => {},
  listRuns: async () => [],
  getRun: async () => {
    throw new Error('not in this test');
  },
};

const registry = new MapRegistry(coreManifests);

const doc: WorkflowDocument = {
  schemaVersion: 1,
  id: 'wf',
  tenantId: 'local',
  name: 'test',
  nodes: [
    { id: 'start', type: 'core.trigger.manual', typeVersion: 1, config: {}, ui: { position: { x: 0, y: 0 } } },
    { id: 'check', type: 'core.control.if', typeVersion: 1, config: { condition: '{{ $json.ok }}' } },
    { id: 'yes', type: 'core.log', typeVersion: 1, config: {} },
  ],
  edges: [
    { id: 'e1', from: { node: 'start', port: 'main' }, to: { node: 'check', port: 'main' } },
    { id: 'e2', from: { node: 'check', port: 'true' }, to: { node: 'yes', port: 'main' } },
  ],
};

describe('document commands', () => {
  it('removing a box removes every wire touching it', () => {
    const next = applyCommand(doc, { kind: 'RemoveElements', nodeIds: ['check'], edgeIds: [] });
    expect(next.nodes.map((n) => n.id)).toEqual(['start', 'yes']);
    expect(next.edges).toEqual([]);
  });

  it('never mutates the document it was given', () => {
    const frozen = structuredClone(doc);
    applyCommand(doc, { kind: 'MoveNodes', moves: [{ id: 'start', to: { x: 5, y: 5 } }] });
    applyCommand(doc, { kind: 'UpdateNode', nodeId: 'check', patch: { label: 'Changed' } });
    expect(doc).toEqual(frozen);
  });

  it('gives new boxes readable ids people can type in expressions', () => {
    expect(newNodeId(doc, 'HTTP Request')).toBe('httpRequest');
    const withOne = applyCommand(doc, { kind: 'AddNode', node: { id: 'httpRequest', type: 'core.http.request', typeVersion: 1, config: {} } });
    expect(newNodeId(withOne, 'HTTP Request')).toBe('httpRequest2');
  });
});

describe('undo', () => {
  it('takes back a whole word, not one keystroke', () => {
    const h = new History();
    let d = doc;
    for (const label of ['C', 'Ch', 'Che', 'Check']) {
      const next = applyCommand(d, { kind: 'UpdateNode', nodeId: 'check', patch: { label } });
      h.record(d, next, 'check:label', 1000);
      d = next;
    }
    expect(h.undo()).toBe(doc);
    expect(h.canUndo).toBe(false);
    expect(h.redo()?.nodes[1]?.label).toBe('Check');
  });

  it('a new edit clears redo', () => {
    const h = new History();
    const a = applyCommand(doc, { kind: 'RenameWorkflow', name: 'a' });
    h.record(doc, a);
    h.undo();
    h.record(doc, applyCommand(doc, { kind: 'RenameWorkflow', name: 'b' }));
    expect(h.canRedo).toBe(false);
  });
});

describe('connecting boxes', () => {
  const wire = (source: string, sourcePort: string, target: string, targetPort = 'main') => ({ source, sourcePort, target, targetPort });

  it('accepts a sensible wire', () => {
    expect(whyNotConnect(doc, registry, wire('check', 'false', 'yes'))).toBeNull();
  });

  it('says why a wire is refused', () => {
    expect(whyNotConnect(doc, registry, wire('yes', 'main', 'yes'))).toMatch(/itself/);
    expect(whyNotConnect(doc, registry, wire('yes', 'main', 'start'))).toMatch(/starts a workflow/);
    expect(whyNotConnect(doc, registry, wire('check', 'true', 'yes'))).toMatch(/already wired/);
    expect(whyNotConnect(doc, registry, wire('yes', 'main', 'check'))).toMatch(/loop/);
  });
});

describe('the live run view', () => {
  it('folds journal entries into per-box status, touching only boxes that changed', () => {
    const entries: JournalEntry[] = [
      { kind: 'RunStarted', at: 0, trigger: { items: [{ data: {} }] } },
      { kind: 'NodeRunStarted', at: 0, nodeRunId: 'r1', nodeId: 'start', scopePath: '', attempt: 1 },
      { kind: 'NodeRunSucceeded', at: 0, nodeRunId: 'r1', outputs: { main: { items: [{ data: { ok: true } }] } } },
      { kind: 'EdgeDelivered', at: 0, key: 'e1#', envelope: { items: [{ data: { ok: true } }] } },
    ];
    const first = projectEntries(idleProjection, entries, doc);
    expect(first.boxes['start']).toMatchObject({ status: 'succeeded', items: 1 });
    expect(first.wires['e1']).toEqual({ status: 'delivered', items: 1 });
    expect(first.boxes['check']?.lastInput?.['main']?.items).toHaveLength(1);

    const second = projectEntries(first, [{ kind: 'NodeRunSkipped', at: 0, nodeId: 'yes', scopePath: '', reason: 'pruned' }], doc);
    expect(second.boxes['yes']?.status).toBe('skipped');
    // Unchanged boxes keep their object, so their components do not re-render.
    expect(second.boxes['start']).toBe(first.boxes['start']);
  });
});

describe('placing a new box', () => {
  it('never lands on top of an existing box', () => {
    // 'start' sits at 0,0; asking for 10,10 must step clear of it.
    const spot = freeSpot(doc, { x: 10, y: 10 }, { x: 0, y: 150 });
    expect(spot).toEqual({ x: 10, y: 160 });
    expect(freeSpot(doc, { x: 900, y: 900 }, { x: 0, y: 150 })).toEqual({ x: 900, y: 900 });
  });
});

describe('turning a box', () => {
  it('moves its wires round the card, a quarter at a time, either way', () => {
    expect(sidesFor(0)).toEqual({ input: 'top', output: 'bottom' });
    expect(sidesFor(90)).toEqual({ input: 'right', output: 'left' });
    expect(sidesFor(180)).toEqual({ input: 'bottom', output: 'top' });
    expect(sidesFor(270)).toEqual({ input: 'left', output: 'right' });
    expect(turn(270, 90)).toBe(0);
    expect(turn(0, -90)).toBe(270);
  });

  it('turns every chosen box in one undoable step, and stores nothing for upright', () => {
    const once = applyCommand(doc, { kind: 'RotateNodes', nodeIds: ['start', 'check'], by: 90 });
    expect(once.nodes.map((n) => n.ui?.rotation)).toEqual([90, 90, undefined]);
    const back = applyCommand(once, { kind: 'RotateNodes', nodeIds: ['start', 'check'], by: -90 });
    expect(back.nodes[0]!.ui).toEqual({ position: { x: 0, y: 0 } });
    expect(back.nodes[1]!.ui).toEqual({});
  });

  it('grows the flow in the direction a turned box faces, and the new box faces the same way', () => {
    const turned = applyCommand(doc, { kind: 'RotateNodes', nodeIds: ['yes'], by: -90 }); // faces right
    const store = createEditorStore({ doc: turned, manifests: coreManifests, backend: nullBackend });
    const id = store.getState().addBox('core.log', { from: { node: 'yes', port: 'main' } })!;
    const added = store.getState().byId[id]!;
    expect(added.ui?.rotation).toBe(270);
    expect(added.ui?.position?.x).toBeGreaterThan(0);
    expect(added.ui?.position?.y).toBe(0);
  });

  it('tidies left to right when most boxes face right', () => {
    const all = applyCommand(doc, { kind: 'RotateNodes', nodeIds: ['start', 'check', 'yes'], by: -90 });
    expect(dominantRankdir(all)).toBe('LR');
    const moves = new Map(tidyLayout(all).map((m) => [m.id, m.to]));
    expect(moves.get('start')!.x).toBeLessThan(moves.get('check')!.x);
    expect(moves.get('check')!.x).toBeLessThan(moves.get('yes')!.x);
  });
});

describe('tidy layout', () => {
  it('stacks the flow top to bottom', () => {
    const moves = new Map(tidyLayout(doc).map((m) => [m.id, m.to]));
    expect(moves.get('start')!.y).toBeLessThan(moves.get('check')!.y);
    expect(moves.get('check')!.y).toBeLessThan(moves.get('yes')!.y);
  });
});
