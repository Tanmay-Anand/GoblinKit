/**
 * @goblin/drivers-inprocess — one process, real clock, no queue.
 *
 * This is where the impurity lives, and keeping it in one small file is the
 * point of the whole command/event design. The driver owns the clock, the
 * randomness, the node executors and the loop; the scheduler owns every
 * decision. A queue-backed driver replaces this file and changes no
 * scheduling logic at all.
 */

import { createHash, randomUUID } from 'node:crypto';
import { compile, type CompiledGraph } from '@goblin/graph';
import {
  advance,
  foldJournal,
  initialState,
  type Command,
  type JournalEntry,
  type NodeError,
  type RunEvent,
  type RunState,
  type SchedulerContext,
} from '@goblin/runtime';
import { makeContext, NodeFailure, type NodeDefinition } from '@goblin/node-sdk';
import type { Envelope, JsonValue, ManifestRegistry, WorkflowDocument } from '@goblin/spec';

export interface RunOptions {
  document: WorkflowDocument;
  registry: ManifestRegistry;
  nodes: NodeDefinition[];
  input?: Envelope;
  /** The trigger that fired; the others are skipped. Absent: every trigger starts. */
  triggerNode?: string;
  /**
   * Continue a run from what its journal already records, instead of
   * starting it: after the app was closed mid-run, say. See `resumeFrom`.
   */
  resume?: { journal: readonly JournalEntry[] };
  runId?: string;
  /** Wall-clock waits are honoured by default; tests turn them off. */
  realTimers?: boolean;
  onJournal?: (entries: readonly JournalEntry[]) => void;
  onLog?: (line: { level: string; node: string; message: string; data?: JsonValue }) => void;
  /** Fixed clock, for deterministic tests and golden files. */
  clock?: () => number;
}

export interface RunResult {
  state: RunState;
  journal: JournalEntry[];
  graph: CompiledGraph;
}

export async function runWorkflow(options: RunOptions): Promise<RunResult> {
  const graph = compile(options.document, options.registry);
  const runId = options.runId ?? randomUUID();
  const executors = new Map(options.nodes.map((n) => [`${n.manifest.type}@${n.manifest.version}`, n]));

  const inFlight = new Set<Promise<void>>();
  const timers = new Map<string, { fireAt: number; cancel?: () => void }>();
  const clock = options.clock ?? (() => Date.now());

  let state = initialState(runId);
  const journal: JournalEntry[] = [];
  const pending: RunEvent[] = [];
  if (options.resume) {
    ({ state } = resumeFrom(runId, options.resume.journal, pending, timers));
    journal.push(...options.resume.journal);
  } else {
    pending.push({
      kind: 'RunStarted',
      trigger: options.input ?? { items: [{ data: {} }] },
      ...(options.triggerNode ? { triggerNode: options.triggerNode } : {}),
    });
  }

  const ctxFor = (): SchedulerContext => ({
    graph,
    now: clock(),
    runId,
    /**
     * Ids are derived from a seed, never from randomness.
     *
     * Two runs of the same journal must produce the same ids, or replay
     * diverges from the run it is meant to reproduce and every golden test
     * becomes a diff of UUIDs.
     */
    newId: (kind, seed) =>
      `${kind}_${createHash('sha256').update(`${runId}|${seed}`).digest('base64url').slice(0, 22)}`,
  });

  const deliver = (event: RunEvent): void => {
    pending.push(event);
  };

  while (pending.length > 0 || inFlight.size > 0 || timers.size > 0) {
    // 1. Drain every event the scheduler can already decide on.
    while (pending.length > 0) {
      const event = pending.shift()!;
      const transition = advance(state, event, ctxFor());
      state = transition.state;
      journal.push(...transition.journal);
      options.onJournal?.(transition.journal);

      for (const command of transition.commands) {
        dispatch(command);
      }
      if (state.status === 'succeeded' || state.status === 'failed' || state.status === 'cancelled') {
        // Timers for a finished run are dropped rather than awaited: a failed
        // run must not keep the process alive for a retry nobody wants.
        for (const [, timer] of timers) timer.cancel?.();
        timers.clear();
      }
    }

    // 2. Nothing left to decide — wait for whatever is outstanding.
    if (inFlight.size > 0) {
      await Promise.race([...inFlight]);
      continue;
    }
    if (timers.size > 0) {
      await advanceTimers();
      continue;
    }
  }

  return { state, journal, graph };

  function dispatch(command: Command): void {
    switch (command.kind) {
      case 'InvokeNode': {
        const { invocation } = command;
        const definition = executors.get(`${invocation.type}@${invocation.typeVersion}`);
        if (!definition) {
          deliver({
            kind: 'NodeFailed',
            nodeRunId: invocation.nodeRunId,
            error: { message: `No executor registered for ${invocation.type}@${invocation.typeVersion}`, retryable: false },
          });
          return;
        }

        const controller = new AbortController();
        const task = (async () => {
          try {
            const ctx = makeContext({
              nodeId: invocation.nodeId,
              scopePath: invocation.scopePath,
              attempt: invocation.attempt,
              idempotencyKey: invocation.idempotencyKey,
              input: invocation.input,
              config: invocation.config,
              credentials: invocation.credentials,
              signal: controller.signal,
              variables: options.document.variables ?? {},
              nodeOutputs: nodeOutputsFor(state),
              logger: {
                debug: (message, data) => options.onLog?.({ level: 'debug', node: invocation.nodeId, message, ...(data !== undefined ? { data } : {}) }),
                info: (message, data) => options.onLog?.({ level: 'info', node: invocation.nodeId, message, ...(data !== undefined ? { data } : {}) }),
                warn: (message, data) => options.onLog?.({ level: 'warn', node: invocation.nodeId, message, ...(data !== undefined ? { data } : {}) }),
              },
            });
            const outputs = await definition.execute(ctx);
            deliver({ kind: 'NodeSucceeded', nodeRunId: invocation.nodeRunId, outputs });
          } catch (error) {
            deliver({ kind: 'NodeFailed', nodeRunId: invocation.nodeRunId, error: classify(error) });
          }
        })().finally(() => {
          inFlight.delete(task);
        });
        inFlight.add(task);
        return;
      }

      case 'ScheduleTimer': {
        timers.set(command.timerId, { fireAt: command.fireAt });
        return;
      }

      case 'CancelTimer': {
        timers.get(command.timerId)?.cancel?.();
        timers.delete(command.timerId);
        return;
      }

      case 'AwaitSignal':
      case 'CancelInvocation':
      case 'CompleteRun':
      case 'EmitMetric':
        // AwaitSignal needs an ingress this driver does not have; the others
        // are already reflected in state. Both are honest no-ops here rather
        // than pretended support.
        return;
    }
  }

  async function advanceTimers(): Promise<void> {
    const now = clock();
    const due = [...timers.entries()].sort((a, b) => a[1].fireAt - b[1].fireAt);
    const next = due[0];
    if (!next) return;

    const [timerId, timer] = next;
    if (options.realTimers !== false && timer.fireAt > now) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(timer.fireAt - now, 30_000)));
      if (clock() < timer.fireAt) return;
    }
    timers.delete(timerId);
    deliver({ kind: 'TimerFired', timerId });
  }
}

