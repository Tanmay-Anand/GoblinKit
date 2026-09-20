import type { CompiledGraph, CompiledNode } from '@goblin/graph';
import { resolveString } from '@goblin/expressions';
import type { Edge, Envelope, Item, JsonValue, NodeId, PortId } from '@goblin/spec';

import type { Command, NodeInvocation, RunEvent, SchedulerContext, Transition } from './protocol.js';
import {
  applyEntry,
  edgeKey,
  outputKey,
  scopeKey,
  type EdgeState,
  type JournalEntry,
  type NodeError,
  type RunState,
  type ScopePath,
  type ScopeState,
} from './state.js';

/**
 * advance — the scheduler.
 *
 * Pure: no I/O, no clock, no randomness, no async. The same (state, event, ctx)
 * always produces the same transition, which is what makes production journals
 * replayable on a laptop and makes golden-file tests a real regression net.
 *
 * It decides three things and nothing else: which journal entries record what
 * just became true, what the state therefore is, and which commands a driver
 * should carry out. Every side effect in the system is one of those commands.
 */
export function advance(state: RunState, event: RunEvent, ctx: SchedulerContext): Transition {
  const pass = new Pass(state, ctx);

  switch (event.kind) {
    case 'RunStarted':
      pass.startRun(event.trigger);
      break;
    case 'NodeSucceeded':
      pass.nodeSucceeded(event.nodeRunId, event.outputs);
      break;
    case 'NodeFailed':
      pass.nodeFailed(event.nodeRunId, event.error);
      break;
    case 'TimerFired':
      pass.timerFired(event.timerId);
      break;
    case 'SignalReceived':
      pass.signalReceived(event.signalId, event.payload);
      break;
    case 'CancelRequested':
      pass.cancel(event.reason);
      break;
  }

  pass.settle();
  return pass.finish();
}

const DEFAULT_RETRY = { maxAttempts: 1, backoffMs: 1_000, maxBackoffMs: 60_000 };
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_ITERATIONS = 1_000;

/** One candidate readiness check: a node instance at a particular scope path. */
interface Candidate {
  nodeId: NodeId;
  scopePath: ScopePath;
}

class Pass {
  state: RunState;
  private readonly entries: JournalEntry[] = [];
  private readonly commands: Command[] = [];
  private readonly queue: Candidate[] = [];
  private readonly ctx: SchedulerContext;
  private completed = false;

  constructor(state: RunState, ctx: SchedulerContext) {
    this.state = state;
    this.ctx = ctx;
  }

  /**
   * The only way state changes.
   *
   * Every mutation goes through a journal entry, so `fold(journal)` is the
   * state by construction rather than by careful maintenance of two parallel
   * code paths that must agree.
   */
  private emit(entry: JournalEntry): void {
    this.entries.push(entry);
    this.state = applyEntry(this.state, entry);
  }

  finish(): Transition {
    return { state: this.state, commands: this.commands, journal: this.entries };
  }

  private get now(): number {
    return this.ctx.now;
  }

  private node(id: NodeId): CompiledNode | undefined {
    return this.ctx.graph.nodes.get(id);
  }

  /* -------------------------------------------------------------------- *
   * Events
   * -------------------------------------------------------------------- */

  startRun(trigger: Envelope): void {
    this.emit({ kind: 'RunStarted', at: this.now, trigger });
    for (const triggerId of this.ctx.graph.triggers) {
      const node = this.node(triggerId);
      if (!node) continue;
      this.invoke(node, '', { main: trigger }, 1);
    }
  }

  nodeSucceeded(nodeRunId: string, outputs: Record<PortId, Envelope>): void {
    const run = this.state.nodeRuns[nodeRunId];
    if (!run || run.status !== 'running') return; // a late duplicate; at-least-once delivery is normal
    this.emit({ kind: 'NodeRunSucceeded', at: this.now, nodeRunId, outputs });

    const node = this.node(run.nodeId);
    if (!node) return;
    this.distribute(node, run.scopePath, outputs);
  }

