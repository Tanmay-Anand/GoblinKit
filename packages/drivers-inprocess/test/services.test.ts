import { describe, expect, it } from 'vitest';

import { runWorkflow } from '@goblin/drivers-inprocess';
import {
  CredentialRuntime,
  defineCredentialResolver,
  defineCredentialType,
  defineExecutor,
  defineManifest,
  InMemoryCredentialStore,
  InMemoryStateStore,
  MockHttp,
  NodeFailure,
  type NodeDefinition,
} from '@goblin/node-sdk';
import { foldJournal, type JournalEntry } from '@goblin/runtime';
import { coreManifests, coreNodes } from '@goblin/nodes-core';
import { MapRegistry, type NodeManifest, type WorkflowDocument } from '@goblin/spec';

/** A box that counts its runs in ctx.state, and can be told to fail after writing. */
const counterManifest = defineManifest({
  type: 'test.counter',
  version: 1,
  title: 'Counter',
  group: 'data',
  executionMode: 'batch',
  ports: { inputs: [{ id: 'main', required: true }], outputs: [{ id: 'main' }] },
  defaults: { policy: { retry: { maxAttempts: 2, backoffMs: 1, maxBackoffMs: 1 } } },
});

let failFirstAttempt = false;
let pause: Promise<void> | undefined;

const counterNode = defineExecutor(counterManifest, async (ctx) => {
  const current = await ctx.state.get('count');
  const next = ((current?.value as number | undefined) ?? 0) + 1;
  ctx.state.set('count', next, { ifVersion: current?.version ?? 'absent' });
  // Reads inside the same invocation see the write straight away.
  const seen = (await ctx.state.get('count'))?.value;
  if (pause) await pause;
  if (failFirstAttempt && ctx.attempt === 1) ctx.fail('first attempt fails after writing');
  return ctx.emit('main', [{ data: { count: next, seen: seen ?? null } }]);
});

const tokenType = defineCredentialType({
  type: 'test.token',
  version: 1,
  title: 'Token',
  provides: ['httpAuth@1'],
  fields: [{ name: 'token', secret: true, required: true }],
});

/** A careless box: it logs the header it was given and puts the token in its error. */
const leakyManifest = defineManifest({
  type: 'test.leaky',
  version: 1,
  title: 'Leaky',
  group: 'data',
  executionMode: 'batch',
  ports: { inputs: [{ id: 'main', required: true }], outputs: [{ id: 'main' }] },
  credentials: [{ name: 'auth', accepts: ['httpAuth@1'], required: true }],
});
const leakyNode = defineExecutor(leakyManifest, async (ctx) => {
  const auth = await ctx.credential('auth');
  const header = (auth!.value as { headers: Record<string, string> }).headers['authorization']!;
  ctx.logger.info(`calling with ${header}`, { header });
  throw new NodeFailure(`server rejected ${header}`, { retryable: false });
});

const manifests: NodeManifest[] = [...coreManifests, counterManifest, leakyManifest];
const nodes: NodeDefinition[] = [...coreNodes, counterNode, leakyNode];
const registry = new MapRegistry(manifests);

function doc(type: string, extra: Partial<WorkflowDocument['nodes'][number]> = {}): WorkflowDocument {
  return {
    schemaVersion: 1,
    id: 'wf_state',
    tenantId: 'local',
    name: 'state',
    nodes: [
      { id: 'start', type: 'core.trigger.manual', typeVersion: 1, config: {} },
      { id: 'box', type, typeVersion: 1, config: {}, ...extra },
    ],
    edges: [{ id: 'e1', from: { node: 'start', port: 'main' }, to: { node: 'box', port: 'main' } }],
  };
}

const run = (state: InMemoryStateStore, extra: Partial<Parameters<typeof runWorkflow>[0]> = {}) =>
  runWorkflow({ document: doc('test.counter'), registry, nodes, realTimers: false, services: { state }, ...extra });

