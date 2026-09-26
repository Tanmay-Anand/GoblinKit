import type { Envelope, JsonValue, NodeId, PortId } from '@goblin/spec';

/**
 * Run state, and the journal it is a fold of.
 *
 * The relationship between the two is the whole design, so it is worth being
 * precise about it: `advance` never writes state directly. It produces journal
 * entries, and the next state is `entries.reduce(applyEntry, state)`. State is
 * therefore a *derived* value and cannot drift from the journal, which is what
 * makes crash recovery, replay and time-travel debugging fall out of one
 * mechanism instead of needing three.
 *
 * Everything here is plain JSON — records rather than Maps. The architecture
 * writes these as ReadonlyMap; the concession is deliberate, because state is
 * persisted, shipped between processes and diffed in tests, and a Map is none
 * of those things without a conversion step at every boundary.
 */

export type RunId = string;
export type NodeRunId = string;
export type TimerId = string;
export type SignalId = string;
/** "" at the top level, "loop1[3]" inside a loop, "loop1[3]/inner[0]" nested. */
export type ScopePath = string;

export type RunStatus = 'pending' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled';

export interface RunError {
  message: string;
  code?: string;
  nodeId?: NodeId;
  nodeRunId?: NodeRunId;
}

export interface NodeError {
  message: string;
  code?: string;
  /** Whether a retry could plausibly succeed. Set by the executor or classified. */
  retryable?: boolean;
  data?: JsonValue;
}

export type EdgeStateKey = string; // `${edgeId}#${scopePath}`

export type EdgeState =
  | { status: 'pending' }
  | { status: 'delivered'; envelope: Envelope }
  | { status: 'pruned'; reason: string };

export interface NodeRunState {
  nodeRunId: NodeRunId;
  nodeId: NodeId;
  scopePath: ScopePath;
  attempt: number;
  status: 'running' | 'succeeded' | 'failed' | 'skipped' | 'cancelled';
  startedAt: number;
  finishedAt?: number;
  error?: NodeError;
}

export interface ScopeState {
  scopeId: NodeId;
  /** The path this scope instance lives at — a nested loop has one per outer iteration. */
  path: ScopePath;
  kind: 'forEach' | 'while';
  iteration: number;
  /** forEach: the items being walked. Fixed when the scope opens. */
  items: JsonValue[];
  /** Output of each finished iteration, in order, for the `done` envelope. */
  results: JsonValue[];
  status: 'open' | 'closed';
}

export interface RunCounters {
  nodesRun: number;
  itemsProcessed: number;
  errors: number;
  retries: number;
}

export interface RunState {
  readonly runId: RunId;
  readonly status: RunStatus;
  readonly edges: Readonly<Record<EdgeStateKey, EdgeState>>;
  readonly nodeRuns: Readonly<Record<NodeRunId, NodeRunState>>;
  readonly scopes: Readonly<Record<string, ScopeState>>;
  readonly pendingTimers: Readonly<Record<TimerId, PendingTimer>>;
  readonly awaitedSignals: Readonly<Record<SignalId, AwaitedSignal>>;
  /** Last envelope each node emitted on each port, for `{{ $node[...] }}`. */
  readonly outputs: Readonly<Record<string, Envelope>>;
  readonly counters: RunCounters;
  readonly error?: RunError;
  readonly output?: Envelope;
  /** Journal position, and the optimistic-concurrency token a driver writes on. */
  readonly seq: number;
}

export interface PendingTimer {
  timerId: TimerId;
  fireAt: number;
  purpose: 'retry' | 'wait';
  nodeId: NodeId;
  scopePath: ScopePath;
  attempt: number;
}

export interface AwaitedSignal {
  signalId: SignalId;
  nodeId: NodeId;
  scopePath: ScopePath;
  expiresAt?: number;
}

/* ------------------------------------------------------------------------ *
 * Journal entries — the facts, in order
 * ------------------------------------------------------------------------ */

export type JournalEntry =
  | { kind: 'RunStarted'; at: number; trigger: Envelope; triggerNode?: NodeId }
  | { kind: 'NodeRunStarted'; at: number; nodeRunId: NodeRunId; nodeId: NodeId; scopePath: ScopePath; attempt: number }
  | { kind: 'NodeRunSucceeded'; at: number; nodeRunId: NodeRunId; outputs: Record<PortId, Envelope> }
  | { kind: 'NodeRunFailed'; at: number; nodeRunId: NodeRunId; error: NodeError }
  | { kind: 'NodeRunSkipped'; at: number; nodeId: NodeId; scopePath: ScopePath; reason: string }
  | { kind: 'EdgeDelivered'; at: number; key: EdgeStateKey; envelope: Envelope }
  | { kind: 'EdgePruned'; at: number; key: EdgeStateKey; reason: string }
  | { kind: 'ScopeOpened'; at: number; key: string; scope: ScopeState }
  | { kind: 'ScopeIterated'; at: number; key: string; iteration: number; result?: JsonValue }
  | { kind: 'ScopeClosed'; at: number; key: string }
  | { kind: 'TimerScheduled'; at: number; timer: PendingTimer }
  | { kind: 'TimerCleared'; at: number; timerId: TimerId }
  | { kind: 'SignalAwaited'; at: number; signal: AwaitedSignal }
  | { kind: 'SignalCleared'; at: number; signalId: SignalId }
  | { kind: 'RunStatusChanged'; at: number; status: RunStatus }
  | { kind: 'RunCompleted'; at: number; status: RunStatus; output?: Envelope; error?: RunError };

