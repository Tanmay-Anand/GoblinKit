/**
 * Starting runs, streaming them while they happen, and picking them back up.
 *
 * A run executes in this process with the in-process driver (§8.1). Each
 * batch of journal entries is appended to the RunStore as it is decided, in
 * order, so a run that is interrupted — the window closed, the machine
 * restarted — can be resumed from exactly where it was (`resumeUnfinished`).
 * While it runs, the journal is also held in memory so any number of browser
 * tabs can subscribe, catch up, and follow live.
 */

import { randomBytes } from 'node:crypto';

import { runWorkflow, type RunOptions } from '@goblin/drivers-inprocess';
import { compile } from '@goblin/graph';
import type { NodeDefinition } from '@goblin/node-sdk';
import type { JournalEntry } from '@goblin/runtime';
import {
  hasErrors,
  validateDocument,
  type Diagnostic,
  type Envelope,
  type JsonValue,
  type ManifestRegistry,
  type NodeInstance,
  type WorkflowDocument,
} from '@goblin/spec';

import type { LogLine, RunRecord, RunStreamMessage, TriggerKind } from './protocol.js';
import type { RunStore } from './stores.js';

export class InvalidWorkflowError extends Error {
  override readonly name = 'InvalidWorkflowError';
  constructor(readonly diagnostics: Diagnostic[]) {
    super('This workflow has problems to fix before it can run.');
  }
}

interface LiveRun {
  record: RunRecord;
  journal: JournalEntry[];
  listeners: Set<(message: RunStreamMessage) => void>;
  finished: Promise<void>;
}

export interface StartOptions {
  /** The run's input. Absent: the starting trigger's test input. */
  input?: Envelope;
  /** Which trigger starts it. Absent: the Manual trigger, or else the first trigger. */
  triggerNode?: string;
  /** What started it, for the run history. Defaults to the Run button. */
  startedBy?: TriggerKind;
}

export function newRunId(): string {
  // Time first so ids sort by start; random tail so two runs in one ms differ.
  return `run_${Date.now().toString(36)}${randomBytes(4).toString('hex')}`;
}

/** An array starts one item per element; anything else starts one item. */
export function toEnvelope(value: JsonValue | undefined): Envelope {
  if (value === undefined || value === null) return { items: [{ data: {} }] };
  return Array.isArray(value) ? { items: value.map((data) => ({ data })) } : { items: [{ data: value }] };
}

const isTrigger = (registry: ManifestRegistry, n: NodeInstance) => !n.disabled && registry.get(n.type, n.typeVersion)?.trigger === true;

/** The trigger the Run button starts: the Manual one if there is one, else the first. */
export function runButtonTrigger(document: WorkflowDocument, registry: ManifestRegistry): NodeInstance | undefined {
  const triggers = document.nodes.filter((n) => isTrigger(registry, n));
  return triggers.find((n) => n.type === 'core.trigger.manual') ?? triggers[0];
}

export function diagnose(document: WorkflowDocument, registry: ManifestRegistry): Diagnostic[] {
  return [...validateDocument(document, registry), ...compile(document, registry).diagnostics];
}

export class RunManager {
  private readonly live = new Map<string, LiveRun>();
  private readonly clock: () => number;

  constructor(
    private readonly deps: {
      registry: ManifestRegistry;
      nodes: NodeDefinition[];
      runs: RunStore;
      clock?: () => number;
      /** Told whenever a run starts, so the scheduler and UI can show it. */
      onStart?: (record: RunRecord) => void;
    },
  ) {
    this.clock = deps.clock ?? Date.now;
  }

  /**
   * Validate, then start. Returns as soon as the run is recorded, not when it
   * finishes — a run with a three-second Wait should not hold the request open.
   */
  async start(document: WorkflowDocument, options: StartOptions = {}): Promise<RunRecord> {
    const diagnostics = diagnose(document, this.deps.registry);
    if (hasErrors(diagnostics)) throw new InvalidWorkflowError(diagnostics.filter((d) => d.severity === 'error'));

    const trigger = options.triggerNode
      ? document.nodes.find((n) => n.id === options.triggerNode && isTrigger(this.deps.registry, n))
      : runButtonTrigger(document, this.deps.registry);
    if (!trigger) throw new InvalidWorkflowError([{ severity: 'error', code: 'NO_TRIGGER', path: ['nodes'], message: 'Nothing here can start this run.' }]);

    const record: RunRecord = {
      runId: newRunId(),
      workflowId: document.id,
      workflowName: document.name,
      status: 'running',
      startedAt: this.clock(),
      input: options.input ?? toEnvelope(trigger.config['testInput']),
      logs: [],
      trigger: { kind: options.startedBy ?? 'manual', nodeId: trigger.id },
    };
    await this.deps.runs.create(record, document);
    this.launch(record, document, { input: record.input, triggerNode: trigger.id });
    this.deps.onStart?.(record);
    return record;
  }

