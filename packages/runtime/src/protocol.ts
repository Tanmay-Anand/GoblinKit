import type { CredentialRef, Envelope, JsonObject, JsonValue, NodeId, NodeTypeId, PortId } from '@goblin/spec';
import type { NodeError, NodeRunId, RunId, RunStatus, ScopePath, SignalId, TimerId } from './state.js';

/**
 * The line between deciding and doing.
 *
 * The engine emits Commands and consumes Events. It never performs an effect
 * itself — no clock, no network, no queue, no database. A driver performs the
 * commands and reports back as events, which is what lets the same scheduling
 * logic run in-process in a unit test and across a worker pool in production
 * without a line of it changing.
 */

export interface NodeInvocation {
  /** Deterministic: hash(runId, nodeId, scopePath, attempt). */
  nodeRunId: NodeRunId;
  nodeId: NodeId;
  scopePath: ScopePath;
  type: NodeTypeId;
  typeVersion: number;
  /** Expressions are still unresolved: the executor resolves them in context. */
  config: JsonObject;
  input: Record<PortId, Envelope>;
  credentials: Record<string, CredentialRef>;
  attempt: number;
  deadline: number;
  /**
   * Stable across retries of the same logical step, different across genuinely
   * different steps. Integration nodes forward it as `Idempotency-Key`, which
   * is what turns at-least-once execution into effectively-once business
   * behaviour — the platform making it correct instead of each node author
   * remembering to.
   */
  idempotencyKey: string;
}

export type Command =
  | { kind: 'InvokeNode'; invocation: NodeInvocation }
  | { kind: 'ScheduleTimer'; timerId: TimerId; fireAt: number }
  | { kind: 'CancelTimer'; timerId: TimerId }
  | { kind: 'AwaitSignal'; signalId: SignalId; expiresAt?: number }
  | { kind: 'CancelInvocation'; nodeRunId: NodeRunId; reason: string }
  | { kind: 'CompleteRun'; status: RunStatus; output?: Envelope; error?: { message: string; code?: string } }
  | { kind: 'EmitMetric'; name: string; value: number; tags?: Record<string, string> };

export type RunEvent =
  | { kind: 'RunStarted'; trigger: Envelope }
  | { kind: 'NodeSucceeded'; nodeRunId: NodeRunId; outputs: Record<PortId, Envelope> }
  | { kind: 'NodeFailed'; nodeRunId: NodeRunId; error: NodeError }
  | { kind: 'TimerFired'; timerId: TimerId }
  | { kind: 'SignalReceived'; signalId: SignalId; payload: JsonValue }
  | { kind: 'CancelRequested'; reason: string };

export type IdKind = 'nodeRun' | 'timer' | 'signal';

/**
 * Everything ambient the reducer is allowed to see.
 *
 * `now` is supplied rather than read from the clock and `newId` is seeded per
 * run, so the same (state, event, ctx) always yields the same transition. That
 * is what makes a production journal replayable on a laptop and a golden-file
 * test meaningful.
 */
export interface SchedulerContext {
  readonly graph: import('@goblin/graph').CompiledGraph;
  readonly now: number;
  readonly newId: (kind: IdKind, seed: string) => string;
  readonly runId: RunId;
}

export interface Transition {
  readonly state: import('./state.js').RunState;
  readonly commands: readonly Command[];
  readonly journal: readonly import('./state.js').JournalEntry[];
}