export function initialState(runId: RunId): RunState {
  return {
    runId,
    status: 'pending',
    edges: {},
    nodeRuns: {},
    scopes: {},
    pendingTimers: {},
    awaitedSignals: {},
    outputs: {},
    counters: { nodesRun: 0, itemsProcessed: 0, errors: 0, retries: 0 },
    seq: 0,
  };
}

export const edgeKey = (edgeId: string, scopePath: ScopePath): EdgeStateKey => `${edgeId}#${scopePath}`;
export const scopeKey = (scopeId: NodeId, path: ScopePath): string => `${scopeId}#${path}`;
export const outputKey = (nodeId: NodeId, port: PortId, scopePath: ScopePath): string =>
  `${nodeId}:${port}#${scopePath}`;

/**
 * Apply one journal entry. Pure, total, and the only writer of state.
 *
 * "Total" matters: folding a journal from an older build must not throw on an
 * entry kind it does not recognise, or a single new entry type makes every
 * historical run unreadable.
 */
export function applyEntry(state: RunState, entry: JournalEntry): RunState {
  const seq = state.seq + 1;

  switch (entry.kind) {
    case 'RunStarted':
      return { ...state, status: 'running', seq };

    case 'NodeRunStarted':
      return {
        ...state,
        seq,
        nodeRuns: {
          ...state.nodeRuns,
          [entry.nodeRunId]: {
            nodeRunId: entry.nodeRunId,
            nodeId: entry.nodeId,
            scopePath: entry.scopePath,
            attempt: entry.attempt,
            status: 'running',
            startedAt: entry.at,
          },
        },
        counters: { ...state.counters, nodesRun: state.counters.nodesRun + 1 },
      };

    case 'NodeRunSucceeded': {
      const run = state.nodeRuns[entry.nodeRunId];
      const outputs = { ...state.outputs };
      let items = 0;
      if (run) {
        for (const [port, envelope] of Object.entries(entry.outputs)) {
          outputs[outputKey(run.nodeId, port, run.scopePath)] = envelope;
          items += envelope.items.length;
        }
      }
      return {
        ...state,
        seq,
        outputs,
        nodeRuns: run
          ? { ...state.nodeRuns, [entry.nodeRunId]: { ...run, status: 'succeeded', finishedAt: entry.at } }
          : state.nodeRuns,
        counters: { ...state.counters, itemsProcessed: state.counters.itemsProcessed + items },
      };
    }

    case 'NodeRunFailed': {
      const run = state.nodeRuns[entry.nodeRunId];
      return {
        ...state,
        seq,
        nodeRuns: run
          ? { ...state.nodeRuns, [entry.nodeRunId]: { ...run, status: 'failed', finishedAt: entry.at, error: entry.error } }
          : state.nodeRuns,
        counters: { ...state.counters, errors: state.counters.errors + 1 },
      };
    }

    case 'NodeRunSkipped':
      return state.status === 'running' ? { ...state, seq } : { ...state, seq };

    case 'EdgeDelivered':
      return { ...state, seq, edges: { ...state.edges, [entry.key]: { status: 'delivered', envelope: entry.envelope } } };

    case 'EdgePruned':
      return { ...state, seq, edges: { ...state.edges, [entry.key]: { status: 'pruned', reason: entry.reason } } };

    case 'ScopeOpened':
      return { ...state, seq, scopes: { ...state.scopes, [entry.key]: entry.scope } };

    case 'ScopeIterated': {
      const scope = state.scopes[entry.key];
      if (!scope) return { ...state, seq };
      return {
        ...state,
        seq,
        scopes: {
          ...state.scopes,
          [entry.key]: {
            ...scope,
            iteration: entry.iteration,
            results: entry.result === undefined ? scope.results : [...scope.results, entry.result],
          },
        },
      };
    }

    case 'ScopeClosed': {
      const scope = state.scopes[entry.key];
      if (!scope) return { ...state, seq };
      return { ...state, seq, scopes: { ...state.scopes, [entry.key]: { ...scope, status: 'closed' } } };
    }

    case 'TimerScheduled':
      return {
        ...state,
        seq,
        status: 'waiting',
        pendingTimers: { ...state.pendingTimers, [entry.timer.timerId]: entry.timer },
        counters:
          entry.timer.purpose === 'retry'
            ? { ...state.counters, retries: state.counters.retries + 1 }
            : state.counters,
      };

    case 'TimerCleared': {
      const { [entry.timerId]: _removed, ...rest } = state.pendingTimers;
      return { ...state, seq, pendingTimers: rest };
    }

    case 'SignalAwaited':
      return {
        ...state,
        seq,
        status: 'waiting',
        awaitedSignals: { ...state.awaitedSignals, [entry.signal.signalId]: entry.signal },
      };

    case 'SignalCleared': {
      const { [entry.signalId]: _removed, ...rest } = state.awaitedSignals;
      return { ...state, seq, awaitedSignals: rest };
    }

    case 'RunStatusChanged':
      return { ...state, seq, status: entry.status };

    case 'RunCompleted':
      return {
        ...state,
        seq,
        status: entry.status,
        ...(entry.output ? { output: entry.output } : {}),
        ...(entry.error ? { error: entry.error } : {}),
      };

    default:
      return { ...state, seq };
  }
}

/**
 * Rebuild state from its journal.
 *
 * A worker dies mid-run; another folds the journal and continues. There is no
 * bespoke recovery path to keep in step with the scheduler, because this IS
 * the scheduler's only way of writing state.
 */
export function foldJournal(runId: RunId, entries: readonly JournalEntry[]): RunState {
  return entries.reduce(applyEntry, initialState(runId));
}
