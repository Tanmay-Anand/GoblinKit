import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { coreManifests, coreNodes } from '@goblin/nodes-core';
import { MapRegistry, type Envelope, type WorkflowDocument } from '@goblin/spec';
import { matchGolden, traceRun } from '@goblin/testing';

/**
 * Golden-file tests for the engine, run end to end through the real driver
 * and the real boxes.
 *
 * When one of these fails, read the diff before anything else: it says in
 * plain lines what the engine now does differently. If the change is intended,
 * accept it with UPDATE_GOLDEN=1 and let review see the new trace.
 */

const registry = new MapRegistry(coreManifests);
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

async function example(name: string): Promise<WorkflowDocument> {
  return JSON.parse(await readFile(here(`../../../examples/${name}.json`), 'utf8')) as WorkflowDocument;
}

async function expectGolden(name: string, document: WorkflowDocument, input?: Envelope) {
  const trace = await traceRun({ document, registry, nodes: coreNodes, ...(input ? { input } : {}) });
  const result = await matchGolden(here(`golden/${name}.golden`), trace);
  // Comparing the strings, not the boolean, so a failure prints the diff.
  if (!result.ok) expect(trace).toBe(result.expected);
}

const items = (...data: unknown[]): Envelope => ({ items: data.map((d) => ({ data: d as never })) });

describe('order triage, traced', () => {
  it('takes the high-value branch and prices each line in its own pass', async () => {
    await expectGolden(
      'order-triage-high',
      await example('order-triage'),
      items({ total: 250, lines: [{ sku: 'A-1140', qty: 2, price: 30 }, { sku: 'B-0072', qty: 1, price: 190 }] }),
    );
  });

  it('takes the normal branch when the order is small', async () => {
    await expectGolden('order-triage-low', await example('order-triage'), items({ total: 40, lines: [{ sku: 'C-9', qty: 4, price: 10 }] }));
  });
});

describe('waiting, traced', () => {
  it('parks on a timer and resumes after it', async () => {
    const document: WorkflowDocument = {
      schemaVersion: 1,
      id: 'wf_wait',
      tenantId: 'test',
      name: 'wait then log',
      nodes: [
        { id: 'start', type: 'core.trigger.manual', typeVersion: 1, config: {} },
        { id: 'pause', type: 'core.wait', typeVersion: 1, config: { ms: 5000 } },
        { id: 'note', type: 'core.log', typeVersion: 1, config: { message: 'resumed' } },
      ],
      edges: [
        { id: 'e1', from: { node: 'start', port: 'main' }, to: { node: 'pause', port: 'main' } },
        { id: 'e2', from: { node: 'pause', port: 'main' }, to: { node: 'note', port: 'main' } },
      ],
    };
    await expectGolden('wait-then-log', document, items({ id: 1 }));
  });
});