  nodeFailed(nodeRunId: string, error: NodeError): void {
    const run = this.state.nodeRuns[nodeRunId];
    if (!run || run.status !== 'running') return;
    this.emit({ kind: 'NodeRunFailed', at: this.now, nodeRunId, error });

    const node = this.node(run.nodeId);
    if (!node) return;

    const policy = this.policyFor(node);
    const retryable = error.retryable !== false;

    if (retryable && run.attempt < policy.retry.maxAttempts) {
      // Exponential backoff, capped. The retry is a timer rather than a sleep
      // because a waiting run must not hold a worker.
      const delay = Math.min(policy.retry.backoffMs * 2 ** (run.attempt - 1), policy.retry.maxBackoffMs);
      const timerId = this.ctx.newId('timer', `${run.nodeId}#${run.scopePath}#retry${run.attempt}`);
      this.emit({
        kind: 'TimerScheduled',
        at: this.now,
        timer: {
          timerId,
          fireAt: this.now + delay,
          purpose: 'retry',
          nodeId: run.nodeId,
          scopePath: run.scopePath,
          attempt: run.attempt + 1,
        },
      });
      this.commands.push({ kind: 'ScheduleTimer', timerId, fireAt: this.now + delay });
      return;
    }

    switch (policy.onError) {
      case 'continue':
        // The node emitted nothing; downstream collapses the same way a
        // conditional branch does, with no special "failed" concept needed.
        this.distribute(node, run.scopePath, {});
        return;
      case 'route': {
        const errorItem: Item = {
          data: { message: error.message, code: error.code ?? null } as JsonValue,
          error: { message: error.message, ...(error.code ? { code: error.code } : {}) },
        };
        this.distribute(node, run.scopePath, {
          error: { items: [errorItem], meta: { node: node.id, port: 'error', scopePath: run.scopePath } },
        });
        return;
      }
      default:
        this.completeRun('failed', undefined, {
          message: error.message,
          ...(error.code ? { code: error.code } : {}),
          nodeId: run.nodeId,
          nodeRunId,
        });
    }
  }

  timerFired(timerId: string): void {
    const timer = this.state.pendingTimers[timerId];
    if (!timer) return;
    this.emit({ kind: 'TimerCleared', at: this.now, timerId });

    const node = this.node(timer.nodeId);
    if (!node) return;

    if (timer.purpose === 'retry') {
      const inputs = this.gatherInputs(node, timer.scopePath);
      this.invoke(node, timer.scopePath, inputs, timer.attempt);
      return;
    }

    // A wait finished: the node passes its input through unchanged.
    const inputs = this.gatherInputs(node, timer.scopePath);
    const envelope = inputs['main'] ?? { items: [] };
    this.distribute(node, timer.scopePath, { main: envelope });
  }

  signalReceived(signalId: string, payload: JsonValue): void {
    const wait = this.state.awaitedSignals[signalId];
    if (!wait) return;
    this.emit({ kind: 'SignalCleared', at: this.now, signalId });
    const node = this.node(wait.nodeId);
    if (!node) return;
    this.distribute(node, wait.scopePath, {
      main: { items: [{ data: payload }], meta: { node: node.id, port: 'main', scopePath: wait.scopePath } },
    });
  }

  cancel(reason: string): void {
    for (const run of Object.values(this.state.nodeRuns)) {
      if (run.status === 'running') {
        this.commands.push({ kind: 'CancelInvocation', nodeRunId: run.nodeRunId, reason });
      }
    }
    this.completeRun('cancelled', undefined, { message: reason });
  }

  /* -------------------------------------------------------------------- *
   * Distribution and readiness
   * -------------------------------------------------------------------- */