/**
 * Pick a run back up from its journal.
 *
 * The state is the journal folded, as always. What the journal cannot say is
 * what was happening in memory when the process stopped, and there are only
 * two kinds of that:
 *
 *  - A box that had started and not finished. Its work may or may not have
 *    happened, so it is reported as a retryable failure: the box's own retry
 *    setting decides whether it runs again, exactly as if it had timed out.
 *    Its idempotency key is unchanged, so an API that honours the key sees
 *    the retry as the same request.
 *  - A timer — a Wait, or a retry's backoff. It is re-armed for the time it
 *    was always due, so a three-day Wait still ends on the third day; one
 *    that fell due while the app was closed fires straight away.
 */
export function resumeFrom(
  runId: string,
  entries: readonly JournalEntry[],
  pending: RunEvent[],
  timers: Map<string, { fireAt: number }>,
): { state: RunState } {
  const state = foldJournal(runId, entries);
  if (state.status === 'succeeded' || state.status === 'failed' || state.status === 'cancelled') return { state };

  for (const run of Object.values(state.nodeRuns)) {
    if (run.status !== 'running') continue;
    pending.push({
      kind: 'NodeFailed',
      nodeRunId: run.nodeRunId,
      error: { message: 'GoblinKit stopped while this box was running.', code: 'INTERRUPTED', retryable: true },
    });
  }
  for (const timer of Object.values(state.pendingTimers)) timers.set(timer.timerId, { fireAt: timer.fireAt });
  return { state };
}

/** The `{{ $node['id'] }}` view of what has run so far. */
function nodeOutputsFor(state: RunState): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const [key, envelope] of Object.entries(state.outputs)) {
    const nodeId = key.split(':')[0];
    if (!nodeId) continue;
    out[nodeId] = envelope.items.map((i) => i.data) as JsonValue;
  }
  return out;
}

function classify(error: unknown): NodeError {
  if (error instanceof NodeFailure) {
    return {
      message: error.message,
      retryable: error.retryable,
      ...(error.code ? { code: error.code } : {}),
    };
  }
  if (error instanceof Error) {
    // An unexpected throw is retryable by default: at this boundary most of
    // them are network-shaped, and a node that knows better throws NodeFailure.
    return { message: error.message, retryable: true, code: error.name };
  }
  return { message: String(error), retryable: false };
}

/**
 * Rebuild a run from its journal.
 *
 * The payoff of the whole design in four lines: a run exported from production
 * folds to the same state locally, because the decision layer has no ambient
 * inputs to differ on.
 */
export function replay(runId: string, journal: readonly JournalEntry[]): RunState {
  return foldJournal(runId, journal);
}
