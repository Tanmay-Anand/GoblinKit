/**
 * What travels between the canvas and the API.
 *
 * Types only, so the browser can import them without pulling in a line of
 * server code. The workflow document itself is not redefined here: it is
 * `@goblin/spec`'s, and both sides use that one definition.
 */

import type { JournalEntry, RunCounters, RunStatus } from '@goblin/runtime';
import type { Diagnostic, Envelope, JsonValue } from '@goblin/spec';

/** Local mode has one user and one tenant. The id still flows through every call (ADR-016). */
export const LOCAL_TENANT = 'local';

export interface WorkflowSummary {
  id: string;
  name: string;
  description?: string;
  boxes: number;
  updatedAt: string;
  /** Starts by itself: its Schedule and Webhook boxes are live. */
  active?: boolean;
}

/** What started a run: the Run button, a Schedule box, or a call to a Webhook box. */
export type TriggerKind = 'manual' | 'schedule' | 'webhook';

/** One Schedule or Webhook box of a workflow, and where it stands. */
export interface TriggerStatus {
  nodeId: string;
  label: string;
  kind: 'schedule' | 'webhook';
  /** "Every 15 minutes", "POST requests". */
  description: string;
  /** Schedule, while active: when it fires next (ms since epoch). */
  nextRunAt?: number;
  /** Webhook: the address to call. Answers only while the workflow is active. */
  url?: string;
  method?: string;
  /** Why this box cannot work as set up: a bad cron rule, say. */
  problem?: string;
  lastFiredAt?: number;
  /** The last time it fired and could not start a run, and why. */
  lastError?: string;
}

export interface ActivationStatus {
  workflowId: string;
  active: boolean;
  activatedAt?: number;
  triggers: TriggerStatus[];
}

export interface LogLine {
  at: number;
  level: string;
  node: string;
  message: string;
  data?: JsonValue;
}

export interface RunRecord {
  runId: string;
  workflowId: string;
  workflowName: string;
  status: RunStatus;
  startedAt: number;
  finishedAt?: number;
  error?: string;
  counters?: RunCounters;
  input: Envelope;
  logs: LogLine[];
  /** Absent on runs recorded before Stage 4, which were all started by hand. */
  trigger?: { kind: TriggerKind; nodeId?: string };
  /** What the run produced, once it finished. */
  output?: Envelope;
  /** Set when the run was picked up again after GoblinKit restarted mid-run. */
  resumedAt?: number;
}

export interface RunDetail {
  record: RunRecord;
  journal: JournalEntry[];
}

/** Server-sent events on /api/runs/:id/events. */
export type RunStreamMessage =
  | { type: 'entries'; entries: JournalEntry[] }
  | { type: 'log'; line: LogLine }
  | { type: 'end'; record: RunRecord };

export interface ApiError {
  error: string;
  diagnostics?: Diagnostic[];
}