  /**
   * Deliver a node's outputs along its edges, and prune the rest.
   *
   * Pruning is the entire branching mechanism. A node that emitted nothing on
   * a port prunes that port's edges; a node whose required inputs are all
   * pruned is skipped and prunes its own outputs in turn. Conditional
   * branching, skipped error paths and collapsed loop exits are all this one
   * rule, so the engine needs no concept of a "branch" at all.
   */
  private distribute(
    node: CompiledNode,
    scopePath: ScopePath,
    outputs: Record<PortId, Envelope>,
    options: { pruneSilentPorts?: boolean } = {},
  ): void {
    // A finished node prunes the ports it did not emit on — that is what
    // collapses the untaken side of a branch. A scope mid-loop must NOT: it
    // emits `item` now and `done` later, and pruning `done` between iterations
    // would skip everything after the loop before the loop had finished.
    const pruneSilentPorts = options.pruneSilentPorts ?? true;

    for (const port of node.manifest.ports.outputs) {
      const envelope = outputs[port.id];
      if (!envelope && !pruneSilentPorts) continue;
      const edges = (this.ctx.graph.outgoing.get(node.id) ?? []).filter((e) => e.from.port === port.id);

      for (const edge of edges) {
        const targetPath = this.targetScopePath(edge, scopePath);
        if (!envelope) {
          this.prune(edge, targetPath, `${node.id} emitted nothing on port ${port.id}`);
          continue;
        }
        if (edge.condition && !this.edgeConditionHolds(edge, envelope, scopePath)) {
          this.prune(edge, targetPath, `edge condition was false`);
          continue;
        }
        this.deliver(edge, targetPath, envelope);
      }
    }
  }

  private deliver(edge: Edge, scopePath: ScopePath, envelope: Envelope): void {
    this.emit({ kind: 'EdgeDelivered', at: this.now, key: edgeKey(edge.id, scopePath), envelope });
    this.queue.push({ nodeId: edge.to.node, scopePath });
  }

  private prune(edge: Edge, scopePath: ScopePath, reason: string): void {
    this.emit({ kind: 'EdgePruned', at: this.now, key: edgeKey(edge.id, scopePath), reason });
    this.queue.push({ nodeId: edge.to.node, scopePath });
  }

  /**
   * An edge into a scope body addresses the current iteration; an edge leaving
   * one addresses the parent. Everything else stays where it is.
   */
  private targetScopePath(edge: Edge, sourcePath: ScopePath): ScopePath {
    const source = this.node(edge.from.node);
    const target = this.node(edge.to.node);
    if (!source || !target) return sourcePath;

    if (source.manifest.scope?.role === 'start' && edge.from.port === 'item') {
      const scope = this.state.scopes[scopeKey(source.id, sourcePath)];
      const iteration = scope?.iteration ?? 0;
      return sourcePath ? `${sourcePath}/${source.id}[${iteration}]` : `${source.id}[${iteration}]`;
    }
    if (source.manifest.scope?.role === 'end') {
      return parentPath(sourcePath);
    }
    return sourcePath;
  }

  /** Walk the queue until nothing else can be decided. */
  settle(): void {
    const guard = new Set<string>();
    while (this.queue.length > 0 && !this.completed) {
      const candidate = this.queue.shift()!;
      const key = `${candidate.nodeId}#${candidate.scopePath}`;
      // Re-queueing the same candidate repeatedly is normal — several edges
      // arrive at one node — but re-evaluating it more than once per settle
      // after it has started is not.
      if (guard.has(key) && this.hasRunAt(candidate.nodeId, candidate.scopePath)) continue;
      guard.add(key);
      this.evaluate(candidate);
    }
    if (!this.completed) this.checkCompletion();
  }

  private hasRunAt(nodeId: NodeId, scopePath: ScopePath): boolean {
    return Object.values(this.state.nodeRuns).some(
      (r) => r.nodeId === nodeId && r.scopePath === scopePath && r.status !== 'failed',
    );
  }

