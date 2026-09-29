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
  applyEntry,
  foldJournal,
  initialState,
  type Command,
  type JournalEntry,
  type NodeError,
  type RunEvent,
  type RunState,
  type SchedulerContext,
} from '@goblin/runtime';
import {
  createScopedKV,
  makeContext,
  NodeFailure,
  redact,
  type BlobStore,
  type CredentialProvider,
  type MeteredHttpClient,
  type NodeDefinition,
  type StateStore,
} from '@goblin/node-sdk';
import type { Envelope, JsonValue, ManifestRegistry, StateWrite, WorkflowDocument } from '@goblin/spec';

/**
 * The platform capabilities boxes reach through `ctx` (§12.2). Each is
 * optional: without one, a box gets a local stand-in (a plain HTTP client,
 * blobs in memory, state that is never committed, no credentials).
 */
export interface RunServices {
  http?: MeteredHttpClient;
  credentials?: CredentialProvider;
  blobs?: BlobStore;
  state?: StateStore;
}

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
  services?: RunServices;
  /**
   * Resolves once every entry handed to `onJournal` so far is durable. State
   * writes wait for it, so the store never holds a write the journal lacks.
   */
  durable?: () => Promise<void>;
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
  const services = options.services ?? {};
  const timers = new Map<string, { fireAt: number; cancel?: () => void }>();
  const clock = options.clock ?? (() => Date.now());

  let state = initialState(runId);
  const journal: JournalEntry[] = [];
  const pending: RunEvent[] = [];
  if (options.resume) {
    ({ state } = resumeFrom(runId, options.resume.journal, pending, timers));
    journal.push(...options.resume.journal);
    // The journal may say a box succeeded while its state writes never
    // reached the store: the process stopped in between. Applying them again
    // closes that window; the store skips any it already has.
    for (const entry of options.resume.journal) {
      if (entry.kind === 'NodeRunSucceeded' && entry.stateWrites?.length) applyState(entry.nodeRunId, entry.stateWrites, false);
    }
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
      for (const entry of transition.journal) {
        if (entry.kind === 'NodeRunSucceeded' && entry.stateWrites?.length) applyState(entry.nodeRunId, entry.stateWrites, true);
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

  /**
   * Commit a box's state writes: after its success is durable in the
   * journal, never before, so a crash can lose a write the journal can
   * replay but never keep one the journal does not know about. Writes whose
   * version check fails are dropped, and the run says so.
   */
  function applyState(nodeRunId: string, writes: StateWrite[], waitForJournal: boolean): void {
    const store = services.state;
    const nodeId = state.nodeRuns[nodeRunId]?.nodeId;
    if (!store || !nodeId) return;
    const task: Promise<void> = (async () => {
      if (waitForJournal) await options.durable?.();
      const result = await store.apply(options.document.id, nodeId, writes, nodeRunId);
      if (!result.conflicts.length) return;
      const entry: JournalEntry = { kind: 'StateWritesDropped', at: clock(), nodeRunId, keys: result.conflicts };
      state = applyEntry(state, entry);
      journal.push(entry);
      options.onJournal?.([entry]);
    })()
      .catch((error: unknown) => {
        options.onLog?.({ level: 'warn', node: nodeId, message: `Could not save this box's state: ${error instanceof Error ? error.message : String(error)}` });
      })
      .finally(() => {
        inFlight.delete(task);
      });
    inFlight.add(task);
  }

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
        const manifest = options.registry.get(invocation.type, invocation.typeVersion);
        // What this invocation resolved from its credentials: the exact
        // values to scrub from its logs and its error message (§14.2).
        const secrets = new Set<string>();
        const scrub = <T extends JsonValue | string>(value: T): T => redact(value, secrets);
        const kv = createScopedKV({
          ...(services.state ? { store: services.state } : {}),
          workflowId: options.document.id,
          nodeId: invocation.nodeId,
        });
        const log = (level: string, message: string, data: JsonValue | undefined): void => {
          options.onLog?.({ level, node: invocation.nodeId, message: scrub(message), ...(data !== undefined ? { data: scrub(data) } : {}) });
        };
        const task = (async () => {
          try {
            const ctx = makeContext({
              nodeId: invocation.nodeId,
              scopePath: invocation.scopePath,
              attempt: invocation.attempt,
              idempotencyKey: invocation.idempotencyKey,
              input: invocation.input,
              config: invocation.config,
              ...(manifest ? { manifest } : {}),
              credentials: invocation.credentials,
              signal: controller.signal,
              variables: options.document.variables ?? {},
              nodeOutputs: nodeOutputsFor(state),
              logger: {
                debug: (message, data) => log('debug', message, data),
                info: (message, data) => log('info', message, data),
                warn: (message, data) => log('warn', message, data),
              },
              run: { id: runId, workflowId: options.document.id },
              ...(services.http ? { http: services.http } : {}),
              ...(services.blobs ? { blobs: services.blobs } : {}),
              state: kv,
              credential: async (slot) => {
                const ref = invocation.credentials[slot]!;
                if (!services.credentials) {
                  throw new NodeFailure('This box uses a credential, and credentials are not available here.', {
                    code: 'NO_CREDENTIALS',
                    errorClass: 'permanent',
                  });
                }
                const accepts = manifest?.credentials?.find((c) => c.name === slot)?.accepts ?? [];
                const { secrets: found, ...resolved } = await services.credentials.resolve(ref, { accepts, signal: controller.signal });
                for (const value of found) secrets.add(value);
                return resolved;
              },
            });
            const outputs = await definition.execute(ctx);
            const stateWrites = kv.writes();
            deliver({ kind: 'NodeSucceeded', nodeRunId: invocation.nodeRunId, outputs, ...(stateWrites.length ? { stateWrites } : {}) });
          } catch (error) {
            const classified = classify(error);
            deliver({ kind: 'NodeFailed', nodeRunId: invocation.nodeRunId, error: { ...classified, message: scrub(classified.message) } });
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
      ...(error.errorClass ? { class: error.errorClass } : {}),
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
