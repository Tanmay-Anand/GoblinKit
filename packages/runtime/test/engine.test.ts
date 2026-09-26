import { describe, expect, it } from 'vitest';

import { compile } from '@goblin/graph';
import { MapRegistry, type Envelope, type NodeManifest, type WorkflowDocument } from '@goblin/spec';
import { advance, foldJournal, initialState, type Command, type RunEvent, type RunState } from '@goblin/runtime';
import { coreManifests } from '@goblin/nodes-core';

/**
 * Engine tests.
 *
 * These drive `advance` directly rather than through a driver, because the
 * whole point of a pure scheduler is that its decisions can be asserted
 * without a clock, a network or a queue in the way. A test that needed those
 * would be testing the driver.
 */

const registry = new MapRegistry(coreManifests as NodeManifest[]);

function doc(nodes: WorkflowDocument['nodes'], edges: WorkflowDocument['edges']): WorkflowDocument {
  return { schemaVersion: 1, id: 'wf', tenantId: 't', name: 'test', nodes, edges };
}

const node = (id: string, type: string, config: Record<string, unknown> = {}) => ({
  id,
  type,
  typeVersion: 1,
  config: config as WorkflowDocument['nodes'][number]['config'],
});

const edge = (id: string, from: string, fromPort: string, to: string, toPort = 'main') => ({
  id,
  from: { node: from, port: fromPort },
  to: { node: to, port: toPort },
});

/** A deterministic context: fixed clock, seeded ids, no ambient anything. */
function ctxFor(document: WorkflowDocument, now = 1_000) {
  const graph = compile(document, registry);
  return {
    graph,
    now,
    runId: 'run1',
    newId: (kind: string, seed: string) => `${kind}_${seed}`,
  };
}

