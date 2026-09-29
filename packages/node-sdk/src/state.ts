/**
 * `ctx.state` — a small durable store per (workflow, box) (§12.2).
 *
 * For what a box must remember between runs: a poll cursor, a baseline.
 * Keyed by box id, which never changes when the box is renamed (§4.1).
 *
 * The part that matters is *when* a write happens. A box's writes are held
 * in the invocation — the box reads its own writes straight away — and only
 * travel out on its success, in the journal. The driver applies them once
 * that journal entry is on disk. So:
 *
 *  - a failed attempt writes nothing, and its retry starts from clean state;
 *  - a crash between "the journal says it succeeded" and "the state file was
 *    written" is repaired on resume, by applying the journal's writes again
 *    (the store remembers which runs it has applied, so that is harmless);
 *  - two runs of one workflow overlapping — a schedule and a webhook, say —
 *    cannot silently overwrite each other: a write can carry `ifVersion`, and
 *    one whose version no longer matches is dropped and noted in the run.
 */

import type { JsonValue, StateWrite } from '@goblin/spec';

import { NodeFailure } from './failure.js';

export interface StateEntry {
  value: JsonValue;
  /** 1 on first write, +1 on each write after. Absent keys count as version 0. */
  version: number;
}

export interface ScopedKV {
  get(key: string): Promise<StateEntry | undefined>;
  /** Buffered until the box succeeds. `ifVersion: 'absent'` creates only; a number must match. */
  set(key: string, value: JsonValue, opts?: { ifVersion?: number | 'absent' }): void;
  delete(key: string, opts?: { ifVersion?: number }): void;
}

export interface ApplyResult {
  /** Keys whose write was dropped because `ifVersion` did not match. */
  conflicts: string[];
  /** This writer's writes had been applied before: nothing was done. */
  alreadyApplied: boolean;
}

/** Where committed state lives. Local files now, Postgres in Stage 7. */
export interface StateStore {
  get(workflowId: string, nodeId: string, key: string): Promise<StateEntry | undefined>;
  /**
   * Apply one box run's writes, in order, checking each condition now. The
   * `writer` (the node run id) makes this idempotent: applying the same
   * writer twice is a no-op, which is what makes re-applying on resume safe.
   */
  apply(workflowId: string, nodeId: string, writes: readonly StateWrite[], writer: string): Promise<ApplyResult>;
}

export const MAX_STATE_VALUE_BYTES = 64 * 1024;

/** A box's view: committed state, with its own not-yet-committed writes on top. */
export function createScopedKV(args: { store?: StateStore; workflowId: string; nodeId: string }): ScopedKV & { writes(): StateWrite[] } {
  const buffer: StateWrite[] = [];
  const pending = new Map<string, StateEntry | null>(); // null: deleted in this invocation

  return {
    async get(key) {
      if (pending.has(key)) return pending.get(key) ?? undefined;
      return args.store?.get(args.workflowId, args.nodeId, key);
    },
    set(key, value, opts) {
      const size = new TextEncoder().encode(JSON.stringify(value)).byteLength;
      if (size > MAX_STATE_VALUE_BYTES) {
        throw new NodeFailure(`The value saved as "${key}" is ${Math.ceil(size / 1024)} KB; box state keeps at most 64 KB per key.`, {
          code: 'STATE_TOO_LARGE',
          errorClass: 'permanent',
        });
      }
      buffer.push({ op: 'set', key, value, ...(opts?.ifVersion !== undefined ? { ifVersion: opts.ifVersion } : {}) });
      const before = pending.get(key);
      // The version this write will have if its condition holds, so a later
      // conditional write in the same invocation lines up with it.
      const base = before === undefined ? (typeof opts?.ifVersion === 'number' ? opts.ifVersion : 0) : (before?.version ?? 0);
      pending.set(key, { value, version: base + 1 });
    },
    delete(key, opts) {
      buffer.push({ op: 'delete', key, ...(opts?.ifVersion !== undefined ? { ifVersion: opts.ifVersion } : {}) });
      pending.set(key, null);
    },
    writes: () => [...buffer],
  };
}

/**
 * Apply writes to one box's entries, in place. Shared by every StateStore so
 * the conflict rule is written once.
 */
export function applyWrites(entries: Record<string, StateEntry>, writes: readonly StateWrite[]): string[] {
  const conflicts: string[] = [];
  for (const w of writes) {
    const current = entries[w.key];
    const version = current?.version ?? 0;
    const holds = w.ifVersion === undefined || (w.ifVersion === 'absent' ? current === undefined : w.ifVersion === version);
    if (!holds) {
      if (!conflicts.includes(w.key)) conflicts.push(w.key);
      continue;
    }
    if (w.op === 'set') entries[w.key] = { value: w.value, version: version + 1 };
    else delete entries[w.key];
  }
  return conflicts;
}

export class InMemoryStateStore implements StateStore {
  private readonly data = new Map<string, Record<string, StateEntry>>();
  private readonly applied = new Set<string>();

  async get(workflowId: string, nodeId: string, key: string): Promise<StateEntry | undefined> {
    const entry = this.data.get(`${workflowId}/${nodeId}`)?.[key];
    return entry ? structuredClone(entry) : undefined;
  }

  async apply(workflowId: string, nodeId: string, writes: readonly StateWrite[], writer: string): Promise<ApplyResult> {
    const id = `${workflowId}/${writer}`;
    if (this.applied.has(id)) return { conflicts: [], alreadyApplied: true };
    const scope = `${workflowId}/${nodeId}`;
    const entries = this.data.get(scope) ?? {};
    const conflicts = applyWrites(entries, structuredClone(writes as StateWrite[]));
    this.data.set(scope, entries);
    this.applied.add(id);
    return { conflicts, alreadyApplied: false };
  }

  /** Every key a box holds, for tests. */
  dump(workflowId: string, nodeId: string): Record<string, StateEntry> {
    return structuredClone(this.data.get(`${workflowId}/${nodeId}`) ?? {});
  }
}
