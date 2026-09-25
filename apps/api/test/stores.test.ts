import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { WorkflowDocument } from '@goblin/spec';

import type { RunRecord } from '../src/protocol.js';
import { FileRunStore, FileWorkflowStore, type RunStore, type WorkflowStore } from '../src/stores.js';

/**
 * The storage contract.
 *
 * Written against the WorkflowStore / RunStore interfaces, not the file
 * classes, so the Postgres stores of Stage 7 run this same suite (ADR-016).
 * Adding a store means adding one entry to `implementations`.
 */

const implementations: [string, (dir: string) => { workflows: WorkflowStore; runs: RunStore }][] = [
  ['files', (dir) => ({ workflows: new FileWorkflowStore(join(dir, 'w')), runs: new FileRunStore(join(dir, 'r')) })],
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

    it('keeps a run record and its journal together', async () => {
      const r = record('run_1', 'wf_a', 1);
      await stores.runs.create(r);
      expect((await stores.runs.get('run_1'))?.journal).toEqual([]);

      await stores.runs.finish({ ...r, status: 'succeeded', finishedAt: 2 }, [{ kind: 'RunStarted', at: 1, trigger: { items: [] } }]);
      const detail = await stores.runs.get('run_1');
      expect(detail?.record.status).toBe('succeeded');
      expect(detail?.journal).toHaveLength(1);
    });

    it("lists one workflow's runs, newest first", async () => {
      await stores.runs.create(record('run_a', 'wf_a', 10));
      await stores.runs.create(record('run_b', 'wf_a', 30));
      await stores.runs.create(record('run_c', 'wf_other', 20));
      expect((await stores.runs.list('wf_a')).map((r) => r.runId)).toEqual(['run_b', 'run_a']);
    });
  });
}
