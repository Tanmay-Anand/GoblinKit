import { describe, expect, it } from 'vitest';

import { avg, max, median, min, percentile, pluck, slice, sort, sum } from '@goblin/fn';

describe('statistics', () => {
  it('a statistic of nothing is null, and a sum of nothing is 0', () => {
    for (const f of [min, max, avg, median]) expect(f([])).toBeNull();
    expect(percentile([], 95)).toBeNull();
    expect(sum([])).toBe(0);
    expect(min('not a list')).toBeNull();
  });

  it('one value is every statistic of itself', () => {
    for (const f of [min, max, avg, median]) expect(f([7])).toBe(7);
    expect(percentile([7], 0)).toBe(7);
    expect(percentile([7], 100)).toBe(7);
  });

  it('ignores entries that are not numbers instead of counting them as zero', () => {
    expect(avg([10, null, '20', 30])).toBe(20);
    expect(min([null, 5, Number.NaN, 3])).toBe(3);
  });

  it('median is the nearest-rank 50th percentile: the lower middle for an even count', () => {
    expect(median([3, 1, 2])).toBe(2);
    // Not 2.5: nearest-rank always answers with a value that was measured.
    expect(median([4, 1, 3, 2])).toBe(2);
  });

  it('percentile follows the nearest-rank vectors', () => {
    const twenty = Array.from({ length: 20 }, (_, i) => i + 1); // 1..20
    expect(percentile(twenty, 0)).toBe(1);
    expect(percentile(twenty, 5)).toBe(1); // ⌈0.05 × 20⌉ = 1
    expect(percentile(twenty, 50)).toBe(10); // ⌈0.5 × 20⌉ = 10
    expect(percentile(twenty, 95)).toBe(19); // ⌈0.95 × 20⌉ = 19
    expect(percentile(twenty, 100)).toBe(20);
    // The textbook example: 15, 20, 35, 40, 50.
    expect(percentile([15, 20, 35, 40, 50], 30)).toBe(20);
    expect(percentile([15, 20, 35, 40, 50], 40)).toBe(20);
    expect(percentile([15, 20, 35, 40, 50], 50)).toBe(35);
    expect(percentile([15, 20, 35, 40, 50], 100)).toBe(50);
  });

  it('clamps p to 0–100', () => {
    expect(percentile([1, 2, 3], -5)).toBe(1);
    expect(percentile([1, 2, 3], 250)).toBe(3);
  });
});

describe('list helpers', () => {
  it('sort copies, and orders objects by a key', () => {
    const list = [3, 1, 2];
    expect(sort(list)).toEqual([1, 2, 3]);
    expect(list).toEqual([3, 1, 2]);
    expect(sort([{ ms: 30 }, { ms: 10 }, { ms: 20 }], 'ms')).toEqual([{ ms: 10 }, { ms: 20 }, { ms: 30 }]);
    expect(sort(['b', 2, 'a', 1])).toEqual([1, 2, 'a', 'b']);
  });

  it('pluck takes one field from each item, null where it is missing', () => {
    expect(pluck([{ a: 1 }, { b: 2 }, 5], 'a')).toEqual([1, null, null]);
  });

  it('slice works like Array.slice, so "runs 2 to 5" is slice(runs, 1)', () => {
    expect(slice([10, 20, 30, 40, 50], 1)).toEqual([20, 30, 40, 50]);
    expect(slice([10, 20, 30], 0, -1)).toEqual([10, 20]);
  });
});
