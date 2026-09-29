/**
 * @goblin/nodes-bench — measuring API endpoints, and noticing when they slow.
 *
 * The manual "endpoint latency check with curl" guide as four boxes:
 *
 *   targets ─► Measure latency ─► Compare variants ─┬► Check against baseline
 *                                                   └► Before/after chart
 *
 * Thin by design. Timing, credentials, files and durable state are platform
 * capabilities (`ctx.http`, `ctx.credential`, `ctx.blobs`, `ctx.state`), and
 * the statistics are @goblin/fn's — the pack only decides what to measure
 * and what the numbers mean.
 */

import { defineExecutor, defineManifest, type ActionHandler, type HttpMethod, type NodeDefinition } from '@goblin/node-sdk';
import type { Item, JsonObject, JsonValue, NodeManifest } from '@goblin/spec';

import { baselineKey, environmentOf, isRegression, judge, readStored, type BaselinePolicy, type BaselineSettings, type TargetResult } from './baseline.js';
import { renderChart, type ChartMetric } from './chart.js';
import { compareAll, DEFAULT_NOISE_FLOOR, type Comparison } from './compare.js';
import { isFailure, measurementsIn, measureTarget, type Measurement, type TargetRequest } from './measure.js';
import { renderReport } from './report.js';

export { compareAll, DEFAULT_NOISE_FLOOR, type Comparison, type NoiseFloor } from './compare.js';
export { judge, baselineKey, environmentOf, type StoredBaseline, type TargetResult, type BaselinePolicy } from './baseline.js';
export { renderChart, type ChartMetric } from './chart.js';
export { measureTarget, measurementsIn, type Measurement, type TargetFailure } from './measure.js';
export { renderReport } from './report.js';

const AUTH_SLOT = {
  name: 'auth',
  label: 'Sign in with',
  accepts: ['httpAuth@1', 'httpSigner@1'],
  description: 'Applied to every request for you: a Cognito refresh token, a bearer token, an API key.',
};

/* ---------------------------------------------------------------- measure */

export const measureManifest = defineManifest({
  type: 'bench.http.measure',
  version: 1,
  title: 'Measure latency',
  group: 'measure',
  description: 'Time an endpoint per item: warm up, then several timed requests. Emits the numbers, never the bodies.',
  executionMode: 'perItem',
  // One request on the wire at a time, or the targets would be timing each other.
  maxConcurrency: 1,
  ports: {
    inputs: [{ id: 'main', required: true, join: 'all' }],
    outputs: [
      { id: 'main', label: 'Measured' },
      { id: 'error', label: 'Could not measure' },
    ],
  },
  credentials: [AUTH_SLOT],
  config: {
    fields: [
      { name: 'url', label: 'URL', type: 'expression', required: true, default: '{{ $json.url }}', description: 'The endpoint to time. Defaults to each item’s url.' },
      { name: 'key', label: 'Endpoint name', type: 'expression', default: '{{ $json.key }}', description: 'Groups variants of one endpoint, e.g. "projects".' },
      { name: 'label', label: 'Variant', type: 'expression', default: '{{ $json.label }}', description: '"old" and "new", or "full" and "list".' },
      { name: 'method', label: 'Method', type: 'select', options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], default: 'GET' },
      { name: 'headers', label: 'Headers', type: 'json', default: {}, description: 'Plain headers like x-tenant-id. Tokens belong in the credential.' },
      { name: 'warmupRuns', label: 'Warm-up requests', type: 'number', default: 1, description: 'Sent first and not timed: they prime caches and the connection.' },
      { name: 'runs', label: 'Timed requests', type: 'number', default: 5, description: 'p95 is reported from 20 up; below that, the maximum.' },
      { name: 'timeoutMs', label: 'Give up after (ms)', type: 'number', default: 30_000 },
      { name: 'expectStatus', label: 'Counts as an answer', type: 'select', options: ['2xx', '2xx or 3xx', 'any'], default: '2xx' },
    ],
  },
  // A measurement is not retried: a retry would hide exactly the slowness it exists to find.
  defaults: { policy: { retry: { maxAttempts: 1, backoffMs: 0, maxBackoffMs: 0 } } },
});

const clamp = (n: unknown, lo: number, hi: number, fallback: number) =>
  typeof n === 'number' && Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : fallback;

