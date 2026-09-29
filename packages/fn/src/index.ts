/**
 * @goblin/fn — the shared function library: small, pure, dependency-free.
 *
 * One definition of "median", used everywhere. `{{ }}` expressions call these
 * (through @goblin/expressions) and node packs import them (through
 * @goblin/node-sdk), so a number a box computes and the same number typed in
 * an expression can never disagree. That only holds if there is exactly one
 * copy, which is why this is its own package with no dependencies rather than
 * a file inside either of its users.
 *
 * Every function takes and returns plain JSON values and never throws on odd
 * input: a statistic of nothing is `null`, and entries that are not numbers
 * are ignored rather than coerced, so a `null` in a column does not turn into
 * a zero that drags an average down.
 */

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** The finite numbers in a list, in order. Everything else is left out. */
export function numbers(list: unknown): number[] {
  if (!Array.isArray(list)) return [];
  return list.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
}

/**
 * Sorted copy, ascending. With `key`, objects are ordered by that field.
 * Numbers before strings before everything else, so a mixed list sorts the
 * same way every time.
 */
export function sort(list: unknown, key?: unknown): Json[] {
  if (!Array.isArray(list)) return [];
  const pick = (v: Json): Json =>
    typeof key === 'string' && v && typeof v === 'object' && !Array.isArray(v) ? (v[key] ?? null) : v;
  const rank = (v: Json) => (typeof v === 'number' ? 0 : typeof v === 'string' ? 1 : 2);
  return [...(list as Json[])].sort((a, b) => {
    const x = pick(a);
    const y = pick(b);
    if (rank(x) !== rank(y)) return rank(x) - rank(y);
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    if (typeof x === 'string' && typeof y === 'string') return x < y ? -1 : x > y ? 1 : 0;
    return 0;
  });
}

export function min(list: unknown): number | null {
  const n = numbers(list);
  return n.length ? Math.min(...n) : null;
}

export function max(list: unknown): number | null {
  const n = numbers(list);
  return n.length ? Math.max(...n) : null;
}

/** The sum of nothing is 0, which is the one statistic where that is true. */
export function sum(list: unknown): number {
  return numbers(list).reduce((a, b) => a + b, 0);
}

export function avg(list: unknown): number | null {
  const n = numbers(list);
  return n.length ? sum(n) / n.length : null;
}

/**
 * The p-th percentile by the **nearest-rank** method.
 *
 * Sort ascending and take the value at rank ⌈p/100 × n⌉ (counting from 1),
 * with p = 0 giving the smallest. The answer is always one of the measured
 * values, never an interpolation between two, so "p95 was 412 ms" means some
 * request really took 412 ms. `p` outside 0–100 is clamped.
 */
export function percentile(list: unknown, p: unknown): number | null {
  const n = numbers(list).sort((a, b) => a - b);
  if (!n.length) return null;
  const q = Math.min(100, Math.max(0, typeof p === 'number' && Number.isFinite(p) ? p : 50));
  const rank = Math.max(1, Math.ceil((q / 100) * n.length));
  return n[rank - 1]!;
}

/**
 * The 50th percentile, by the same nearest-rank rule: for an even count this
 * is the lower of the two middle values, not their average. Stated here
 * because it differs from a spreadsheet's MEDIAN.
 */
export function median(list: unknown): number | null {
  return percentile(list, 50);
}

/** One field from each object in a list; `null` where it is missing. */
export function pluck(list: unknown, key: unknown): Json[] {
  if (!Array.isArray(list) || (typeof key !== 'string' && typeof key !== 'number')) return [];
  return (list as Json[]).map((v) => {
    if (v && typeof v === 'object') return ((v as Record<string | number, Json>)[key] ?? null) as Json;
    return null;
  });
}

/** Like Array.slice: negative positions count from the end. */
export function slice(list: unknown, start: unknown, end?: unknown): Json[] {
  if (!Array.isArray(list)) return [];
  const s = typeof start === 'number' ? Math.trunc(start) : 0;
  return typeof end === 'number' ? (list as Json[]).slice(s, Math.trunc(end)) : (list as Json[]).slice(s);
}

/**
 * The library by name, for the expression evaluator. Adding a function here
 * makes it callable from every `{{ }}` field, so each one must stay pure.
 */
export const LIBRARY = { sort, min, max, sum, avg, median, percentile, pluck, slice } as const;
