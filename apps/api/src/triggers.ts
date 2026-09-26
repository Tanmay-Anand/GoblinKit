/**
 * Workflows that start by themselves: the Active switch, the scheduler, and
 * the webhook door.
 *
 * Automatic starts happen only while this server is running — it is a local
 * app, not a hosted one — and the canvas says so. Missed schedules are not
 * made up afterwards: a laptop that slept through nine o'clock does not fire
 * nine o'clock's run on waking, it moves on to the next time. Runs that were
 * already under way when the app closed are a different matter, and resume
 * (runs.ts).
 */

import { describeSchedule, nextFire, scheduleSettings } from '@goblin/nodes-core';
import type { JsonValue, ManifestRegistry, NodeInstance, WorkflowDocument } from '@goblin/spec';

import type { ActivationStatus, RunRecord, TriggerStatus } from './protocol.js';
import { diagnose, InvalidWorkflowError, type RunManager } from './runs.js';
import type { ActivationStore, WorkflowStore } from './stores.js';

const SCHEDULE = 'core.trigger.schedule';
const WEBHOOK = 'core.trigger.webhook';

/** Never sleep longer than this between checks, so a changed clock or a waking laptop is noticed. */
const MAX_SLEEP_MS = 60_000;
const RESPOND_TIMEOUT_MS = 30_000;

export class ActivationError extends Error {
  override readonly name = 'ActivationError';
}

export interface WebhookCall {
  method: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: JsonValue;
}

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

interface Armed {
  workflowId: string;
  nodeId: string;
  next: number;
  handle: unknown;
}

export class TriggerService {
  private readonly armed = new Map<string, Armed>();
  private readonly firing = new Set<Promise<void>>();
  private readonly history = new Map<string, { lastFiredAt?: number; lastError?: string | undefined }>();
  private readonly now: () => number;
  private readonly timers: Timers;

  constructor(
    private readonly deps: {
      workflows: WorkflowStore;
      activations: ActivationStore;
      runs: RunManager;
      registry: ManifestRegistry;
      /** Where webhook URLs point, e.g. http://127.0.0.1:8787 */
      hooksBase: string;
      now?: () => number;
      timers?: Timers;
    },
  ) {
    this.now = deps.now ?? Date.now;
    this.timers = deps.timers ?? realTimers;
  }

  /** On startup: arm every workflow that was left switched on. */
  async start(): Promise<void> {
    for (const id of await this.deps.activations.list()) await this.arm(id);
  }

  stop(): void {
    for (const a of this.armed.values()) this.timers.clear(a.handle);
    this.armed.clear();
  }

  /** Wait until every schedule that is firing has finished starting its run. */
  async idle(): Promise<void> {
    while (this.firing.size) await Promise.all([...this.firing]);
  }

  /**
   * Switch a workflow on or off. Switching on is refused, with the reason,
   * when there is nothing that could start it or when it would fail anyway.
   */
  async setActive(workflowId: string, active: boolean): Promise<ActivationStatus> {
    if (!active) {
      this.disarm(workflowId);
      await this.deps.activations.set(workflowId, false);
      return this.status(workflowId);
    }

    const document = await this.deps.workflows.get(workflowId);
    if (!document) throw new ActivationError('That workflow does not exist.');
    const triggers = this.automatic(document);
    if (triggers.length === 0) {
      throw new ActivationError('Add a Schedule or Webhook box first. Activate makes those start the workflow by themselves; the Run button needs nothing switched on.');
    }
    const errors = diagnose(document, this.deps.registry).filter((d) => d.severity === 'error');
    if (errors.length) {
      throw new ActivationError(`Fix ${errors.length === 1 ? 'the problem' : `the ${errors.length} problems`} marked in red first: ${errors[0]!.message}`);
    }
    for (const node of triggers) {
      const problem = node.type === SCHEDULE ? this.scheduleProblem(node) : undefined;
      if (problem) throw new ActivationError(`${node.label ?? node.id}: ${problem}`);
    }

    await this.deps.activations.set(workflowId, true, this.now());
    await this.arm(workflowId);
    return this.status(workflowId);
  }