const measureNode = defineExecutor(measureManifest, async (ctx) => {
  const auth = await ctx.credential('auth');
  const measured: Item[] = [];
  const failed: Item[] = [];

  // One target after another (maxConcurrency: 1). Each one's failure is its
  // own: a timeout on one endpoint still leaves the others' numbers.
  for (const [index, item] of ctx.items.entries()) {
    const cfg = ctx.resolveConfig<{
      url?: JsonValue;
      key?: JsonValue;
      label?: JsonValue;
      method?: HttpMethod;
      headers?: Record<string, JsonValue>;
      warmupRuns?: number;
      runs?: number;
      timeoutMs?: number;
      expectStatus?: string;
    }>({ json: item.data, items: ctx.items.map((i) => i.data) });
    const lineage = [{ sourceNode: ctx.nodeId, sourcePort: 'main', itemIndex: index }];
    const url = typeof cfg.url === 'string' ? cfg.url : '';
    const key = cfg.key === null || cfg.key === undefined || cfg.key === '' ? `target ${index + 1}` : String(cfg.key);
    const label = cfg.label === null || cfg.label === undefined || cfg.label === '' ? 'default' : String(cfg.label);
    if (!url) {
      failed.push({ data: { key, label, url, class: 'validation', code: 'NO_URL', message: 'This item has no URL to measure.' }, lineage });
      continue;
    }
    const request: TargetRequest = {
      method: cfg.method ?? 'GET',
      url,
      headers: Object.fromEntries(Object.entries(cfg.headers ?? {}).map(([k, v]) => [k, String(v)])),
      warmupRuns: clamp(cfg.warmupRuns, 0, 10, 1),
      runs: clamp(cfg.runs, 1, 100, 5),
      timeoutMs: clamp(cfg.timeoutMs, 100, 300_000, 30_000),
      expectStatus: cfg.expectStatus ?? '2xx',
    };
    const result = await measureTarget(ctx.http, { key, label, request }, auth, ctx.signal);
    if (isFailure(result)) {
      ctx.logger.warn(`${key} / ${label}: ${result.message}`);
      failed.push({ data: result as unknown as JsonValue, lineage });
    } else {
      measured.push({ data: result as unknown as JsonValue, lineage });
    }
  }

  return {
    ...(measured.length ? ctx.emit('main', measured) : {}),
    ...(failed.length ? ctx.emit('error', failed) : {}),
  };
});

/* ---------------------------------------------------------------- compare */

export const compareManifest = defineManifest({
  type: 'bench.compare',
  version: 1,
  title: 'Compare variants',
  group: 'measure',
  description: 'Pair variants of each endpoint — old with new, full with list — and say how much time and size changed.',
  executionMode: 'batch',
  ports: {
    inputs: [{ id: 'main', required: true, join: 'all' }],
    outputs: [
      { id: 'main', label: 'Compared' },
      { id: 'unpaired', label: 'No partner' },
    ],
  },
  config: {
    fields: [
      {
        name: 'pairs',
        label: 'Pairs',
        type: 'json',
        default: [
          ['old', 'new'],
          ['full', 'list'],
        ],
        description: 'Variant names to compare, [before, after]. Each pair present for an endpoint becomes one comparison.',
      },
      { name: 'tolerancePct', label: 'Same within (%)', type: 'number', default: 10, description: 'Closer than this counts as about the same.' },
      { name: 'minDeltaMs', label: 'Ignore time changes under (ms)', type: 'number', default: DEFAULT_NOISE_FLOOR.minDeltaMs, description: 'Noise floor: 16 ms against 20 ms is 25% but means nothing.' },
      { name: 'minDeltaBytes', label: 'Ignore size changes under (bytes)', type: 'number', default: DEFAULT_NOISE_FLOOR.minDeltaBytes, description: 'Noise floor for sizes: one empty list against another.' },
    ],
  },
});

const comparePairs = (value: JsonValue | undefined): [string, string][] =>
  Array.isArray(value)
    ? value.filter((p): p is [string, string] => Array.isArray(p) && p.length === 2 && p.every((x) => typeof x === 'string'))
    : [];

const compareNode = defineExecutor(compareManifest, (ctx) => {
  const cfg = ctx.resolveConfig<{ pairs?: JsonValue; tolerancePct?: number; minDeltaMs?: number; minDeltaBytes?: number }>();
  const floor = {
    minDeltaMs: clamp(cfg.minDeltaMs, 0, 60_000, DEFAULT_NOISE_FLOOR.minDeltaMs),
    minDeltaBytes: clamp(cfg.minDeltaBytes, 0, 100 * 1024 * 1024, DEFAULT_NOISE_FLOOR.minDeltaBytes),
  };
  const { comparisons, unpaired } = compareAll(ctx.items, comparePairs(cfg.pairs ?? compareManifest.config!.fields![0]!.default), cfg.tolerancePct ?? 10, floor);
  return {
    ...(comparisons.length ? ctx.emit('main', comparisons.map((c) => ({ data: c as unknown as JsonValue }))) : {}),
    ...(unpaired.length ? ctx.emit('unpaired', unpaired.map((m) => ({ data: m as unknown as JsonValue }))) : {}),
  };
});

/* --------------------------------------------------------------- baseline */