  private evaluate(candidate: Candidate): void {
    const node = this.node(candidate.nodeId);
    if (!node) return;
    if (this.hasRunAt(node.id, candidate.scopePath)) return;

    const readiness = this.readiness(node, candidate.scopePath);
    if (readiness === 'pending') return;

    if (readiness === 'skip') {
      this.emit({
        kind: 'NodeRunSkipped',
        at: this.now,
        nodeId: node.id,
        scopePath: candidate.scopePath,
        reason: 'every required input was pruned',
      });
      this.distribute(node, candidate.scopePath, {});
      return;
    }

    const inputs = this.gatherInputs(node, candidate.scopePath);

    // Nodes the engine implements itself, because they are scheduling
    // decisions rather than work: a loop and a wait must not occupy a worker.
    if (node.manifest.scope?.role === 'start') {
      this.enterScope(node, candidate.scopePath, inputs['main'] ?? { items: [] });
      return;
    }
    if (node.manifest.scope?.role === 'end') {
      this.closeIteration(node, candidate.scopePath, inputs['main'] ?? { items: [] });
      return;
    }
    if (node.manifest.type === 'core.wait') {
      this.scheduleWait(node, candidate.scopePath, inputs);
      return;
    }

    this.invoke(node, candidate.scopePath, inputs, 1);
  }

  /**
   * A node is Ready when every input port's join policy is satisfied and no
   * inbound edge is still Pending. It is Skipped when every inbound edge on
   * every required port is Pruned.
   */
  private readiness(node: CompiledNode, scopePath: ScopePath): 'ready' | 'pending' | 'skip' {
    if (node.manifest.trigger) return 'pending'; // triggers are started by RunStarted, never by an edge

    let sawAnyEdge = false;
    let everyRequiredPruned = true;

    for (const port of node.manifest.ports.inputs) {
      const edges = (this.ctx.graph.incoming.get(node.id) ?? []).filter((e) => e.to.port === port.id);
      if (edges.length === 0) continue;
      sawAnyEdge = true;

      const states = edges.map((e) => this.state.edges[edgeKey(e.id, scopePath)] ?? { status: 'pending' });
      const delivered = states.filter((s) => s.status === 'delivered').length;
      const pruned = states.filter((s) => s.status === 'pruned').length;
      const join = port.join ?? 'all';

      const satisfied =
        join === 'all'
          ? delivered === states.length
          : join === 'collect'
            ? delivered + pruned === states.length
            : delivered >= 1; // 'any' and 'race'

      if (!satisfied) {
        // Still waiting on this port — unless everything on it is pruned, in
        // which case a required port makes the node unreachable.
        if (pruned === states.length) {
          if (port.required) continue; // contributes to the skip decision below
          continue;
        }
        return 'pending';
      }

      if (port.required && pruned !== states.length) everyRequiredPruned = false;
      if (!port.required && delivered > 0) everyRequiredPruned = false;
    }

    if (!sawAnyEdge) return 'pending';
    if (everyRequiredPruned) return 'skip';

    // 'any' and 'race' do not wait for the stragglers: the remaining pending
    // edges are pruned so the branch behind them collapses instead of hanging.
    for (const port of node.manifest.ports.inputs) {
      const join = port.join ?? 'all';
      if (join !== 'any' && join !== 'race') continue;
      const edges = (this.ctx.graph.incoming.get(node.id) ?? []).filter((e) => e.to.port === port.id);
      for (const edge of edges) {
        const st = this.state.edges[edgeKey(edge.id, scopePath)];
        if (!st || st.status === 'pending') {
          this.emit({
            kind: 'EdgePruned',
            at: this.now,
            key: edgeKey(edge.id, scopePath),
            reason: `join policy '${join}' was already satisfied`,
          });
        }
      }
    }
    return 'ready';
  }

  private gatherInputs(node: CompiledNode, scopePath: ScopePath): Record<PortId, Envelope> {
    const inputs: Record<PortId, Envelope> = {};
    for (const port of node.manifest.ports.inputs) {
      const edges = (this.ctx.graph.incoming.get(node.id) ?? []).filter((e) => e.to.port === port.id);
      const items: Item[] = [];
      let any = false;
      for (const edge of edges) {
        const st: EdgeState | undefined = this.state.edges[edgeKey(edge.id, scopePath)];
        if (st?.status === 'delivered') {
          any = true;
          items.push(...st.envelope.items);
        }
      }
      if (any) inputs[port.id] = { items, meta: { node: node.id, port: port.id, scopePath } };
    }
    return inputs;
  }

  /* -------------------------------------------------------------------- *
   * Scopes
   * -------------------------------------------------------------------- */