  /** A saved or deleted workflow: re-read its schedules, if it is switched on. */
  async refresh(workflowId: string): Promise<void> {
    this.disarm(workflowId);
    if (await this.deps.activations.isActive(workflowId)) await this.arm(workflowId);
  }

  async status(workflowId: string): Promise<ActivationStatus> {
    const activatedAt = await this.deps.activations.activatedAt(workflowId);
    const document = await this.deps.workflows.get(workflowId);
    const triggers: TriggerStatus[] = document
      ? this.automatic(document).map((node) => this.triggerStatus(workflowId, node, activatedAt !== undefined))
      : [];
    return { workflowId, active: activatedAt !== undefined, ...(activatedAt !== undefined ? { activatedAt } : {}), triggers };
  }

  /* ---------------------------------------------------------------- schedule */

  private async arm(workflowId: string): Promise<void> {
    const document = await this.deps.workflows.get(workflowId);
    if (!document) return;
    for (const node of this.automatic(document)) {
      if (node.type !== SCHEDULE) continue;
      const next = nextFire(scheduleSettings(node.config), new Date(this.now()));
      if (next instanceof Date) this.wait(workflowId, node.id, next.getTime());
      else this.note(workflowId, node.id, { lastError: next.problem });
    }
  }

  private disarm(workflowId: string): void {
    for (const [key, a] of this.armed) {
      if (a.workflowId !== workflowId) continue;
      this.timers.clear(a.handle);
      this.armed.delete(key);
    }
  }

  /** Sleep towards `next`, in steps of at most a minute, then fire. */
  private wait(workflowId: string, nodeId: string, next: number): void {
    const key = `${workflowId}:${nodeId}`;
    const previous = this.armed.get(key);
    if (previous) this.timers.clear(previous.handle);
    const delay = Math.max(0, Math.min(next - this.now(), MAX_SLEEP_MS));
    const handle = this.timers.set(() => {
      if (this.now() < next) return this.wait(workflowId, nodeId, next);
      const firing = this.fire(workflowId, nodeId, next).finally(() => this.firing.delete(firing));
      this.firing.add(firing);
    }, delay);
    this.armed.set(key, { workflowId, nodeId, next, handle });
  }

  private async fire(workflowId: string, nodeId: string, scheduledFor: number): Promise<void> {
    this.armed.delete(`${workflowId}:${nodeId}`);
    // Always the latest saved version, and only if still switched on.
    if (!(await this.deps.activations.isActive(workflowId))) return;
    const document = await this.deps.workflows.get(workflowId);
    const node = document?.nodes.find((n) => n.id === nodeId && n.type === SCHEDULE && !n.disabled);
    if (!document || !node) return;

    const firedAt = this.now();
    try {
      await this.deps.runs.start(document, {
        input: { items: [{ data: { firedAt: new Date(firedAt).toISOString(), scheduledFor: new Date(scheduledFor).toISOString() } }] },
        triggerNode: nodeId,
        startedBy: 'schedule',
      });
      this.note(workflowId, nodeId, { lastFiredAt: firedAt, lastError: undefined });
    } catch (error) {
      this.note(workflowId, nodeId, {
        lastFiredAt: firedAt,
        lastError: `Skipped the run due at ${clock(scheduledFor)}: ${error instanceof Error ? error.message : String(error)}`,
      });
    }

    // Next time after the one just due — or, if the machine slept past
    // several, the next one after now. Missed runs are not made up.
    const settings = scheduleSettings(node.config);
    let next = nextFire(settings, new Date(scheduledFor));
    if (next instanceof Date && next.getTime() <= this.now()) next = nextFire(settings, new Date(this.now()));
    if (next instanceof Date) this.wait(workflowId, nodeId, next.getTime());
  }

  /* ----------------------------------------------------------------- webhook */

