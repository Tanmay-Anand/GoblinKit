/**
 * @goblin/nodes-core — the node set every workflow needs.
 *
 * Deliberately small. These exist to prove the engine's semantics rather than
 * to cover integrations: a trigger, a transform, two ways to branch, a merge,
 * an HTTP call, a loop, a wait and a log. If the engine is right, an
 * integration pack is mechanical; if it is wrong, no amount of integrations
 * will hide it.
 *
 * Note which of these have no executor at all. `core.scope.*` and `core.wait`
 * are implemented inside the scheduler, because looping and waiting are
 * scheduling decisions — a run waiting three days must hold no worker, and a
 * loop must be addressable per iteration in the journal. A node that merely
 * slept would give away both.
 */

import { defineExecutor, defineManifest, NodeFailure, type NodeDefinition } from '@goblin/node-sdk';
import { evaluate } from '@goblin/expressions';
import type { Item, JsonObject, JsonValue, NodeManifest } from '@goblin/spec';

/* ------------------------------------------------------------------ manual */

export const manualTrigger = defineManifest({
  type: 'core.trigger.manual',
  version: 1,
  title: 'Manual trigger',
  group: 'trigger',
  description: 'Starts a run with whatever input the run was given.',
  executionMode: 'batch',
  trigger: true,
  ports: { inputs: [], outputs: [{ id: 'main' }] },
});

const manualTriggerNode = defineExecutor(manualTrigger, (ctx) => ctx.emit('main', [...ctx.items]));

/* --------------------------------------------------------------------- set */

export const setManifest = defineManifest({
  type: 'core.transform.set',
  version: 1,
  title: 'Set',
  group: 'transform',
  description: 'Build a new item from expressions over the incoming one.',
  executionMode: 'perItem',
  ports: {
    inputs: [{ id: 'main', required: true, join: 'all' }],
    outputs: [{ id: 'main' }],
  },
  config: {
    fields: [
      { name: 'values', type: 'json', label: 'Fields', description: 'Object of name → expression', default: {} },
      { name: 'keepInput', type: 'boolean', label: 'Keep input fields', default: true },
    ],
  },
});

const setNode = defineExecutor(setManifest, (ctx) => {
  const out: Item[] = ctx.items.map((item, index) => {
    const cfg = ctx.resolveConfig<{ values?: JsonObject; keepInput?: boolean }>({
      json: item.data,
      items: ctx.items.map((i) => i.data),
    });
    const base = cfg.keepInput !== false && item.data && typeof item.data === 'object' && !Array.isArray(item.data)
      ? { ...(item.data as JsonObject) }
      : {};
    return {
      data: { ...base, ...(cfg.values ?? {}) } as JsonValue,
      lineage: [{ sourceNode: ctx.nodeId, sourcePort: 'main', itemIndex: index }],
    };
  });
  return ctx.emit('main', out);
});

/* ---------------------------------------------------------------------- if */

export const ifManifest = defineManifest({
  type: 'core.control.if',
  version: 1,
  title: 'If',
  group: 'control',
  description: 'Route items to true or false by a condition.',
  executionMode: 'batch',
  ports: {
    inputs: [{ id: 'main', required: true, join: 'all' }],
    outputs: [{ id: 'true' }, { id: 'false' }],
  },
  config: {
    fields: [{ name: 'condition', type: 'expression', required: true, label: 'Condition' }],
  },
});

/**
 * If is an ordinary node with two output ports.
 *
 * The engine has no idea it is a branch: a port that emits nothing prunes its
 * edges, and pruning propagates. Branching, error routing and loop exits are
 * all the same mechanism, which is why the engine stays domain-agnostic.
 */
const ifNode = defineExecutor(ifManifest, (ctx) => {
  const condition = String((ctx.config as { condition?: unknown }).condition ?? '');
  const passed: Item[] = [];
  const failed: Item[] = [];

  ctx.items.forEach((item, index) => {
    const value = evaluate(stripBraces(condition), {
      json: item.data,
      items: ctx.items.map((i) => i.data),
    });
    const lineage = [{ sourceNode: ctx.nodeId, sourcePort: 'main', itemIndex: index }];
    (truthy(value) ? passed : failed).push({ ...item, lineage });
  });

  const out: Record<string, { items: Item[] }> = {};
  // A port with no items emits nothing at all rather than an empty envelope:
  // "no items" and "this branch was not taken" are different facts, and only
  // the second one should collapse the downstream branch.
  if (passed.length > 0) Object.assign(out, ctx.emit('true', passed));
  if (failed.length > 0) Object.assign(out, ctx.emit('false', failed));
  return out;
});

/* ------------------------------------------------------------------ switch */