export const baselineManifest = defineManifest({
  type: 'bench.baseline',
  version: 1,
  title: 'Check against baseline',
  group: 'measure',
  description: 'Compare each endpoint with its own baseline, re-measure a suspected regression once, and write a report.',
  executionMode: 'batch',
  ports: {
    inputs: [{ id: 'main', required: true, join: 'all' }],
    outputs: [
      { id: 'main', label: 'Within baseline' },
      { id: 'regressions', label: 'Regressions' },
      { id: 'report', label: 'Report' },
    ],
  },
  // For the one re-measurement of a suspected regression.
  credentials: [{ ...AUTH_SLOT, description: 'Used to measure a suspected regression once more. Pick the same one as the measuring box.' }],
  actions: [
    {
      id: 'acceptBaseline',
      label: 'Accept as baseline',
      description: 'The slowdown is intended: make this run’s numbers the new baseline for every endpoint in it, without measuring again.',
    },
  ],
  config: {
    fields: [
      { name: 'regressionPct', label: 'Regression over (%)', type: 'number', default: 20, description: 'A median this much over its baseline is a regression — once measured again to be sure.' },
      { name: 'minDeltaMs', label: 'Ignore changes under (ms)', type: 'number', default: DEFAULT_NOISE_FLOOR.minDeltaMs, description: 'A regression must also be at least this much slower: a few milliseconds is noise.' },
      { name: 'tolerancePct', label: 'Baseline may rise (%)', type: 'number', default: 10, description: 'The most a baseline moves up in one run, so a slow creep still alerts.' },
      { name: 'baselinePolicy', label: 'Move baseline', type: 'select', options: ['onPass', 'rollingMedian', 'always'], default: 'onPass', description: 'onPass: to each passing run. rollingMedian: the median of recent passes. always: every run, regressions too.' },
      { name: 'window', label: 'Recent passes', type: 'number', default: 5, showWhen: { field: 'baselinePolicy', equals: ['rollingMedian'] } },
      { name: 'remeasure', label: 'Measure a regression again', type: 'boolean', default: true },
      { name: 'environment', label: 'Environment', type: 'expression', default: '{{ $vars.baseUrl }}', description: 'Each environment keeps its own baselines, so local numbers never judge dev. Named at the top of the report.' },
      { name: 'title', label: 'Report title', type: 'string', default: 'Endpoint latency' },
    ],
  },
});

const baselineNode = defineExecutor(
  baselineManifest,
  async (ctx) => {
    const cfg = ctx.resolveConfig<{
      regressionPct?: number;
      minDeltaMs?: number;
      tolerancePct?: number;
      baselinePolicy?: BaselinePolicy;
      window?: number;
      remeasure?: boolean;
      environment?: JsonValue;
      title?: string;
    }>();
    const settings: BaselineSettings = {
      regressionPct: cfg.regressionPct ?? 20,
      tolerancePct: cfg.tolerancePct ?? 10,
      policy: cfg.baselinePolicy ?? 'onPass',
      window: clamp(cfg.window, 1, 100, 5),
      minDeltaMs: clamp(cfg.minDeltaMs, 0, 60_000, DEFAULT_NOISE_FLOOR.minDeltaMs),
    };
    const environment = environmentOf(cfg.environment);
    const auth = await ctx.credential('auth');
    const results: TargetResult[] = [];

    for (const measured of measurementsIn(ctx.items)) {
      const key = baselineKey(measured, environment);
      const entry = await ctx.state.get(key);
      const stored = readStored(entry?.value);
      let current: Measurement = measured;
      let remeasured = false;

      // One more look before crying wolf: a shared dev server has spikes.
      if (stored && cfg.remeasure !== false && measured.request && isRegression(measured.medianMs, stored.medianMs, settings.regressionPct, settings.minDeltaMs)) {
        remeasured = true;
        const again = await measureTarget(ctx.http, { key: measured.key, label: measured.label, request: measured.request }, auth, ctx.signal);
        if (!isFailure(again)) current = again;
        else ctx.logger.warn(`${measured.key} / ${measured.label}: could not measure again (${again.message})`);
      }

      const { result, next } = judge(current, stored, settings, ctx.run.id, remeasured);
      results.push(result);
      // Conditional on the version read above: if another run moved this
      // baseline meanwhile, this write is dropped and the run says so.
      if (next) ctx.state.set(key, next as unknown as JsonValue, { ifVersion: entry?.version ?? 'absent' });
    }

    const comparisons = comparisonsIn(ctx.items);
    const markdown = renderReport({
      title: cfg.title ?? 'Endpoint latency',
      environment,
      regressionPct: settings.regressionPct,
      minDeltaMs: settings.minDeltaMs,
      tolerancePct: settings.tolerancePct,
      policy: settings.policy,
      results,
      comparisons,
    });
    const report = await ctx.blobs.put(new TextEncoder().encode(markdown), { mimeType: 'text/markdown', fileName: 'endpoint-latency.md' });

    const regressions = results.filter((r) => r.verdict === 'regression');
    const passing = results.filter((r) => r.verdict !== 'regression');
    const summary = {
      title: cfg.title ?? 'Endpoint latency',
      environment,
      targets: results.length,
      regressions: regressions.length,
      created: results.filter((r) => r.verdict === 'baseline created').length,
      summary: `${results.length} target${results.length === 1 ? '' : 's'}: ${regressions.length ? `${regressions.length} regression${regressions.length === 1 ? '' : 's'} (${regressions.map((r) => `${r.key}/${r.label}`).join(', ')})` : 'no regressions'}`,
    };
    const item = (r: TargetResult): Item => ({ data: r as unknown as JsonValue });
    return {
      ...(passing.length ? ctx.emit('main', passing.map(item)) : {}),
      ...(regressions.length ? ctx.emit('regressions', regressions.map(item)) : {}),
      ...ctx.emit('report', [{ data: summary, binary: { report } }]),
    };
  },
  { actions: { acceptBaseline: acceptBaseline() } },
);

