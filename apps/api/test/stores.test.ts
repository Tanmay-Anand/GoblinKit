import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { WorkflowDocument } from '@goblin/spec';

import type { RunRecord } from '../src/protocol.js';
import {
  FileActivationStore,
  FileRunStore,
  FileWorkflowStore,
  type ActivationStore,
  type RunStore,
  type WorkflowStore,
} from '../src/stores.js';

/**
 * The storage contract.
 *
 * Written against the WorkflowStore / RunStore / ActivationStore interfaces,
 * not the file classes, so the Postgres stores of Stage 7 run this same suite
 * (ADR-016). Adding a store means adding one entry to `implementations`.
 */

type Stores = { workflows: WorkflowStore; runs: RunStore; activations: ActivationStore };
const implementations: [string, (dir: string) => Stores][] = [
  [
    'files',
    (dir) => ({
      workflows: new FileWorkflowStore(join(dir, 'w')),
      runs: new FileRunStore(join(dir, 'r')),
      activations: new FileActivationStore(join(dir, 'activations.json')),
    }),
  ],
];

const doc = (id: string, name = id): WorkflowDocument => ({
  schemaVersion: 1,
  id,
  tenantId: 'someone-else',
  name,
  nodes: [{ id: 't', type: 'core.trigger.manual', typeVersion: 1, config: {} }],
  edges: [],
});

const record = (runId: string, workflowId: string, startedAt: number): RunRecord => ({
  runId,
  workflowId,
  workflowName: 'x',
  status: 'running',
  startedAt,
  input: { items: [{ data: {} }] },
  logs: [],
});

for (const [name, make] of implementations) {
  describe(`${name} stores`, () => {
    let dir: string;
    let stores: ReturnType<typeof make>;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'goblin-store-'));
      stores = make(dir);
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('keeps a workflow and gives it back, stamped with the local tenant', async () => {
      await stores.workflows.put(doc('wf_a', 'Alpha'));
      const back = await stores.workflows.get('wf_a');
      expect(back?.name).toBe('Alpha');
      expect(back?.tenantId).toBe('local');
      expect(back?.meta?.updatedAt).toBeTruthy();
    });

    it('lists workflows newest first, with their box counts', async () => {
      await stores.workflows.put(doc('wf_old'));
      await new Promise((r) => setTimeout(r, 5));
      await stores.workflows.put(doc('wf_new'));
      const list = await stores.workflows.list();
      expect(list.map((w) => w.id)).toEqual(['wf_new', 'wf_old']);
      expect(list[0]?.boxes).toBe(1);
    });

    it('deletes, and says whether there was anything to delete', async () => {
      await stores.workflows.put(doc('wf_gone'));
      expect(await stores.workflows.delete('wf_gone')).toBe(true);
      expect(await stores.workflows.delete('wf_gone')).toBe(false);
      expect(await stores.workflows.get('wf_gone')).toBeUndefined();
    });

    it('survives many saves of one workflow at once, with reads in between', async () => {
      // An autosave, a Run and the history panel can all touch the same file
      // together. On Windows that used to fail with EPERM and crash the server.
      const writes = Array.from({ length: 25 }, (_, i) => stores.workflows.put(doc('wf_busy', `v${i}`)));
      const reads = Array.from({ length: 25 }, () => stores.workflows.list());
      await expect(Promise.all([...writes, ...reads])).resolves.toBeDefined();
      expect((await stores.workflows.get('wf_busy'))?.name).toMatch(/^v\d+$/);
    });

    it('refuses an id that could escape the workspace', async () => {
      await expect(stores.workflows.get('../../etc/passwd')).rejects.toThrow(/valid id/);
      await expect(stores.workflows.put(doc('..\\evil'))).rejects.toThrow(/valid id/);
      await expect(stores.runs.get('a/b')).rejects.toThrow(/valid id/);
    });

    it('keeps a run, its journal as it grows, and the workflow it ran', async () => {
      const r = record('run_1', 'wf_a', 1);
      await stores.runs.create(r, doc('wf_a', 'As it ran'));
      expect((await stores.runs.get('run_1'))?.journal).toEqual([]);

      await stores.runs.append('run_1', [{ kind: 'RunStarted', at: 1, trigger: { items: [] } }]);
      await stores.runs.append('run_1', [{ kind: 'RunStatusChanged', at: 2, status: 'waiting' }]);
      expect((await stores.runs.get('run_1'))?.journal.map((e) => e.kind)).toEqual(['RunStarted', 'RunStatusChanged']);

      await stores.runs.finish({ ...r, status: 'succeeded', finishedAt: 3 });
      expect((await stores.runs.get('run_1'))?.record.status).toBe('succeeded');
      expect((await stores.runs.document('run_1'))?.name).toBe('As it ran');
    });

    it("lists one workflow's runs, newest first", async () => {
      await stores.runs.create(record('run_a', 'wf_a', 10), doc('wf_a'));
      await stores.runs.create(record('run_b', 'wf_a', 30), doc('wf_a'));
      await stores.runs.create(record('run_c', 'wf_other', 20), doc('wf_other'));
      expect((await stores.runs.list('wf_a')).map((r) => r.runId)).toEqual(['run_b', 'run_a']);
    });

    it('knows which runs never recorded an end — the ones to resume', async () => {
      await stores.runs.create(record('run_done', 'wf_a', 1), doc('wf_a'));
      await stores.runs.finish({ ...record('run_done', 'wf_a', 1), status: 'succeeded', finishedAt: 2 });
      await stores.runs.create(record('run_cut', 'wf_a', 3), doc('wf_a'));
      expect((await stores.runs.unfinished()).map((r) => r.runId)).toEqual(['run_cut']);
    });

    it('switches workflows on and off, remembering since when', async () => {
      await stores.activations.set('wf_a', true, 100);
      await stores.activations.set('wf_a', true, 200); // already on: keeps the first time
      await stores.activations.set('wf_b', true, 300);
      expect(await stores.activations.activatedAt('wf_a')).toBe(100);
      expect((await stores.activations.list()).sort()).toEqual(['wf_a', 'wf_b']);

      await stores.activations.set('wf_a', false);
      expect(await stores.activations.isActive('wf_a')).toBe(false);
      expect(await stores.activations.list()).toEqual(['wf_b']);
    });
  });
}

describe('the file run store, specifically', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'goblin-store-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads a journal whose last line a crash cut off, up to the break', async () => {
    const runs = new FileRunStore(dir);
    await runs.create(record('run_x', 'wf_a', 1), doc('wf_a'));
    await runs.append('run_x', [{ kind: 'RunStarted', at: 1, trigger: { items: [] } }]);
    await appendFile(join(dir, 'run_x.journal.ndjson'), '{"kind":"RunStatusCh');

    expect((await runs.get('run_x'))?.journal.map((e) => e.kind)).toEqual(['RunStarted']);
  });

  it('still reads the journals Stage 3 wrote in one piece', async () => {
    const runs = new FileRunStore(dir);
    await runs.create(record('run_old', 'wf_a', 1), doc('wf_a'));
    await writeFile(join(dir, 'run_old.journal.json'), JSON.stringify([{ kind: 'RunStarted', at: 1, trigger: { items: [] } }]));

    expect((await runs.get('run_old'))?.journal).toHaveLength(1);
  });
});