export const switchManifest = defineManifest({
  type: 'core.control.switch',
  version: 1,
  title: 'Switch',
  group: 'control',
  description: 'Route each item to the first matching case.',
  executionMode: 'batch',
  ports: {
    inputs: [{ id: 'main', required: true, join: 'all' }],
    outputs: [{ id: '0' }, { id: '1' }, { id: '2' }, { id: '3' }, { id: 'fallback' }],
  },
  config: {
    fields: [{ name: 'cases', type: 'json', label: 'Cases', description: 'Array of condition expressions', default: [] }],
  },
});

const switchNode = defineExecutor(switchManifest, (ctx) => {
  const cases = ((ctx.config as { cases?: unknown }).cases ?? []) as string[];
  const buckets = new Map<string, Item[]>();

  ctx.items.forEach((item, index) => {
    const lineage = [{ sourceNode: ctx.nodeId, sourcePort: 'main', itemIndex: index }];
    const matched = cases.findIndex((expr) =>
      truthy(evaluate(stripBraces(String(expr)), { json: item.data, items: ctx.items.map((i) => i.data) })),
    );
    const port = matched === -1 ? 'fallback' : String(matched);
    const list = buckets.get(port) ?? [];
    list.push({ ...item, lineage });
    buckets.set(port, list);
  });

  const out: Record<string, { items: Item[] }> = {};
  for (const [port, items] of buckets) Object.assign(out, ctx.emit(port, items));
  return out;
});

/* ------------------------------------------------------------------- merge */

export const mergeManifest = defineManifest({
  type: 'core.control.merge',
  version: 1,
  title: 'Merge',
  group: 'control',
  description: 'Combine inputs into one stream. Runs whichever branch arrived.',
  executionMode: 'batch',
  ports: {
    // 'collect' is the policy most engines are missing: it fires once every
    // inbound edge has RESOLVED, delivered or pruned, which is what "do this
    // regardless of which branch ran" actually means.
    inputs: [
      { id: 'a', join: 'collect' },
      { id: 'b', join: 'collect' },
    ],
    outputs: [{ id: 'main' }],
  },
});

const mergeNode = defineExecutor(mergeManifest, (ctx) => {
  const items = [...(ctx.input['a']?.items ?? []), ...(ctx.input['b']?.items ?? [])];
  return ctx.emit('main', items);
});

/* -------------------------------------------------------------------- http */

export const httpManifest = defineManifest({
  type: 'core.http.request',
  version: 1,
  title: 'HTTP Request',
  group: 'core',
  description: 'Make an HTTP request, once per item.',
  executionMode: 'perItem',
  ports: {
    inputs: [{ id: 'main', required: true, join: 'all' }],
    outputs: [{ id: 'main' }, { id: 'error' }],
  },
  config: {
    fields: [
      { name: 'method', type: 'select', options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], default: 'GET' },
      { name: 'url', type: 'expression', required: true },
      { name: 'headers', type: 'json', default: {} },
      { name: 'body', type: 'json' },
      { name: 'timeoutMs', type: 'number', default: 30_000 },
    ],
  },
  defaults: { policy: { retry: { maxAttempts: 3, backoffMs: 500, maxBackoffMs: 30_000 } } },
});

const httpNode = defineExecutor(httpManifest, async (ctx) => {
  const out: Item[] = [];
  for (const [index, item] of ctx.items.entries()) {
    const cfg = ctx.resolveConfig<{
      method?: string;
      url?: string;
      headers?: Record<string, string>;
      body?: JsonValue;
      timeoutMs?: number;
    }>({ json: item.data, items: ctx.items.map((i) => i.data) });

    const url = cfg.url;
    // Thrown rather than routed through ctx.fail so the compiler can see that
    // control does not continue — a missing URL is a config error that no
    // number of retries will fix.
    if (!url) throw new NodeFailure('No URL configured', { code: 'CONFIG', retryable: false });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), cfg.timeoutMs ?? 30_000);
    // The engine's abort signal and the node's own timeout both have to reach
    // fetch, or a cancelled run leaves a request running.
    ctx.signal.addEventListener('abort', () => controller.abort(), { once: true });

    try {
      const res = await fetch(url, {
        method: cfg.method ?? 'GET',
        headers: {
          'content-type': 'application/json',
          // Forwarded so a retried step is recognised as the same step by any
          // provider that honours it.
          'idempotency-key': ctx.idempotencyKey,
          ...(cfg.headers ?? {}),
        },
        ...(cfg.body !== undefined && cfg.method !== 'GET' ? { body: JSON.stringify(cfg.body) } : {}),
        signal: controller.signal,
      });

      const text = await res.text();
      let data: JsonValue;
      try {
        data = text ? (JSON.parse(text) as JsonValue) : null;
      } catch {
        data = text;
      }

      if (!res.ok) {
        // 4xx is the caller's fault and will fail identically next time; 5xx
        // and 429 are worth another attempt. Classifying here means the
        // engine's retry policy does the right thing without each node author
        // reasoning about it.
        ctx.fail(`HTTP ${res.status} from ${url}`, {
          code: `HTTP_${res.status}`,
          retryable: res.status >= 500 || res.status === 429,
        });
      }

      out.push({
        data: { status: res.status, body: data } as JsonValue,
        lineage: [{ sourceNode: ctx.nodeId, sourcePort: 'main', itemIndex: index }],
      });
    } finally {
      clearTimeout(timeout);
    }
  }
  return ctx.emit('main', out);
});