  private enterScope(node: CompiledNode, scopePath: ScopePath, input: Envelope): void {
    const key = scopeKey(node.id, scopePath);
    let scope = this.state.scopes[key];

    if (!scope) {
      const kind = node.manifest.scope?.kind ?? 'forEach';
      const opened: ScopeState = {
        scopeId: node.id,
        path: scopePath,
        kind,
        iteration: 0,
        items: kind === 'forEach' ? this.scopeItems(node, input) : [],
        results: [],
        status: 'open',
      };
      this.emit({ kind: 'ScopeOpened', at: this.now, key, scope: opened });
      scope = opened;
    }

    this.runIteration(node, scopePath, key);
  }

  private runIteration(node: CompiledNode, scopePath: ScopePath, key: string): void {
    const scope = this.state.scopes[key];
    if (!scope) return;

    const limit = this.iterationLimit(node);
    if (scope.iteration >= limit) {
      // A termination bound is structural here rather than advisory: a loop
      // that cannot end is a run that cannot end, and no amount of care in the
      // document should be able to produce one.
      this.completeRun('failed', undefined, {
        message: `Scope ${node.id} hit its iteration limit of ${limit}.`,
        code: 'SCOPE_LIMIT',
        nodeId: node.id,
      });
      return;
    }

    const keepGoing =
      scope.kind === 'forEach'
        ? scope.iteration < scope.items.length
        : this.whileConditionHolds(node, scope);

    if (keepGoing) {
      const item: Item =
        scope.kind === 'forEach'
          ? { data: scope.items[scope.iteration] ?? null }
          : { data: { iteration: scope.iteration } as JsonValue };
      this.distribute(
        node,
        scopePath,
        { item: { items: [item], meta: { node: node.id, port: 'item', scopePath } } },
        { pruneSilentPorts: false },
      );
      return;
    }

    this.emit({ kind: 'ScopeClosed', at: this.now, key });
    const results: Item[] = scope.results.map((data) => ({ data }));
    // The body's edges live at per-iteration paths and have all resolved, so
    // closing only has to deliver `done`. Pruning `item` here would address a
    // body node at the PARENT path — an instance that never existed — and
    // report it as skipped.
    this.distribute(
      node,
      scopePath,
      { done: { items: results, meta: { node: node.id, port: 'done', scopePath } } },
      { pruneSilentPorts: false },
    );
  }

  private closeIteration(node: CompiledNode, scopePath: ScopePath, input: Envelope): void {
    // The end node lives inside the iteration, so its path names the scope
    // instance it is closing.
    const start = [...this.ctx.graph.scopeEnds.entries()].find(([, end]) => end === node.id)?.[0];
    if (!start) return;
    const parent = parentPath(scopePath);
    const key = scopeKey(start, parent);
    const scope = this.state.scopes[key];
    if (!scope) return;

    const result: JsonValue = input.items.length === 1 ? (input.items[0]?.data ?? null) : input.items.map((i) => i.data);
    this.emit({ kind: 'ScopeIterated', at: this.now, key, iteration: scope.iteration + 1, result });

    const startNode = this.node(start);
    if (startNode) this.runIteration(startNode, parent, key);
  }

  /**
   * What a forEach walks.
   *
   * By default the input envelope's items, which is right when an upstream
   * node already produced one item per thing. But the common shape is one item
   * holding a list — an order with lines, a response with results — and
   * forcing a split node in between is the papercut that makes people give up
   * on loops. An `items` expression names the collection directly.
   */
  private scopeItems(node: CompiledNode, input: Envelope): JsonValue[] {
    const expression = (node.instance.config as Record<string, unknown>)['items'];
    if (typeof expression === 'string' && expression.trim() !== '') {
      const value = resolveString(expression, {
        json: input.items[0]?.data ?? null,
        items: input.items.map((i) => i.data),
        vars: this.ctx.graph.document.variables ?? {},
        run: { id: this.state.runId },
      });
      if (Array.isArray(value)) return value;
      // Not an array: one iteration over the single value is more useful than
      // silently iterating zero times, which reads as "the loop did nothing".
      return value === null ? [] : [value];
    }
    return input.items.map((i) => i.data);
  }