  /**
   * A call to /hooks/<workflow>/<box>. Returns the HTTP status and body to
   * answer with. Only an active workflow answers; anything else is a 404, as
   * if nothing were listening — which, as far as the caller can tell, it is.
   */
  async webhook(workflowId: string, nodeId: string, call: WebhookCall): Promise<{ status: number; body: JsonValue }> {
    if (!(await this.deps.activations.isActive(workflowId).catch(() => false))) {
      return { status: 404, body: { error: 'No active workflow listens here. Switch the workflow on with Activate in GoblinKit.' } };
    }
    const document = await this.deps.workflows.get(workflowId);
    const node = document?.nodes.find((n) => n.id === nodeId && n.type === WEBHOOK && !n.disabled);
    if (!document || !node) return { status: 404, body: { error: 'This workflow has no Webhook box at that address.' } };

    const accepts = String(node.config['method'] ?? 'POST');
    if (accepts !== 'ANY' && accepts !== call.method) {
      return { status: 405, body: { error: `This webhook accepts ${accepts} requests, not ${call.method}.` } };
    }

    let record: RunRecord;
    try {
      record = await this.deps.runs.start(document, {
        input: { items: [{ data: { method: call.method, query: call.query, headers: call.headers, body: call.body } }] },
        triggerNode: nodeId,
        startedBy: 'webhook',
      });
    } catch (error) {
      if (error instanceof InvalidWorkflowError) {
        return { status: 422, body: { error: error.message, problems: error.diagnostics.map((d) => d.message) } };
      }
      throw error;
    }
    this.note(workflowId, nodeId, { lastFiredAt: this.now(), lastError: undefined });

    if (node.config['respond'] !== 'when the run finishes') return { status: 202, body: { runId: record.runId } };

    const done = await this.deps.runs.waitFor(record.runId, RESPOND_TIMEOUT_MS);
    if (!done?.finishedAt) {
      return { status: 202, body: { runId: record.runId, status: 'running', message: 'The run is still going; it did not finish within 30 seconds.' } };
    }
    if (done.status !== 'succeeded') return { status: 500, body: { runId: record.runId, error: done.error ?? `The run ${done.status}.` } };
    const items = done.output?.items ?? [];
    // One item comes back as itself, several as a list: what a caller expects
    // from "call this and get the answer".
    return { status: 200, body: items.length === 1 ? items[0]!.data : items.map((i) => i.data) };
  }

  /* ----------------------------------------------------------------- helpers */

  /** The boxes that can start a workflow by themselves. */
  private automatic(document: WorkflowDocument): NodeInstance[] {
    return document.nodes.filter((n) => !n.disabled && (n.type === SCHEDULE || n.type === WEBHOOK));
  }

  private scheduleProblem(node: NodeInstance): string | undefined {
    const next = nextFire(scheduleSettings(node.config), new Date(this.now()));
    return next instanceof Date ? undefined : next.problem;
  }

  private triggerStatus(workflowId: string, node: NodeInstance, active: boolean): TriggerStatus {
    const seen = this.history.get(`${workflowId}:${node.id}`) ?? {};
    const common = {
      nodeId: node.id,
      label: node.label ?? node.id,
      ...(seen.lastFiredAt !== undefined ? { lastFiredAt: seen.lastFiredAt } : {}),
      ...(seen.lastError ? { lastError: seen.lastError } : {}),
    };
    if (node.type === SCHEDULE) {
      const problem = this.scheduleProblem(node);
      const armed = this.armed.get(`${workflowId}:${node.id}`);
      return {
        ...common,
        kind: 'schedule',
        description: describeSchedule(scheduleSettings(node.config)),
        ...(problem ? { problem } : {}),
        ...(active && armed ? { nextRunAt: armed.next } : {}),
      };
    }
    const method = String(node.config['method'] ?? 'POST');
    return {
      ...common,
      kind: 'webhook',
      method,
      description: method === 'ANY' ? 'Any request' : `${method} requests`,
      url: `${this.deps.hooksBase}/hooks/${workflowId}/${node.id}`,
    };
  }

  private note(workflowId: string, nodeId: string, change: { lastFiredAt?: number; lastError?: string | undefined }): void {
    const key = `${workflowId}:${nodeId}`;
    const next = { ...this.history.get(key), ...change };
    if (next.lastError === undefined) delete next.lastError;
    this.history.set(key, next);
  }
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Keep secrets out of the journal: it is plain text on disk. */
export function safeHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const hidden = new Set(['cookie', 'authorization', 'proxy-authorization']);
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || hidden.has(name.toLowerCase())) continue;
    out[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}