/** Drive the engine, answering every InvokeNode with a canned result. */
function drive(
  document: WorkflowDocument,
  answer: (nodeId: string, scopePath: string, attempt: number) => RunEvent | 'fail-run',
  options: { input?: Envelope; maxSteps?: number; now?: () => number; triggerNode?: string } = {},
): { state: RunState; commands: Command[]; log: string[] } {
  const ctx = ctxFor(document);
  let state = initialState('run1');
  const commands: Command[] = [];
  const log: string[] = [];
  const pending: RunEvent[] = [
    {
      kind: 'RunStarted',
      trigger: options.input ?? { items: [{ data: { n: 1 } }] },
      ...(options.triggerNode ? { triggerNode: options.triggerNode } : {}),
    },
  ];
  const timers = new Map<string, number>();

  let steps = 0;
  while (pending.length > 0 || timers.size > 0) {
    if (steps++ > (options.maxSteps ?? 200)) throw new Error('engine did not settle');

    if (pending.length === 0) {
      // Fire the earliest timer, the way a driver would.
      const [timerId] = [...timers.entries()].sort((a, b) => a[1] - b[1])[0]!;
      timers.delete(timerId);
      pending.push({ kind: 'TimerFired', timerId });
    }

    const event = pending.shift()!;
    const now = options.now?.() ?? ctx.now;
    const transition = advance(state, event, { ...ctx, now });
    state = transition.state;
    commands.push(...transition.commands);

    for (const command of transition.commands) {
      if (command.kind === 'InvokeNode') {
        const { nodeId, scopePath, attempt, nodeRunId } = command.invocation;
        log.push(`invoke ${nodeId}${scopePath ? `@${scopePath}` : ''}${attempt > 1 ? `#${attempt}` : ''}`);
        const reply = answer(nodeId, scopePath, attempt);
        if (reply === 'fail-run') continue;
        pending.push(
          reply.kind === 'NodeSucceeded' || reply.kind === 'NodeFailed'
            ? ({ ...reply, nodeRunId } as RunEvent)
            : reply,
        );
      }
      if (command.kind === 'ScheduleTimer') timers.set(command.timerId, command.fireAt);
    }
  }
  return { state, commands, log };
}

const ok = (outputs: Record<string, Envelope>): RunEvent =>
  ({ kind: 'NodeSucceeded', nodeRunId: '', outputs }) as RunEvent;

const main = (...data: unknown[]): Record<string, Envelope> => ({
  main: { items: data.map((d) => ({ data: d as never })) },
});

describe('a workflow with more than one trigger', () => {
  // A schedule and a manual start both feed a Merge; each also has a box of its own.
  const document = doc(
    [
      node('manual', 'core.trigger.manual'),
      node('timer', 'core.trigger.schedule', { repeat: 'minutes', every: 5 }),
      node('byHand', 'core.log'),
      node('onTimer', 'core.log'),
      node('merge', 'core.control.merge'),
      node('after', 'core.log'),
    ],
    [
      edge('e1', 'manual', 'main', 'byHand'),
      edge('e2', 'timer', 'main', 'onTimer'),
      edge('e3', 'byHand', 'main', 'merge', 'a'),
      edge('e4', 'onTimer', 'main', 'merge', 'b'),
      edge('e5', 'merge', 'main', 'after'),
    ],
  );

  it('starts only the trigger that fired, and skips what only the others feed', () => {
    const { state, log } = drive(document, (id) => ok(main({ from: id })), { triggerNode: 'timer' });

    expect(log).toEqual(['invoke timer', 'invoke onTimer', 'invoke merge', 'invoke after']);
    expect(state.status).toBe('succeeded');
    expect(state.edges['e1#']).toEqual({ status: 'pruned', reason: 'manual emitted nothing on port main' });
  });

  it('without a named trigger, starts every one — as the CLI always has', () => {
    const { log } = drive(document, (id) => ok(main({ from: id })));
    expect(log.slice(0, 2)).toEqual(['invoke manual', 'invoke timer']);
  });
});

describe('branching by pruning', () => {
  const document = doc(
    [
      node('trigger', 'core.trigger.manual'),
      node('if', 'core.control.if', { condition: '{{ $json.big }}' }),
      node('yes', 'core.log'),
      node('no', 'core.log'),
    ],
    [
      edge('e1', 'trigger', 'main', 'if'),
      edge('e2', 'if', 'true', 'yes'),
      edge('e3', 'if', 'false', 'no'),
    ],
  );

  it('runs the taken branch and skips the other', () => {
    const { state, log } = drive(document, (id) => {
      if (id === 'if') return ok({ true: { items: [{ data: { big: true } }] } }); // no 'false' output
      return ok(main({ done: id }));
    });

    expect(log).toEqual(['invoke trigger', 'invoke if', 'invoke yes']);
    expect(state.status).toBe('succeeded');

    // The untaken branch is pruned, not merely unvisited: that is what lets
    // pruning propagate transitively through the rest of the graph.
    expect(state.edges['e3#']).toEqual({
      status: 'pruned',
      reason: 'if emitted nothing on port false',
    });
  });

  it('propagates a skip through the whole downstream chain', () => {
    const chain = doc(
      [
        node('trigger', 'core.trigger.manual'),
        node('if', 'core.control.if', { condition: 'false' }),
        node('a', 'core.log'),
        node('b', 'core.log'),
        node('c', 'core.log'),
      ],
      [
        edge('e1', 'trigger', 'main', 'if'),
        edge('e2', 'if', 'true', 'a'),
        edge('e3', 'a', 'main', 'b'),
        edge('e4', 'b', 'main', 'c'),
      ],
    );

    const { state, log } = drive(chain, (id) => {
      if (id === 'if') return ok({}); // emitted on neither port
      return ok(main({}));
    });

    expect(log).toEqual(['invoke trigger', 'invoke if']);
    expect(state.edges['e4#']?.status).toBe('pruned');
    expect(state.status).toBe('succeeded');
  });
});

describe('join policies', () => {
  const merging = (join: 'all' | 'collect') =>
    doc(
      [
        node('trigger', 'core.trigger.manual'),
        node('if', 'core.control.if', { condition: '{{ $json.big }}' }),
        node('left', 'core.log'),
        node('right', 'core.log'),
        node('merge', 'core.control.merge'),
      ],
      [
        edge('e1', 'trigger', 'main', 'if'),
        edge('e2', 'if', 'true', 'left'),
        edge('e3', 'if', 'false', 'right'),
        edge('e4', 'left', 'main', 'merge', join === 'collect' ? 'a' : 'a'),
        edge('e5', 'right', 'main', 'merge', 'b'),
      ],
    );

  it("'collect' runs once one side resolved and the other was pruned", () => {
    const { state, log } = drive(merging('collect'), (id) => {
      if (id === 'if') return ok({ true: { items: [{ data: {} }] } });
      return ok(main({ from: id }));
    });

    expect(log).toContain('invoke merge');
    expect(state.status).toBe('succeeded');
    // This is the case most engines force people to work around: "run this
    // regardless of which branch ran" needs a join that treats a pruned edge
    // as resolved rather than as still pending.
    expect(state.edges['e5#']?.status).toBe('pruned');
  });
});

describe('loops', () => {
  const looping = doc(
    [
      node('trigger', 'core.trigger.manual'),
      node('each', 'core.scope.forEach', { items: '{{ $json.list }}' }),
      node('work', 'core.log'),
      node('end', 'core.scope.end'),
      node('after', 'core.log'),
    ],
    [
      edge('e1', 'trigger', 'main', 'each'),
      edge('e2', 'each', 'item', 'work'),
      edge('e3', 'work', 'main', 'end'),
      edge('e4', 'each', 'done', 'after'),
    ],
  );

  it('runs the body once per item, addressed per iteration', () => {
    const { state, log } = drive(
      looping,
      // The trigger echoes the run input, the way core.trigger.manual does:
      // the scope's `items` expression reads the trigger's OUTPUT, not the
      // run's input, because that is what its inbound edge delivered.
      (id, scopePath) => (id === 'trigger' ? ok(main({ list: ['a', 'b', 'c'] })) : ok(main({ id, scopePath }))),
      { input: { items: [{ data: { list: ['a', 'b', 'c'] } }] } },
    );

    // Per-iteration addressing is the property an engine keyed by node id
    // alone cannot offer: each pass has its own run, its own journal entries
    // and its own inspectable output.
    expect(log).toEqual([
      'invoke trigger',
      'invoke work@each[0]',
      'invoke work@each[1]',
      'invoke work@each[2]',
      'invoke after',
    ]);
    expect(state.status).toBe('succeeded');
    expect(state.scopes['each#']?.iteration).toBe(3);
    expect(state.scopes['each#']?.status).toBe('closed');
  });

  it('refuses to loop past its iteration limit', () => {
    const runaway = doc(
      [
        node('trigger', 'core.trigger.manual'),
        node('loop', 'core.scope.while', { condition: 'true', maxIterations: 5 }),
        node('work', 'core.log'),
        node('end', 'core.scope.end'),
      ],
      [
        edge('e1', 'trigger', 'main', 'loop'),
        edge('e2', 'loop', 'item', 'work'),
        edge('e3', 'work', 'main', 'end'),
      ],
    );

    const { state, log } = drive(runaway, () => ok(main({})), { maxSteps: 400 });

    // Structurally impossible rather than merely discouraged: the run fails
    // with a named reason instead of spinning forever.
    expect(state.status).toBe('failed');
    expect(state.error?.code).toBe('SCOPE_LIMIT');
    expect(log.filter((l) => l.startsWith('invoke work'))).toHaveLength(5);
  });
});

describe('failure handling', () => {
  const failing = (policy: Record<string, unknown>) =>
    doc(
      [
        node('trigger', 'core.trigger.manual'),
        { ...node('flaky', 'core.http.request', { url: 'https://example.invalid' }), policy },
        node('after', 'core.log'),
      ],
      [edge('e1', 'trigger', 'main', 'flaky'), edge('e2', 'flaky', 'main', 'after')],
    );

  it('retries with backoff, then gives up', () => {
    let attempts = 0;
    const { state, log, commands } = drive(
      failing({ retry: { maxAttempts: 3, backoffMs: 100, maxBackoffMs: 1_000 }, onError: 'fail' }),
      (id) => {
        if (id !== 'flaky') return ok(main({}));
        attempts++;
        return { kind: 'NodeFailed', nodeRunId: '', error: { message: 'boom', retryable: true } } as RunEvent;
      },
    );

    expect(attempts).toBe(3);
    expect(log).toEqual(['invoke trigger', 'invoke flaky', 'invoke flaky#2', 'invoke flaky#3']);
    expect(state.status).toBe('failed');
    expect(state.counters.retries).toBe(2);

    // Retries are timers, not sleeps: a run waiting to retry holds no worker.
    const delays = commands.filter((c) => c.kind === 'ScheduleTimer').map((c) => (c as { fireAt: number }).fireAt);
    expect(delays).toEqual([1_100, 1_200]); // 100ms, then doubled
  });

  it('does not retry a failure the node called permanent', () => {
    let attempts = 0;
    const { state } = drive(
      failing({ retry: { maxAttempts: 5, backoffMs: 10, maxBackoffMs: 100 } }),
      (id) => {
        if (id !== 'flaky') return ok(main({}));
        attempts++;
        return {
          kind: 'NodeFailed',
          nodeRunId: '',
          error: { message: 'bad config', retryable: false },
        } as RunEvent;
      },
    );

    expect(attempts).toBe(1);
    expect(state.status).toBe('failed');
  });

  it("onError 'continue' collapses the branch instead of failing the run", () => {
    const { state, log } = drive(failing({ onError: 'continue' }), (id) => {
      if (id !== 'flaky') return ok(main({}));
      return { kind: 'NodeFailed', nodeRunId: '', error: { message: 'boom', retryable: false } } as RunEvent;
    });

    expect(log).not.toContain('invoke after');
    expect(state.status).toBe('succeeded');
    expect(state.edges['e2#']?.status).toBe('pruned');
  });

  it("onError 'route' sends the error down the error port", () => {
    const routed = doc(
      [
        node('trigger', 'core.trigger.manual'),
        { ...node('flaky', 'core.http.request', { url: 'x' }), policy: { onError: 'route' } },
        node('handler', 'core.log'),
      ],
      [edge('e1', 'trigger', 'main', 'flaky'), edge('e2', 'flaky', 'error', 'handler')],
    );

    const { state, log } = drive(routed, (id) => {
      if (id !== 'flaky') return ok(main({}));
      return {
        kind: 'NodeFailed',
        nodeRunId: '',
        error: { message: 'HTTP 500', code: 'HTTP_500', retryable: false },
      } as RunEvent;
    });

    expect(log).toContain('invoke handler');
    const delivered = state.edges['e2#'];
    expect(delivered?.status).toBe('delivered');
    if (delivered?.status === 'delivered') {
      expect(delivered.envelope.items[0]?.error?.message).toBe('HTTP 500');
    }
    expect(state.status).toBe('succeeded');
  });
});

describe('waiting', () => {
  it('parks on a timer and holds nothing', () => {
    const waiting = doc(
      [
        node('trigger', 'core.trigger.manual'),
        node('pause', 'core.wait', { ms: 3 * 24 * 60 * 60 * 1000 }),
        node('after', 'core.log'),
      ],
      [edge('e1', 'trigger', 'main', 'pause'), edge('e2', 'pause', 'main', 'after')],
    );

    const { state, commands, log } = drive(waiting, () => ok(main({ ok: true })));

    // A three-day wait is one timer and one row, not a worker sitting idle for
    // three days. That property has to exist from the start: retrofitting it
    // is a rewrite.
    const timer = commands.find((c) => c.kind === 'ScheduleTimer');
    expect(timer).toBeDefined();
    expect(log).toEqual(['invoke trigger', 'invoke after']);
    expect(state.status).toBe('succeeded');
  });
});

describe('the journal is the truth', () => {
  it('folds back to exactly the state the run ended in', () => {
    const document = doc(
      [
        node('trigger', 'core.trigger.manual'),
        node('each', 'core.scope.forEach', { items: '{{ $json.list }}' }),
        node('work', 'core.log'),
        node('end', 'core.scope.end'),
        node('after', 'core.log'),
      ],
      [
        edge('e1', 'trigger', 'main', 'each'),
        edge('e2', 'each', 'item', 'work'),
        edge('e3', 'work', 'main', 'end'),
        edge('e4', 'each', 'done', 'after'),
      ],
    );

    const ctx = ctxFor(document);
    let state = initialState('run1');
    const journal = [];
    const pending: RunEvent[] = [{ kind: 'RunStarted', trigger: { items: [{ data: { list: [1, 2] } }] } }];

    while (pending.length > 0) {
      const event = pending.shift()!;
      const transition = advance(state, event, ctx);
      state = transition.state;
      journal.push(...transition.journal);
      for (const command of transition.commands) {
        if (command.kind === 'InvokeNode') {
          pending.push({
            kind: 'NodeSucceeded',
            nodeRunId: command.invocation.nodeRunId,
            outputs: main({ id: command.invocation.nodeId }),
          });
        }
      }
    }

    // Crash recovery, replay and time-travel debugging are all this one line.
    const rebuilt = foldJournal('run1', journal);
    expect(rebuilt).toEqual(state);
  });

  it('replays to an intermediate point for time-travel debugging', () => {
    const document = doc(
      [node('trigger', 'core.trigger.manual'), node('a', 'core.log'), node('b', 'core.log')],
      [edge('e1', 'trigger', 'main', 'a'), edge('e2', 'a', 'main', 'b')],
    );

    const ctx = ctxFor(document);
    let state = initialState('run1');
    const journal = [];
    const pending: RunEvent[] = [{ kind: 'RunStarted', trigger: { items: [{ data: {} }] } }];
    while (pending.length > 0) {
      const transition = advance(state, pending.shift()!, ctx);
      state = transition.state;
      journal.push(...transition.journal);
      for (const command of transition.commands) {
        if (command.kind === 'InvokeNode') {
          pending.push({ kind: 'NodeSucceeded', nodeRunId: command.invocation.nodeRunId, outputs: main({}) });
        }
      }
    }

    const halfway = foldJournal('run1', journal.slice(0, 4));
    expect(halfway.status).toBe('running');
    expect(Object.keys(halfway.nodeRuns).length).toBeLessThan(Object.keys(state.nodeRuns).length);
  });
});

describe('determinism', () => {
  it('produces an identical command stream for identical inputs', () => {
    const document = doc(
      [node('trigger', 'core.trigger.manual'), node('a', 'core.log')],
      [edge('e1', 'trigger', 'main', 'a')],
    );

    const once = drive(document, () => ok(main({ x: 1 })));
    const twice = drive(document, () => ok(main({ x: 1 })));

    // Golden-file testing rests on this: if the same inputs could produce a
    // different command stream, a diff would mean nothing.
    expect(JSON.stringify(twice.commands)).toEqual(JSON.stringify(once.commands));
  });

  it('keeps one idempotency key across retries of the same step', () => {
    const document = doc(
      [
        node('trigger', 'core.trigger.manual'),
        { ...node('charge', 'core.http.request', { url: 'x' }), policy: { retry: { maxAttempts: 3, backoffMs: 1, maxBackoffMs: 2 } } },
      ],
      [edge('e1', 'trigger', 'main', 'charge')],
    );

    const { commands } = drive(document, (id) => {
      if (id !== 'charge') return ok(main({}));
      return { kind: 'NodeFailed', nodeRunId: '', error: { message: 'timeout', retryable: true } } as RunEvent;
    });

    const keys = commands
      .filter((c) => c.kind === 'InvokeNode')
      .map((c) => (c as { invocation: { nodeId: string; idempotencyKey: string } }).invocation)
      .filter((i) => i.nodeId === 'charge')
      .map((i) => i.idempotencyKey);

    // A retried "create charge" must not charge twice. The key is stable
    // across attempts of one logical step — which is the platform making this
    // correct rather than each node author remembering to.
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
  });
});