  private iterationLimit(node: CompiledNode): number {
    const configured = Number((node.instance.config as Record<string, unknown>)['maxIterations'] ?? NaN);
    if (Number.isFinite(configured) && configured > 0) return configured;
    const fromSettings = this.ctx.graph.document.settings?.maxIterations;
    return fromSettings && fromSettings > 0 ? fromSettings : DEFAULT_MAX_ITERATIONS;
  }

  private whileConditionHolds(node: CompiledNode, scope: ScopeState): boolean {
    const condition = (node.instance.config as Record<string, unknown>)['condition'];
    if (typeof condition !== 'string' || condition.trim() === '') return false;
    const value = resolveString(condition, {
      vars: this.ctx.graph.document.variables ?? {},
      loop: {
        iteration: scope.iteration,
        last: scope.results[scope.results.length - 1] ?? null,
        results: scope.results,
      },
      run: { id: this.state.runId },
    });
    return value === true || value === 'true';
  }

  /* -------------------------------------------------------------------- *
   * Invocation, waiting, completion
   * -------------------------------------------------------------------- */

  private invoke(node: CompiledNode, scopePath: ScopePath, inputs: Record<PortId, Envelope>, attempt: number): void {
    const seed = `${node.id}#${scopePath}#${attempt}`;
    const nodeRunId = this.ctx.newId('nodeRun', seed);
    const policy = this.policyFor(node);

    // Pinned data short-circuits execution with a fixed envelope, so a node
    // can be developed against a real captured response without re-hitting the
    // API on every iteration of the edit loop.
    if (node.instance.pinnedData) {
      this.emit({ kind: 'NodeRunStarted', at: this.now, nodeRunId, nodeId: node.id, scopePath, attempt });
      this.emit({
        kind: 'NodeRunSucceeded',
        at: this.now,
        nodeRunId,
        outputs: { main: node.instance.pinnedData },
      });
      this.distribute(node, scopePath, { main: node.instance.pinnedData });
      return;
    }

    this.emit({ kind: 'NodeRunStarted', at: this.now, nodeRunId, nodeId: node.id, scopePath, attempt });

    const invocation: NodeInvocation = {
      nodeRunId,
      nodeId: node.id,
      scopePath,
      type: node.manifest.type,
      typeVersion: node.manifest.version,
      config: node.instance.config,
      input: inputs,
      credentials: node.instance.credentials ?? {},
      attempt,
      deadline: this.now + policy.timeoutMs,
      // Stable across retries of one logical step: the attempt is deliberately
      // NOT part of the key, which is what stops a retried "create charge"
      // charging twice.
      idempotencyKey: this.ctx.newId('nodeRun', `idem|${this.state.runId}|${node.id}|${scopePath}|${hashInputs(inputs)}`),
    };
    this.commands.push({ kind: 'InvokeNode', invocation });
  }

  private scheduleWait(node: CompiledNode, scopePath: ScopePath, inputs: Record<PortId, Envelope>): void {
    const ms = Number((node.instance.config as Record<string, unknown>)['ms'] ?? 0);
    const timerId = this.ctx.newId('timer', `${node.id}#${scopePath}#wait`);

    // Recorded as a node run so the wait appears in the run's history like any
    // other step, then immediately parked on a timer holding no worker.
    const nodeRunId = this.ctx.newId('nodeRun', `${node.id}#${scopePath}#wait`);
    this.emit({ kind: 'NodeRunStarted', at: this.now, nodeRunId, nodeId: node.id, scopePath, attempt: 1 });
    this.emit({
      kind: 'NodeRunSucceeded',
      at: this.now,
      nodeRunId,
      outputs: { main: inputs['main'] ?? { items: [] } },
    });
    this.emit({
      kind: 'TimerScheduled',
      at: this.now,
      timer: { timerId, fireAt: this.now + ms, purpose: 'wait', nodeId: node.id, scopePath, attempt: 1 },
    });
    this.commands.push({ kind: 'ScheduleTimer', timerId, fireAt: this.now + ms });
  }