describe('ctx.state through the driver', () => {
  it('commits on success, and the next run reads it', async () => {
    const state = new InMemoryStateStore();
    await run(state);
    const second = await run(state);
    expect(second.state.output?.items[0]?.data).toEqual({ count: 2, seen: 2 });
    expect(state.dump('wf_state', 'box')['count']).toEqual({ value: 2, version: 2 });
  });

  it('writes nothing for a failed attempt: the retry starts from clean state', async () => {
    const state = new InMemoryStateStore();
    failFirstAttempt = true;
    try {
      const result = await run(state);
      expect(result.state.status).toBe('succeeded');
    } finally {
      failFirstAttempt = false;
    }
    // One success, one write. The failed attempt's write went nowhere.
    expect(state.dump('wf_state', 'box')['count']).toEqual({ value: 1, version: 1 });
  });

  it('records the writes on the success entry, and old journals without them fold the same', async () => {
    const state = new InMemoryStateStore();
    const { journal } = await run(state);
    const success = journal.find((e) => e.kind === 'NodeRunSucceeded' && e.stateWrites);
    expect(success && success.kind === 'NodeRunSucceeded' && success.stateWrites).toEqual([{ op: 'set', key: 'count', value: 1, ifVersion: 'absent' }]);

    // Strip the field, as a journal from before it existed would be: same state.
    const old = journal.map((e) => (e.kind === 'NodeRunSucceeded' ? (({ stateWrites: _w, ...rest }) => rest)(e) : e)) as JournalEntry[];
    const a = foldJournal('r', journal);
    const b = foldJournal('r', old);
    expect(b.status).toBe(a.status);
    expect(b.outputs).toEqual(a.outputs);
    expect(b.seq).toBe(a.seq);
  });

  it('applies only after the journal is durable', async () => {
    const state = new InMemoryStateStore();
    let release!: () => void;
    const durable = new Promise<void>((resolve) => (release = resolve));
    let appliedEarly = false;
    const running = run(state, {
      durable: () => durable,
      onJournal: (entries) => {
        if (entries.some((e) => e.kind === 'NodeRunSucceeded')) {
          setTimeout(() => {
            appliedEarly = state.dump('wf_state', 'box')['count'] !== undefined;
            release();
          }, 10);
        }
      },
    });
    await running;
    expect(appliedEarly).toBe(false);
    expect(state.dump('wf_state', 'box')['count']?.value).toBe(1);
  });

  it('drops a write whose version moved underneath it, and says so in the run', async () => {
    const state = new InMemoryStateStore();
    let release!: () => void;
    pause = new Promise((resolve) => (release = resolve));
    try {
      // Two overlapping runs both read version 0 and both try to create "count".
      const a = run(state, { runId: 'run_a' });
      const b = run(state, { runId: 'run_b' });
      await new Promise((r) => setTimeout(r, 20));
      release();
      const [ra, rb] = await Promise.all([a, b]);
      const dropped = [...ra.journal, ...rb.journal].filter((e) => e.kind === 'StateWritesDropped');
      expect(dropped).toHaveLength(1);
      expect(dropped[0]).toMatchObject({ kind: 'StateWritesDropped', keys: ['count'] });
    } finally {
      pause = undefined;
    }
    // The first to finish won; nothing was merged or double counted.
    expect(state.dump('wf_state', 'box')['count']).toEqual({ value: 1, version: 1 });
  });

  it('re-applies the writes of steps a crash left in the journal but not in the store', async () => {
    const donor = new InMemoryStateStore();
    const { journal } = await run(donor, { runId: 'run_crash' });
    // The process died after the journal batch holding the success was
    // appended, and before the state file was written.
    const upToSuccess = journal;

    const state = new InMemoryStateStore();
    await run(state, { runId: 'run_crash', resume: { journal: upToSuccess } });
    expect(state.dump('wf_state', 'box')['count']).toEqual({ value: 1, version: 1 });

    // And again, as if it crashed twice: applying the same step twice is a no-op.
    await run(state, { runId: 'run_crash', resume: { journal: upToSuccess } });
    expect(state.dump('wf_state', 'box')['count']).toEqual({ value: 1, version: 1 });
  });
});

describe('secrets in logs and errors', () => {
  it('scrubs the resolved token from log lines, log data and the error message', async () => {
    const store = new InMemoryCredentialStore();
    const cred = await store.create({ type: 'test.token', name: 'dev', values: { token: 'sk-live-0123456789' } });
    const credentials = new CredentialRuntime({
      store,
      types: [defineCredentialResolver(tokenType, (v) => ({ value: { headers: { authorization: `Bearer ${v['token']}` } } }))],
      http: new MockHttp().client(),
    });
    const logs: string[] = [];
    const result = await runWorkflow({
      document: doc('test.leaky', { credentials: { auth: { id: cred.id, type: 'test.token' } } }),
      registry,
      nodes,
      realTimers: false,
      services: { credentials },
      onLog: (line) => logs.push(JSON.stringify(line)),
    });
    const everything = [...logs, JSON.stringify(result.journal)].join('\n');
    expect(everything).not.toContain('sk-live-0123456789');
    expect(result.state.error?.message).toBe('server rejected [redacted]');
    expect(logs[0]).toContain('calling with [redacted]');
  });
});