/**
 * "Accept as baseline": a person says this run's slowdown is intended.
 *
 * Writes the numbers the box *received* in that run — as the journal recorded
 * them — without measuring anything again, through the same version check as
 * a run. It exists only as a run-view action: no trigger input can do it, so
 * a deploy webhook cannot accept its own regression.
 */
function acceptBaseline(): ActionHandler {
  return async (ctx) => {
    const measured = measurementsIn(ctx.input['main']?.items ?? []);
    // The environment the run judged against, as its report item recorded it.
    const summary = ctx.outputs['report']?.items[0]?.data as { environment?: unknown } | undefined;
    const environment = environmentOf(summary?.environment);
    for (const m of measured) {
      const key = baselineKey(m, environment);
      const entry = await ctx.state.get(key);
      ctx.state.set(key, { medianMs: m.medianMs, bytes: m.bytes, history: [m.medianMs], runId: ctx.runId, accepted: true } as unknown as JsonObject, {
        ifVersion: entry?.version ?? 'absent',
      });
    }
    return {
      message: measured.length
        ? `This run’s numbers are now the baseline for ${measured.length} endpoint${measured.length === 1 ? '' : 's'}.`
        : 'This run had no measurements to accept.',
    };
  };
}

/* ------------------------------------------------------------------ chart */

export const chartManifest = defineManifest({
  type: 'bench.chart',
  version: 1,
  title: 'Before/after chart',
  group: 'measure',
  description: 'Draw every compared endpoint’s before and after as bars — what the change did, at a glance. Shown in the box’s output, and downloadable.',
  executionMode: 'batch',
  ports: {
    inputs: [{ id: 'main', required: true, join: 'all' }],
    outputs: [{ id: 'main', label: 'Chart' }],
  },
  config: {
    fields: [
      { name: 'metric', label: 'Show', type: 'select', options: ['time', 'size', 'both'], default: 'time', description: 'time: median response time. size: response size. both: one chart of each.' },
      { name: 'title', label: 'Title', type: 'string', default: 'Before and after' },
      { name: 'environment', label: 'Environment', type: 'expression', default: '{{ $vars.baseUrl }}', description: 'Named under the title.' },
    ],
  },
});

const chartNode = defineExecutor(chartManifest, async (ctx) => {
  const cfg = ctx.resolveConfig<{ metric?: string; title?: string; environment?: JsonValue }>();
  const metric: ChartMetric = cfg.metric === 'size' || cfg.metric === 'both' ? cfg.metric : 'time';
  const comparisons = comparisonsIn(ctx.items);
  const title = cfg.title || 'Before and after';
  const svg = renderChart({ title, environment: environmentOf(cfg.environment), comparisons, metric });
  const chart = await ctx.blobs.put(new TextEncoder().encode(svg), { mimeType: 'image/svg+xml', fileName: 'before-after.svg' });
  const count = (v: Comparison['verdict']) => comparisons.filter((c) => c.verdict === v).length;
  return ctx.emit('main', [
    {
      data: { title, metric, pairs: comparisons.length, faster: count('faster'), slower: count('slower'), same: count('about the same') },
      binary: { chart },
    },
  ]);
});

/** The comparison items among a box's input: what Compare variants emits. */
function comparisonsIn(items: readonly Item[]): Comparison[] {
  return items
    .map((i) => i.data as unknown as Partial<Comparison> | null)
    .filter((c): c is Comparison => !!c && typeof c === 'object' && Array.isArray(c.measurements) && typeof c.candidate === 'string');
}

export const benchManifests: NodeManifest[] = [measureManifest, compareManifest, baselineManifest, chartManifest];
export const benchNodes: NodeDefinition[] = [measureNode, compareNode, baselineNode, chartNode];