  /**
   * On startup: every run that began and never recorded an end is continued
   * from its journal, with the workflow exactly as it was when it started.
   */
  async resumeUnfinished(): Promise<RunRecord[]> {
    const resumed: RunRecord[] = [];
    for (const record of await this.deps.runs.unfinished()) {
      const [detail, document] = await Promise.all([this.deps.runs.get(record.runId), this.deps.runs.document(record.runId)]);
      if (!detail || !document) {
        // Runs from before Stage 4 kept no copy of their workflow, and nothing
        // can be resumed without one. Close them off honestly.
        await this.deps.runs.finish({
          ...record,
          status: 'failed',
          finishedAt: this.clock(),
          error: 'GoblinKit stopped during this run, and it could not be resumed.',
        });
        continue;
      }
      const again: RunRecord = { ...detail.record, resumedAt: this.clock() };
      this.launch(again, document, { resume: { journal: detail.journal } }, detail.journal);
      resumed.push(again);
    }
    return resumed;
  }

  private launch(
    record: RunRecord,
    document: WorkflowDocument,
    how: Pick<RunOptions, 'input' | 'triggerNode' | 'resume'>,
    backlog: readonly JournalEntry[] = [],
  ): void {
    const listeners = new Set<(message: RunStreamMessage) => void>();
    const journal: JournalEntry[] = [...backlog];
    const emit = (message: RunStreamMessage) => {
      for (const listener of listeners) listener(message);
    };

    // Appends are chained so they land on disk in the order they were
    // decided, however quickly the batches come.
    let persisted: Promise<void> = Promise.resolve();
    const persist = (entries: JournalEntry[]) => {
      persisted = persisted
        .then(() => this.deps.runs.append(record.runId, entries))
        .catch((error: unknown) => console.error(`Could not write run ${record.runId}'s journal:`, error));
    };

    const finished = runWorkflow({
      document,
      registry: this.deps.registry,
      nodes: this.deps.nodes,
      runId: record.runId,
      ...how,
      onJournal: (entries) => {
        if (entries.length === 0) return;
        journal.push(...entries);
        persist([...entries]);
        emit({ type: 'entries', entries: [...entries] });
      },
      onLog: (line) => {
        const logged: LogLine = { at: this.clock(), ...line };
        record.logs.push(logged);
        emit({ type: 'log', line: logged });
      },
    })
      .then((result) => {
        record.status = result.state.status;
        record.counters = result.state.counters;
        if (result.state.error) record.error = result.state.error.message;
        if (result.state.output) record.output = result.state.output;
      })
      .catch((error: unknown) => {
        // The driver does not throw for a failing box — that is a failed run,
        // handled above. Reaching here means the driver itself broke.
        record.status = 'failed';
        record.error = `The run stopped unexpectedly: ${error instanceof Error ? error.message : String(error)}`;
      })
      .then(async () => {
        record.finishedAt = this.clock();
        await persisted;
        try {
          await this.deps.runs.finish(record);
        } catch (error) {
          // A run that could not be written must not take the server down with
          // it — every other run and every open canvas would go too.
          console.error(`Could not save run ${record.runId}:`, error);
        }
        emit({ type: 'end', record });
        this.live.delete(record.runId);
      });

    this.live.set(record.runId, { record, journal, listeners, finished });
  }

  /**
   * Follow a run. The listener first receives everything that already
   * happened, then each new batch, then an `end` message.
   *
   * Catch-up and live delivery happen in one synchronous step, so no entry
   * can fall in the gap between "sent the backlog" and "started listening".
   */
  async follow(runId: string, listener: (message: RunStreamMessage) => void): Promise<(() => void) | undefined> {
    const live = this.live.get(runId);
    if (live) {
      if (live.journal.length) listener({ type: 'entries', entries: [...live.journal] });
      for (const line of live.record.logs) listener({ type: 'log', line });
      live.listeners.add(listener);
      return () => live.listeners.delete(listener);
    }

    const stored = await this.deps.runs.get(runId);
    if (!stored) return undefined;
    listener({ type: 'entries', entries: stored.journal });
    for (const line of stored.record.logs) listener({ type: 'log', line });
    listener({ type: 'end', record: stored.record });
    return () => {};
  }

  /** The finished record, or undefined if the run is still going after `timeoutMs`. */
  async waitFor(runId: string, timeoutMs: number): Promise<RunRecord | undefined> {
    const live = this.live.get(runId);
    if (!live) return (await this.deps.runs.get(runId))?.record;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), timeoutMs);
    });
    const done = live.finished.then(() => live.record);
    const result = await Promise.race([done, timeout]);
    clearTimeout(timer);
    return result;
  }

  /** For tests and shutdown: wait for every run in flight. */
  async settle(): Promise<void> {
    await Promise.all([...this.live.values()].map((r) => r.finished));
  }
}
