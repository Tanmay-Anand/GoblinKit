/**
 * Baselines: what "normal" is for each target, and whether this run broke it.
 *
 * Per target and per environment, never per run: one slow endpoint must not
 * freeze the baseline of the eleven that were fine, and numbers taken on a
 * laptop must never judge a shared dev server. Each target's baseline lives
 * in the box's `ctx.state` under `baseline:<key>:<label>@<environment>`,
 * written with a version check so an overlapping run cannot silently
 * overwrite it.
 *
 * The rules, and the hole each closes:
 *
 *  - A target more than `regressionPct` over its baseline is measured once
 *    more before anyone is told: shared dev servers have one-off spikes.
 *  - A change under `minDeltaMs` is noise, whatever its percentage: 15 ms
 *    against 19 ms is +27%, and means nothing.
 *  - Under `onPass` (the default) a passing target's baseline moves to this
 *    run's median — improvements in full, but upward by at most
 *    `tolerancePct` a run. Without that ratchet, an endpoint 15% slower every
 *    run would never alert, because each run is compared with the last.
 *  - `rollingMedian` takes the median of the last N passing runs, with the
 *    same ratchet; `always` follows every run, regressions too, for watching
 *    a trend rather than guarding one.
 */

import { fn } from '@goblin/node-sdk';
import type { JsonValue } from '@goblin/spec';

import type { Measurement } from './measure.js';

export type BaselinePolicy = 'onPass' | 'rollingMedian' | 'always';

export interface StoredBaseline {
  medianMs: number;
  bytes: number;
  /** Passing medians, oldest first — the rolling window. */
  history: number[];
  /** The run whose results set it. */
  runId: string;
  /** Set when a person accepted a run's results, rather than a run passing. */
  accepted?: boolean;
}

export interface TargetResult {
  key: string;
  label: string;
  url: string;
  medianMs: number;
  maxMs: number;
  p95Ms?: number;
  bytes: number;
  status: number;
  /** The baseline it was judged against; absent on the first run. */
  baselineMs?: number;
  deltaPct?: number;
  verdict: 'baseline created' | 'ok' | 'faster' | 'regression';
  /** It looked like a regression and was measured once more. */
  remeasured: boolean;
  /** Where the baseline stands after this run, if it moved. */
  newBaselineMs?: number;
}

/**
 * An environment as it scopes baselines: the address without trailing
 * slashes. Empty means "not named", which keeps the unscoped key.
 */
export const environmentOf = (value: unknown): string => (typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '');

export const baselineKey = (m: { key: string; label: string }, environment = '') => {
  const env = environmentOf(environment);
  return `baseline:${m.key}:${m.label}${env ? `@${env}` : ''}`;
};

export interface BaselineSettings {
  regressionPct: number;
  tolerancePct: number;
  policy: BaselinePolicy;
  window: number;
  /** Changes smaller than this many milliseconds are noise. */
  minDeltaMs: number;
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;

/** Over by the percentage *and* by at least the floor: both, or it is noise. */
export const isRegression = (medianMs: number, baselineMs: number, regressionPct: number, minDeltaMs = 0) =>
  medianMs > baselineMs * (1 + regressionPct / 100) && medianMs - baselineMs >= minDeltaMs;

/**
 * Judge one target against its stored baseline (`current` is after any
 * re-measurement) and say what the baseline becomes. Pure, so every policy
 * and edge can be tested without a run.
 */
export function judge(
  current: Measurement,
  stored: StoredBaseline | undefined,
  settings: BaselineSettings,
  runId: string,
  remeasured: boolean,
): { result: TargetResult; next?: StoredBaseline } {
  const base: TargetResult = {
    key: current.key,
    label: current.label,
    url: current.url,
    medianMs: current.medianMs,
    maxMs: current.maxMs,
    ...(current.p95Ms !== undefined ? { p95Ms: current.p95Ms } : {}),
    bytes: current.bytes,
    status: current.status,
    verdict: 'ok',
    remeasured,
  };

  if (!stored) {
    const next: StoredBaseline = { medianMs: current.medianMs, bytes: current.bytes, history: [current.medianMs], runId };
    return { result: { ...base, verdict: 'baseline created', newBaselineMs: next.medianMs }, next };
  }

  const deltaPct = stored.medianMs > 0 ? r1((current.medianMs / stored.medianMs - 1) * 100) : 0;
  const judged: TargetResult = { ...base, baselineMs: stored.medianMs, deltaPct };
  const regressed = isRegression(current.medianMs, stored.medianMs, settings.regressionPct, settings.minDeltaMs);
  const ceiling = stored.medianMs * (1 + settings.tolerancePct / 100);

  if (regressed) {
    const result: TargetResult = { ...judged, verdict: 'regression' };
    if (settings.policy !== 'always') return { result };
    const next: StoredBaseline = { medianMs: current.medianMs, bytes: current.bytes, history: [...stored.history, current.medianMs].slice(-settings.window), runId };
    return { result: { ...result, newBaselineMs: next.medianMs }, next };
  }

  const faster = current.medianMs < stored.medianMs * (1 - settings.tolerancePct / 100) && stored.medianMs - current.medianMs >= settings.minDeltaMs;
  const verdict = faster ? 'faster' : 'ok';
  const history = [...stored.history, current.medianMs].slice(-Math.max(1, settings.window));
  let medianMs: number;
  switch (settings.policy) {
    case 'always':
      medianMs = current.medianMs;
      break;
    case 'rollingMedian':
      medianMs = Math.min(fn.median(history) ?? current.medianMs, ceiling);
      break;
    default:
      // The ratchet: better is taken in full, worse by at most the tolerance.
      medianMs = Math.min(current.medianMs, ceiling);
  }
  const next: StoredBaseline = { medianMs: r2(medianMs), bytes: current.bytes, history, runId };
  return { result: { ...judged, verdict, newBaselineMs: next.medianMs }, next };
}

export function readStored(value: JsonValue | undefined): StoredBaseline | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const v = value as Partial<StoredBaseline>;
  if (typeof v.medianMs !== 'number') return undefined;
  return { medianMs: v.medianMs, bytes: v.bytes ?? 0, history: Array.isArray(v.history) ? v.history : [v.medianMs], runId: v.runId ?? '', ...(v.accepted ? { accepted: true } : {}) };
}