/* --------------------------------------------------------------------- log */

export const logManifest = defineManifest({
  type: 'core.log',
  version: 1,
  title: 'Log',
  group: 'core',
  description: 'Pass items through, recording them in the run log.',
  executionMode: 'batch',
  ports: {
    inputs: [{ id: 'main', required: true, join: 'all' }],
    outputs: [{ id: 'main' }],
  },
  config: { fields: [{ name: 'message', type: 'expression' }] },
});

const logNode = defineExecutor(logManifest, (ctx) => {
  const cfg = ctx.resolveConfig<{ message?: string }>();
  ctx.logger.info(cfg.message ?? `${ctx.items.length} items`, ctx.items.map((i) => i.data) as JsonValue);
  return ctx.emit('main', [...ctx.items]);
});

/* ------------------------------------------------------- engine-implemented */

export const forEachManifest = defineManifest({
  type: 'core.scope.forEach',
  version: 1,
  title: 'For each',
  group: 'control',
  description: 'Run the body once per input item. Ends at a matching Scope end.',
  executionMode: 'batch',
  scope: { role: 'start', kind: 'forEach' },
  ports: {
    inputs: [{ id: 'main', required: true, join: 'all' }],
    outputs: [{ id: 'item' }, { id: 'done' }],
  },
  config: {
    fields: [
      {
        name: 'items',
        type: 'expression',
        description: 'Collection to walk, e.g. {{ $json.lines }}. Defaults to the input items.',
      },
      { name: 'maxIterations', type: 'number', default: 1000 },
    ],
  },
});

export const whileManifest = defineManifest({
  type: 'core.scope.while',
  version: 1,
  title: 'While',
  group: 'control',
  description: 'Run the body while a condition holds.',
  executionMode: 'batch',
  scope: { role: 'start', kind: 'while' },
  ports: {
    inputs: [{ id: 'main', required: true, join: 'all' }],
    outputs: [{ id: 'item' }, { id: 'done' }],
  },
  config: {
    fields: [
      { name: 'condition', type: 'expression', required: true, description: 'Evaluated with $loop.iteration and $loop.last' },
      { name: 'maxIterations', type: 'number', default: 1000 },
    ],
  },
});

export const scopeEndManifest = defineManifest({
  type: 'core.scope.end',
  version: 1,
  title: 'Scope end',
  group: 'control',
  description: 'Closes the innermost scope and records the iteration result.',
  executionMode: 'batch',
  scope: { role: 'end' },
  ports: {
    inputs: [{ id: 'main', required: true, join: 'all' }],
    outputs: [],
  },
});

export const waitManifest = defineManifest({
  type: 'core.wait',
  version: 1,
  title: 'Wait',
  group: 'control',
  description: 'Pause, holding no worker. A timer revives the run.',
  executionMode: 'batch',
  ports: {
    inputs: [{ id: 'main', required: true, join: 'all' }],
    outputs: [{ id: 'main' }],
  },
  config: { fields: [{ name: 'ms', type: 'number', required: true, default: 1000 }] },
});

/* ------------------------------------------------------------------ exports */

/** Every manifest in the pack, including the ones the engine implements. */
export const coreManifests: NodeManifest[] = [
  manualTrigger,
  setManifest,
  ifManifest,
  switchManifest,
  mergeManifest,
  httpManifest,
  logManifest,
  forEachManifest,
  whileManifest,
  scopeEndManifest,
  waitManifest,
];

/** Only the nodes that have an executor. The rest are scheduling decisions. */
export const coreNodes: NodeDefinition[] = [
  manualTriggerNode,
  setNode,
  ifNode,
  switchNode,
  mergeNode,
  httpNode,
  logNode,
];

function stripBraces(expr: string): string {
  const match = expr.match(/^\s*\{\{([\s\S]*)\}\}\s*$/);
  return match?.[1] ?? expr;
}

function truthy(value: JsonValue): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  return Boolean(value);
}
