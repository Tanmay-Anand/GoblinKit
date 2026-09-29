/**
 * Pairing variants of one endpoint — old against new, full against list —
 * and saying what changed.
 */

import type { Measurement } from './measure.js';
import { measurementsIn } from './measure.js';

export interface Comparison {
  key: string;
  baseline: string;
  candidate: string;
  baselineMedianMs: number;
  candidateMedianMs: number;
  /** candidate ÷ baseline. Under 1 is faster. */
  timeRatio: number;
  timeSavedPct: number;
  baselineBytes: number;
  candidateBytes: number;
  sizeRatio: number;
  sizeSavedPct: number;
  /** Time: the part a person reads first. */
  verdict: 'faster' | 'about the same' | 'slower';
  sizeVerdict: 'smaller' | 'about the same' | 'larger';
  /** The two measurements, so a baseline box downstream can use them. */
  measurements: [Measurement, Measurement];
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const r1 = (n: number) => Math.round(n * 10) / 10;
const ratio = (a: number, b: number) => (b === 0 ? (a === 0 ? 1 : Infinity) : a / b);

/**
 * How small a change is too small to mean anything. A percentage alone lies
 * at small numbers: 16 ms against 20 ms is "25% slower" and is noise on any
 * network, and 2 bytes against 28 is "1300% larger" and is one empty list
 * against another. A change must clear both the percentage and the floor.
 */
export interface NoiseFloor {
  minDeltaMs: number;
  minDeltaBytes: number;
}

export const DEFAULT_NOISE_FLOOR: NoiseFloor = { minDeltaMs: 5, minDeltaBytes: 512 };

function judgeChange<T extends string>(before: number, after: number, tolerancePct: number, floor: number, words: [better: T, same: T, worse: T]): T {
  const r = ratio(after, before);
  const tol = tolerancePct / 100;
  if (Math.abs(after - before) < floor) return words[1];
  return r < 1 - tol ? words[0] : r > 1 + tol ? words[2] : words[1];
}

/**
 * Compare every pair of labels present for a key. Measurements that end up
 * in no complete pair are returned as unpaired — a missing "new" is worth
 * seeing, not silently dropping.
 */
export function compareAll(
  items: readonly { data: unknown }[],
  pairs: [string, string][],
  tolerancePct: number,
  floor: NoiseFloor = DEFAULT_NOISE_FLOOR,
): { comparisons: Comparison[]; unpaired: Measurement[] } {
  const all = measurementsIn(items);
  const byKey = new Map<string, Map<string, Measurement>>();
  for (const m of all) {
    const labels = byKey.get(m.key) ?? new Map<string, Measurement>();
    labels.set(m.label, m);
    byKey.set(m.key, labels);
  }

  const comparisons: Comparison[] = [];
  const used = new Set<Measurement>();
  for (const [key, labels] of byKey) {
    for (const [from, to] of pairs) {
      const a = labels.get(from);
      const b = labels.get(to);
      if (!a || !b) continue;
      used.add(a);
      used.add(b);
      const timeRatio = ratio(b.medianMs, a.medianMs);
      const sizeRatio = ratio(b.bytes, a.bytes);
      comparisons.push({
        key,
        baseline: from,
        candidate: to,
        baselineMedianMs: a.medianMs,
        candidateMedianMs: b.medianMs,
        timeRatio: r2(timeRatio),
        timeSavedPct: r1((1 - timeRatio) * 100),
        baselineBytes: a.bytes,
        candidateBytes: b.bytes,
        sizeRatio: r2(sizeRatio),
        sizeSavedPct: r1((1 - sizeRatio) * 100),
        verdict: judgeChange(a.medianMs, b.medianMs, tolerancePct, floor.minDeltaMs, ['faster', 'about the same', 'slower']),
        sizeVerdict: judgeChange(a.bytes, b.bytes, tolerancePct, floor.minDeltaBytes, ['smaller', 'about the same', 'larger']),
        measurements: [a, b],
      });
    }
  }
  return { comparisons, unpaired: all.filter((m) => !used.has(m)) };
}
