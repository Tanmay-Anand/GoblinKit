/**
 * What a run looks like on the canvas, folded from its journal.
 *
 * Kept apart from the document on purpose (§15.3, rule 5): a live run updates
 * many times a second, and if those updates touched the document every box on
 * the canvas would re-render on each one. Instead each box subscribes to its
 * own entry here, and an entry object is replaced only when that box changes.
 */

import type { JournalEntry, RunCounters, RunStatus } from '@goblin/runtime';
import type { Envelope, WorkflowDocument } from '@goblin/spec';

export type BoxStatus = 'running' | 'succeeded' | 'failed' | 'skipped' | 'waiting';

export interface BoxRunView {
  status: BoxStatus;
  /** How many times the box started — more than one inside a loop or on retry. */
  starts: number;
  attempt: number;
  /** Items emitted, summed across every pass. */
  items: number;
  error?: string;
  /** Failed, and the engine has scheduled another attempt. */
  retrying?: boolean;
  skippedBecause?: string;
  lastInput?: Record<string, Envelope>;
  lastOutput?: Record<string, Envelope>;
}

export interface WireRunView {
  status: 'delivered' | 'pruned';
  items: number;
}

export interface RunProjection {
  status: RunStatus | 'idle';
  boxes: Readonly<Record<string, BoxRunView>>;
  wires: Readonly<Record<string, WireRunView>>;
  counters: RunCounters;
  output?: Envelope;
  error?: string;
  /** nodeRunId → nodeId, to attribute success and failure entries. */
  runIndex: Readonly<Record<string, string>>;
}

export const idleProjection: RunProjection = {
  status: 'idle',
  boxes: {},
  wires: {},
  counters: { nodesRun: 0, itemsProcessed: 0, errors: 0, retries: 0 },
  runIndex: {},
};

/**
 * Fold a batch of entries. Only boxes and wires the batch touches get new objects.
 *
 * `scopeEnds` (loop box → its closing box, from the compiled graph) is needed
 * because loops are run by the scheduler, not by an executor: a For each has
 * no NodeRunStarted of its own, only ScopeOpened / Iterated / Closed, and the
 * box that closes it has no entries at all.
 */
export function projectEntries(
  prev: RunProjection,
  entries: readonly JournalEntry[],
  doc: WorkflowDocument,
  scopeEnds: ReadonlyMap<string, string> = new Map(),
): RunProjection {
  if (entries.length === 0) return prev;
  const boxes = { ...prev.boxes };
  const wires = { ...prev.wires };
  const runIndex = { ...prev.runIndex };
  const counters = { ...prev.counters };
  let { status, output, error } = prev;
  const edgeTarget = new Map(doc.edges.map((e) => [e.id, e.to]));

  const box = (id: string): BoxRunView => boxes[id] ?? { status: 'running', starts: 0, attempt: 1, items: 0 };

  for (const e of entries) {
    switch (e.kind) {
      case 'RunStarted':
        status = 'running';
        break;
      case 'NodeRunStarted': {
        runIndex[e.nodeRunId] = e.nodeId;
        const b = box(e.nodeId);
        const { error: _cleared, retrying: _done, ...rest } = b;
        boxes[e.nodeId] = { ...rest, status: 'running', starts: b.starts + 1, attempt: e.attempt };
        counters.nodesRun++;
        break;
      }
      case 'NodeRunSucceeded': {
        const id = runIndex[e.nodeRunId];
        if (!id) break;
        const emitted = Object.values(e.outputs).reduce((n, env) => n + env.items.length, 0);
        const b = box(id);
        boxes[id] = { ...b, status: 'succeeded', items: b.items + emitted, lastOutput: e.outputs };
        counters.itemsProcessed += emitted;
        break;
      }
      case 'NodeRunFailed': {
        const id = runIndex[e.nodeRunId];
        if (!id) break;
        boxes[id] = { ...box(id), status: 'failed', error: e.error.message };
        counters.errors++;
        break;
      }
      case 'NodeRunSkipped': {
        // A box that ran in an earlier loop pass is not "skipped" overall.
        const b = boxes[e.nodeId];
        if (!b || b.status === 'skipped') {
          boxes[e.nodeId] = { status: 'skipped', starts: 0, attempt: 1, items: 0, skippedBecause: e.reason };
        }
        break;
      }
      case 'EdgeDelivered': {
        const edgeId = e.key.split('#')[0]!;
        const w = wires[edgeId];
        wires[edgeId] = { status: 'delivered', items: (w?.status === 'delivered' ? w.items : 0) + e.envelope.items.length };
        const to = edgeTarget.get(edgeId);
        if (to) {
          const b = box(to.node);
          boxes[to.node] = { ...b, status: boxes[to.node] ? b.status : 'waiting', lastInput: { ...b.lastInput, [to.port]: e.envelope } };
        }
        break;
      }
      case 'EdgePruned': {
        const edgeId = e.key.split('#')[0]!;
        if (!wires[edgeId]) wires[edgeId] = { status: 'pruned', items: 0 };
        break;
      }
      case 'ScopeOpened': {
        const b = box(e.scope.scopeId);
        boxes[e.scope.scopeId] = { ...b, status: 'running', items: b.items + e.scope.items.length };
        break;
      }
      case 'ScopeIterated': {
        const scopeId = e.key.split('#')[0]!;
        const b = box(scopeId);
        boxes[scopeId] = { ...b, starts: b.starts + 1 };
        const end = scopeEnds.get(scopeId);
        if (end) {
          const eb = box(end);
          boxes[end] = { ...eb, status: 'succeeded', starts: eb.starts + 1 };
        }
        break;
      }
      case 'ScopeClosed': {
        const scopeId = e.key.split('#')[0]!;
        boxes[scopeId] = { ...box(scopeId), status: 'succeeded' };
        break;
      }
      case 'TimerScheduled':
        if (e.timer.purpose === 'wait') {
          boxes[e.timer.nodeId] = { ...box(e.timer.nodeId), status: 'waiting' };
        } else {
          // Not failed yet: another attempt is coming. The last error is kept to show why.
          boxes[e.timer.nodeId] = { ...box(e.timer.nodeId), status: 'waiting', retrying: true };
          counters.retries++;
        }
        break;
      case 'RunStatusChanged':
        status = e.status;
        break;
      case 'RunCompleted':
        status = e.status;
        output = e.output;
        error = e.error?.message;
        break;
    }
  }

  return {
    status,
    boxes,
    wires,
    counters,
    runIndex,
    ...(output ? { output } : {}),
    ...(error ? { error } : {}),
  };
}