  private policyFor(node: CompiledNode): { retry: typeof DEFAULT_RETRY; timeoutMs: number; onError: 'fail' | 'continue' | 'route' } {
    const fromDocument = this.ctx.graph.document.settings?.defaultPolicy ?? {};
    const fromManifest = node.manifest.defaults?.policy ?? {};
    const fromNode = node.instance.policy ?? {};
    return {
      retry: {
        ...DEFAULT_RETRY,
        ...(fromDocument.retry ?? {}),
        ...(fromManifest.retry ?? {}),
        ...(fromNode.retry ?? {}),
      },
      timeoutMs: fromNode.timeoutMs ?? fromManifest.timeoutMs ?? fromDocument.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      onError: fromNode.onError ?? fromManifest.onError ?? fromDocument.onError ?? 'fail',
    };
  }

  private edgeConditionHolds(edge: Edge, envelope: Envelope, scopePath: ScopePath): boolean {
    if (!edge.condition) return true;
    const value = resolveString(edge.condition, {
      json: envelope.items[0]?.data ?? null,
      items: envelope.items.map((i) => i.data),
      vars: this.ctx.graph.document.variables ?? {},
      run: { id: this.state.runId, scopePath },
    });
    return value === true || value === 'true';
  }

  private checkCompletion(): void {
    if (this.state.status === 'succeeded' || this.state.status === 'failed' || this.state.status === 'cancelled') return;

    const running = Object.values(this.state.nodeRuns).some((r) => r.status === 'running');
    const waiting =
      Object.keys(this.state.pendingTimers).length > 0 || Object.keys(this.state.awaitedSignals).length > 0;

    if (running || waiting || this.queue.length > 0) {
      if (waiting && !running && this.state.status !== 'waiting') {
        this.emit({ kind: 'RunStatusChanged', at: this.now, status: 'waiting' });
      }
      return;
    }

    this.completeRun('succeeded', this.terminalOutput());
  }

  /**
   * The run's output is what its terminal nodes emitted.
   *
   * Terminal meaning "no outgoing edges" rather than "the last one to finish":
   * a graph with two branches has no single last node, and picking one by
   * timing would make the run's output depend on scheduling.
   */
  private terminalOutput(): Envelope | undefined {
    const items: Item[] = [];
    for (const [nodeId, node] of this.ctx.graph.nodes) {
      const outgoing = this.ctx.graph.outgoing.get(nodeId) ?? [];
      if (outgoing.length > 0) continue;
      for (const port of node.manifest.ports.outputs) {
        const envelope = this.state.outputs[outputKey(nodeId, port.id, '')];
        if (envelope) items.push(...envelope.items);
      }
    }
    return items.length > 0 ? { items } : undefined;
  }

  private completeRun(status: 'succeeded' | 'failed' | 'cancelled', output?: Envelope, error?: RunState['error']): void {
    if (this.completed) return;
    this.completed = true;
    this.emit({
      kind: 'RunCompleted',
      at: this.now,
      status,
      ...(output ? { output } : {}),
      ...(error ? { error } : {}),
    });
    this.commands.push({
      kind: 'CompleteRun',
      status,
      ...(output ? { output } : {}),
      ...(error ? { error: { message: error.message, ...(error.code ? { code: error.code } : {}) } } : {}),
    });
  }
}

/** "loop1[3]/inner[0]" → "loop1[3]"; "loop1[3]" → "". */
function parentPath(path: ScopePath): ScopePath {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? '' : path.slice(0, cut);
}

/**
 * A stable digest of a node's inputs, for the idempotency key.
 *
 * Deliberately structural rather than cryptographic: the pure core has no
 * crypto and must not acquire one. The driver hashes the seed it is handed
 * (see SchedulerContext.newId), so the strength of the final key is the
 * driver's choice, not a property baked into the scheduler.
 */
function hashInputs(inputs: Record<PortId, Envelope>): string {
  const parts: string[] = [];
  for (const port of Object.keys(inputs).sort()) {
    parts.push(`${port}:${JSON.stringify(inputs[port]?.items.map((i) => i.data) ?? [])}`);
  }
  return parts.join('|');
}
