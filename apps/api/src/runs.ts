/**
 * Starting runs and streaming them while they happen.
 *
 * A run executes in this process with the in-process driver (§8.1). While it
 * runs, its journal is held in memory so that any number of browser tabs can
 * subscribe, catch up on what already happened, and then follow live. When it
 * ends, the journal and a summary record go to the RunStore.
 *
 * Stage 4 changes one thing here: journal entries are appended to disk as they
 * happen, so a run survives the app being closed. Until then a run that is in
 * flight when the process stops is lost, and the plan says so.
 */

import { randomBytes } from 'node:crypto';

import { runWorkflow } from '@goblin/drivers-inprocess';
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
  type WorkflowDocument,
} from '@goblin/spec';

import type { LogLine, RunRecord, RunStreamMessage } from './protocol.js';
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

export function newRunId(): string {
  // Time first so ids sort by start; random tail so two runs in one ms differ.
  return `run_${Date.now().toString(36)}${randomBytes(4).toString('hex')}`;
}

/** An array starts one item per element; anything else starts one item. */
export function toEnvelope(value: JsonValue | undefined): Envelope {
  if (value === undefined || value === null) return { items: [{ data: {} }] };
  return Array.isArray(value) ? { items: value.map((data) => ({ data })) } : { items: [{ data: value }] };
}

/** The input a run starts with when the caller gives none: the trigger's test input. */
export function defaultInput(document: WorkflowDocument): Envelope {
  const trigger = document.nodes.find((n) => n.type === 'core.trigger.manual' && !n.disabled);
  return toEnvelope(trigger?.config['testInput']);
}

export function diagnose(document: WorkflowDocument, registry: ManifestRegistry): Diagnostic[] {
  return [...validateDocument(document, registry), ...compile(document, registry).diagnostics];
}

export class RunManager {
  private readonly live = new Map<string, LiveRun>();

  constructor(
    private readonly deps: {
      registry: ManifestRegistry;
      nodes: NodeDefinition[];
      runs: RunStore;
      clock?: () => number;
    },
  ) {}

  /**
   * Validate, then start. Returns as soon as the run is recorded, not when it
   * finishes — a run with a three-second Wait should not hold the request open.
   */
  async start(document: WorkflowDocument, input?: Envelope): Promise<RunRecord> {
    const diagnostics = diagnose(document, this.deps.registry);
    if (hasErrors(diagnostics)) throw new InvalidWorkflowError(diagnostics.filter((d) => d.severity === 'error'));

    const clock = this.deps.clock ?? Date.now;
    const record: RunRecord = {
      runId: newRunId(),
      workflowId: document.id,
      workflowName: document.name,
      status: 'running',
      startedAt: clock(),
      input: input ?? defaultInput(document),
      logs: [],
    };
    await this.deps.runs.create(record);

    const listeners = new Set<(message: RunStreamMessage) => void>();
    const journal: JournalEntry[] = [];
    const emit = (message: RunStreamMessage) => {
      for (const listener of listeners) listener(message);
    };

    const finished = runWorkflow({
      document,
      registry: this.deps.registry,
      nodes: this.deps.nodes,
      input: record.input,
      runId: record.runId,
      onJournal: (entries) => {
        if (entries.length === 0) return;
        journal.push(...entries);
        emit({ type: 'entries', entries: [...entries] });
      },
      onLog: (line) => {
        const logged: LogLine = { at: clock(), ...line };
        record.logs.push(logged);
        emit({ type: 'log', line: logged });
      },
    })
      .then((result) => {
        record.status = result.state.status;
        record.counters = result.state.counters;
        if (result.state.error) record.error = result.state.error.message;
      })
      .catch((error: unknown) => {
        // The driver does not throw for a failing box — that is a failed run,
        // handled above. Reaching here means the driver itself broke.
        record.status = 'failed';
        record.error = `The run stopped unexpectedly: ${error instanceof Error ? error.message : String(error)}`;
      })
      .then(async () => {
        record.finishedAt = clock();
        try {
          await this.deps.runs.finish(record, journal);
        } catch (error) {
          // A run that could not be written must not take the server down with
          // it — every other run and every open canvas would go too. The run
          // still ends for whoever is watching; only its history is missing.
          console.error(`Could not save run ${record.runId}:`, error);
        }
        emit({ type: 'end', record });
        this.live.delete(record.runId);
      });

    this.live.set(record.runId, { record, journal, listeners, finished });
    return record;
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

  /** For tests and shutdown: wait for every run in flight. */
  async settle(): Promise<void> {
    await Promise.all([...this.live.values()].map((r) => r.finished));
  }
}
