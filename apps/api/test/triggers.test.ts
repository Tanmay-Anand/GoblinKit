import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { coreManifests, coreNodes } from '@goblin/nodes-core';
import { MapRegistry, type WorkflowDocument } from '@goblin/spec';

import { RunManager } from '../src/runs.js';
import { FileActivationStore, FileRunStore, FileWorkflowStore } from '../src/stores.js';
import { TriggerService, type Timers } from '../src/triggers.js';

/**
 * The scheduler, on a clock the test controls. Real minutes would make this
 * test take real minutes; a hand-wound clock makes "fifteen minutes later"
 * instant and exact.
 */
class Clock implements Timers {
  private queue: { at: number; fn: () => void; id: number }[] = [];
  private seq = 0;
  constructor(public now: number) {}

  set(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.queue.push({ at: this.now + ms, fn, id });
    return id;
  }

  clear(handle: unknown): void {
    this.queue = this.queue.filter((t) => t.id !== handle);
  }

  /** Move time on, firing each timer that falls due, in order, and waiting for what it starts. */
  async advance(ms: number, settle: () => Promise<void>): Promise<void> {
    const until = this.now + ms;
    for (;;) {
      const due = this.queue.filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.queue = this.queue.filter((t) => t !== due);
      // A late timer fires at the current time: clocks never run backwards.
      this.now = Math.max(this.now, due.at);
      due.fn();
      await settle();
    }
    this.now = until;
  }
}

// Friday 25 September 2026, 10:07 local time.
const START = new Date(2026, 8, 25, 10, 7).getTime();

let dir: string;
let clock: Clock;
let runs: RunManager;
let triggers: TriggerService;
let workflows: FileWorkflowStore;
let runStore: FileRunStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'goblin-triggers-'));
  clock = new Clock(START);
  workflows = new FileWorkflowStore(join(dir, 'workflows'));
  runStore = new FileRunStore(join(dir, 'runs'));
  const registry = new MapRegistry(coreManifests);
  runs = new RunManager({ registry, nodes: coreNodes, runs: runStore });
  triggers = new TriggerService({
    workflows,
    activations: new FileActivationStore(join(dir, 'activations.json')),
    runs,
    registry,
    hooksBase: 'http://127.0.0.1:1',
    now: () => clock.now,
    timers: clock,
  });
});

afterEach(async () => {
  triggers.stop();
  await runs.settle();
  await rm(dir, { recursive: true, force: true });
});

const settle = async () => {
  await triggers.idle();
  await runs.settle();
};

const every15: WorkflowDocument = {
  schemaVersion: 1,
  id: 'wf_timed',
  tenantId: 'local',
  name: 'Every quarter hour',
  nodes: [
    { id: 'timer', type: 'core.trigger.schedule', typeVersion: 1, config: { repeat: 'minutes', every: 15 } },
    { id: 'note', type: 'core.log', typeVersion: 1, config: {} },
  ],
  edges: [{ id: 'e1', from: { node: 'timer', port: 'main' }, to: { node: 'note', port: 'main' } }],
};

describe('a switched-on schedule', () => {
  it('fires on the quarter hour, again fifteen minutes later, and not once switched off', async () => {
    await workflows.put(every15);
    const status = await triggers.setActive('wf_timed', true);
    expect(status.triggers[0]).toMatchObject({ kind: 'schedule', description: 'Every 15 minutes', nextRunAt: new Date(2026, 8, 25, 10, 15).getTime() });

    await clock.advance(8 * 60_000, settle); // 10:15
    let history = await runStore.list('wf_timed');
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ status: 'succeeded', trigger: { kind: 'schedule', nodeId: 'timer' } });
    expect(history[0]!.input.items[0]!.data).toMatchObject({ scheduledFor: new Date(2026, 8, 25, 10, 15).toISOString() });

    await clock.advance(15 * 60_000, settle); // 10:30
    expect(await runStore.list('wf_timed')).toHaveLength(2);

    await triggers.setActive('wf_timed', false);
    await clock.advance(60 * 60_000, settle);
    history = await runStore.list('wf_timed');
    expect(history).toHaveLength(2);
  });

  it('picks up a changed schedule as soon as the workflow is saved', async () => {
    await workflows.put(every15);
    await triggers.setActive('wf_timed', true);
    await workflows.put({ ...every15, nodes: [{ ...every15.nodes[0]!, config: { repeat: 'day', at: '18:00' } }, every15.nodes[1]!] });
    await triggers.refresh('wf_timed');

    expect((await triggers.status('wf_timed')).triggers[0]?.nextRunAt).toBe(new Date(2026, 8, 25, 18, 0).getTime());
  });

  it('does not make up runs it slept through', async () => {
    await workflows.put(every15);
    await triggers.setActive('wf_timed', true);
    // The laptop sleeps from 10:07 to 11:40; the pending timer fires late, once.
    clock.now = new Date(2026, 8, 25, 11, 40).getTime();
    await clock.advance(0, settle);

    expect(await runStore.list('wf_timed')).toHaveLength(1);
    expect((await triggers.status('wf_timed')).triggers[0]?.nextRunAt).toBe(new Date(2026, 8, 25, 11, 45).getTime());
  });

  it('skips a run, and says so, when the saved workflow has problems at the time it is due', async () => {
    await workflows.put(every15);
    await triggers.setActive('wf_timed', true);
    // Saved half-built: the Log box lost its wire.
    await workflows.put({ ...every15, edges: [] });

    await clock.advance(8 * 60_000, settle);
    expect(await runStore.list('wf_timed')).toHaveLength(0);
    expect((await triggers.status('wf_timed')).triggers[0]?.lastError).toMatch(/Skipped the run due at .*problems to fix/);
  });
});

describe('switching on', () => {
  it('is refused, with the reason, when nothing could start the workflow', async () => {
    await workflows.put({ ...every15, nodes: [{ id: 'go', type: 'core.trigger.manual', typeVersion: 1, config: {} }], edges: [] });
    await expect(triggers.setActive('wf_timed', true)).rejects.toThrow(/Add a Schedule or Webhook box first/);
  });

  it('is refused when the schedule cannot work', async () => {
    await workflows.put({ ...every15, nodes: [{ ...every15.nodes[0]!, config: { repeat: 'cron', cron: '99 * * * *' } }, every15.nodes[1]!] });
    await expect(triggers.setActive('wf_timed', true)).rejects.toThrow(/outside the minute field's range/);
  });

  it('comes back on its own after a restart', async () => {
    await workflows.put(every15);
    await triggers.setActive('wf_timed', true);
    triggers.stop();

    // A new service over the same workspace, as on the next launch.
    const again = new TriggerService({
      workflows,
      activations: new FileActivationStore(join(dir, 'activations.json')),
      runs,
      registry: new MapRegistry(coreManifests),
      hooksBase: 'http://127.0.0.1:1',
      now: () => clock.now,
      timers: clock,
    });
    await again.start();
    expect((await again.status('wf_timed')).triggers[0]?.nextRunAt).toBeDefined();
    again.stop();
  });
});
