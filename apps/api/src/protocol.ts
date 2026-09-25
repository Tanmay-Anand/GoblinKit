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
