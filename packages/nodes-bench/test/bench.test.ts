import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { createNodeHarness } from '@goblin/node-sdk';
import type { JsonValue } from '@goblin/spec';
import { benchManifests, benchNodes, compareAll, judge, renderChart, renderReport, type Measurement, type TargetResult } from '@goblin/nodes-bench';
import { coreCredentialResolvers } from '@goblin/nodes-core';
import { checkNodePack, findSecrets, matchGolden } from '@goblin/testing';

const node = (type: string) => benchNodes.find((n) => n.manifest.type === type)!;
const target = (key: string, label: string, url: string) => ({ data: { key, label, url } });

describe('the bench pack', () => {
  it('passes the node pack contract', () => {
    expect(checkNodePack({ manifests: benchManifests, nodes: benchNodes })).toEqual([]);
  });
});

describe('bench.http.measure', () => {
  it('discards the warm-up, times the rest, and reports min, median, max and time to first byte', async () => {
    const t = createNodeHarness(node('bench.http.measure'));
    // 1 warm-up (900 ms, cold cache) then 5 timed runs.
    t.http.mock('GET https://dev.test/users/names').reply(200, { names: ['a', 'b'] }, { ttfbMs: [800, 40, 42, 38, 41, 60], totalMs: [900, 110, 100, 95, 120, 300] });
    const run = await t.run({ items: [target('users', 'old', 'https://dev.test/users/names')] });

    const m = run.items('main')[0]!.data as unknown as Measurement;
    expect(m).toMatchObject({ key: 'users', label: 'old', status: 200, runs: [110, 100, 95, 120, 300], minMs: 95, medianMs: 110, maxMs: 300, ttfbMedianMs: 41 });
    expect(m.bytes).toBe(JSON.stringify({ names: ['a', 'b'] }).length);
    expect(m.p95Ms).toBeUndefined();
    expect(t.http.calls).toHaveLength(6);
  });

  it('never puts a response body into its output', async () => {
    const t = createNodeHarness(node('bench.http.measure'));
    t.http.mock('GET https://dev.test/x').reply(200, { secretRow: 'customer-ssn-123-45-6789' });
    const run = await t.run({ items: [target('x', 'new', 'https://dev.test/x')], config: { runs: 2 } });
    expect(JSON.stringify(run.outputs)).not.toContain('customer-ssn');
  });

  it('reports p95 only from 20 runs up — below that, the maximum stands in', async () => {
    const t = createNodeHarness(node('bench.http.measure'));
    t.http.mock('GET https://dev.test/x').reply(200, {}, { totalMs: Array.from({ length: 21 }, (_, i) => (i === 0 ? 999 : i * 10)) });
    const run = await t.run({ items: [target('x', 'new', 'https://dev.test/x')], config: { runs: 20 } });
    const m = run.items('main')[0]!.data as unknown as Measurement;
    // Runs are 10..200; nearest-rank p95 of 20 values is the 19th.
    expect(m.p95Ms).toBe(190);
  });

  it('isolates a failing target: one times out, the others are still measured', async () => {
    const t = createNodeHarness(node('bench.http.measure'));
    t.http.mock('GET https://dev.test/a').reply(200, {});
    t.http.mock('GET https://dev.test/slow').hang();
    t.http.mock('GET https://dev.test/c').reply(200, {});
    const run = await t.run({
      items: [target('a', 'new', 'https://dev.test/a'), target('slow', 'new', 'https://dev.test/slow'), target('c', 'new', 'https://dev.test/c')],
      config: { runs: 2, timeoutMs: 100 },
    });
    expect(run.items('main').map((i) => (i.data as { key: string }).key)).toEqual(['a', 'c']);
    expect(run.items('error').map((i) => i.data)).toEqual([
      { key: 'slow', label: 'new', url: 'https://dev.test/slow', class: 'transient', code: 'TIMEOUT', message: 'dev.test did not answer within 0.1 s.' },
    ]);
  });

  it('maps an unexpected status to its class — 401 is auth, 5xx transient — with no body', async () => {
    const t = createNodeHarness(node('bench.http.measure'));
    t.http.mock('GET https://dev.test/private').reply(401, { error: 'token expired for user ada@example.com' });
    t.http.mock('GET https://dev.test/broken').reply(502, 'Bad gateway');
    const run = await t.run({ items: [target('p', 'new', 'https://dev.test/private'), target('b', 'new', 'https://dev.test/broken')] });
    expect(run.items('error').map((i) => i.data)).toEqual([
      { key: 'p', label: 'new', url: 'https://dev.test/private', status: 401, class: 'auth', code: 'HTTP_401', message: 'HTTP 401 from dev.test' },
      { key: 'b', label: 'new', url: 'https://dev.test/broken', status: 502, class: 'transient', code: 'HTTP_502', message: 'HTTP 502 from dev.test' },
    ]);
    expect(JSON.stringify(run.outputs)).not.toContain('ada@example.com');
  });

  it('signs every request with the picked credential, and never emits or logs the token', async () => {
    const t = createNodeHarness(node('bench.http.measure'), { credentialTypes: coreCredentialResolvers });
    t.http.mock('GET https://dev.test/x').reply(200, {});
    const auth = await t.addCredential('http.bearerToken', { token: 'eyJhbGciOi-real-looking-token' });
    const run = await t.run({ items: [target('x', 'new', 'https://dev.test/x')], credentials: { auth }, config: { headers: { 'x-tenant-id': 'acme' } } });
    expect(t.http.calls.every((c) => c.headers['authorization'] === 'Bearer eyJhbGciOi-real-looking-token' && c.headers['x-tenant-id'] === 'acme')).toBe(true);
    expect(findSecrets([run.outputs, run.logs] as unknown as JsonValue, ['eyJhbGciOi-real-looking-token'])).toEqual([]);
  });
});

const measurement = (key: string, label: string, medianMs: number, bytes = 1000): Measurement => ({
  key,
  label,
  url: `https://dev.test/${key}/${label}`,
  status: 200,
  bytes,
  runs: [medianMs],
  minMs: medianMs,
  medianMs,
  maxMs: medianMs,
  ttfbMedianMs: medianMs / 2,
  request: { method: 'GET', url: `https://dev.test/${key}/${label}`, headers: {}, warmupRuns: 1, runs: 5, timeoutMs: 30_000, expectStatus: '2xx' },
});

describe('bench.compare', () => {
  it('pairs old with new and full with list per endpoint, and leaves the rest unpaired', () => {
    const { comparisons, unpaired } = compareAll(
      [
        { data: measurement('projects', 'old', 200, 50_000) },
        { data: measurement('projects', 'new', 50, 2_000) },
        { data: measurement('buyers', 'full', 400, 80_000) },
        { data: measurement('buyers', 'list', 390, 20_000) },
        { data: measurement('banks', 'old', 100) },
      ] as { data: unknown }[],
      [
        ['old', 'new'],
        ['full', 'list'],
      ],
      10,
    );
    expect(comparisons.map((c) => [c.key, c.baseline, c.candidate, c.timeSavedPct, c.sizeSavedPct, c.verdict])).toEqual([
      ['projects', 'old', 'new', 75, 96, 'faster'],
      ['buyers', 'full', 'list', 2.5, 75, 'about the same'],
    ]);
    expect(unpaired.map((m) => `${m.key}/${m.label}`)).toEqual(['banks/old']);
  });

  it('calls a change under the noise floor "about the same", however big its percentage', () => {
    const { comparisons } = compareAll(
      [
        // 16 → 20 ms is 25% slower and means nothing; 2 → 28 bytes is one empty list against another.
        { data: measurement('users', 'old', 16, 2) },
        { data: measurement('users', 'new', 20, 28) },
        // Over the floor on both counts: a real change.
        { data: measurement('buyers', 'old', 47, 60_000) },
        { data: measurement('buyers', 'new', 21, 1_400) },
      ] as { data: unknown }[],
      [['old', 'new']],
      10,
    );
    expect(comparisons.map((c) => [c.key, c.verdict, c.sizeVerdict])).toEqual([
      ['users', 'about the same', 'about the same'],
      ['buyers', 'faster', 'smaller'],
    ]);
    // A zero floor gives the percentage alone, as before.
    const strict = compareAll([{ data: measurement('users', 'old', 16, 2) }, { data: measurement('users', 'new', 20, 28) }] as { data: unknown }[], [['old', 'new']], 10, { minDeltaMs: 0, minDeltaBytes: 0 });
    expect(strict.comparisons.map((c) => [c.verdict, c.sizeVerdict])).toEqual([['slower', 'larger']]);
  });
});

describe('baseline rules', () => {
  const settings = { regressionPct: 20, tolerancePct: 10, policy: 'onPass' as const, window: 5, minDeltaMs: 5 };

  it('a few milliseconds over is noise, not a regression, however big its percentage', () => {
    const stored = { medianMs: 15, bytes: 1, history: [15], runId: 'r0' };
    // +27%, but only 4 ms.
    expect(judge(measurement('a', 'new', 19), stored, settings, 'r1', false).result.verdict).toBe('ok');
    // +40% and 6 ms: both, so it counts.
    expect(judge(measurement('a', 'new', 21), stored, settings, 'r1', false).result.verdict).toBe('regression');
    // And a few milliseconds under is not "faster" either.
    expect(judge(measurement('a', 'new', 11), stored, settings, 'r1', false).result.verdict).toBe('ok');
  });

  it('the first run creates a baseline', () => {
    const { result, next } = judge(measurement('a', 'new', 100), undefined, settings, 'run1', false);
    expect(result.verdict).toBe('baseline created');
    expect(next).toMatchObject({ medianMs: 100, history: [100] });
  });

  it('the ratchet catches a slow creep that run-to-run comparison never would', () => {
    // 15% slower every run: under the 20% alarm each time, compared with the last run.
    let stored = judge(measurement('a', 'new', 100), undefined, settings, 'r0', false).next;
    let median = 100;
    const verdicts: string[] = [];
    for (let run = 1; run <= 6; run++) {
      median *= 1.15;
      const { result, next } = judge(measurement('a', 'new', Math.round(median)), stored, settings, `r${run}`, false);
      verdicts.push(result.verdict);
      stored = next ?? stored;
    }
    // The baseline could rise only 10% a run, so the gap grows until it alerts.
    expect(verdicts).toContain('regression');
    expect(verdicts.slice(0, 2)).toEqual(['ok', 'ok']);
  });

  it('takes an improvement in full', () => {
    const { next, result } = judge(measurement('a', 'new', 60), { medianMs: 100, bytes: 1, history: [100], runId: 'r0' }, settings, 'r1', false);
    expect(result.verdict).toBe('faster');
    expect(next?.medianMs).toBe(60);
  });

  it('a regression leaves the baseline where it was — unless the policy is "always"', () => {
    const stored = { medianMs: 100, bytes: 1, history: [100], runId: 'r0' };
    expect(judge(measurement('a', 'new', 150), stored, settings, 'r1', true).next).toBeUndefined();
    expect(judge(measurement('a', 'new', 150), stored, { ...settings, policy: 'always' }, 'r1', true).next?.medianMs).toBe(150);
  });

  it('rollingMedian follows the median of recent passes, under the same ratchet', () => {
    const stored = { medianMs: 100, bytes: 1, history: [100, 104, 96, 102], runId: 'r0' };
    const { next } = judge(measurement('a', 'new', 108), stored, { ...settings, policy: 'rollingMedian' }, 'r1', false);
    expect(next?.history).toEqual([100, 104, 96, 102, 108]);
    expect(next?.medianMs).toBe(102);
  });
});

describe('bench.baseline', () => {
  const box = () => createNodeHarness(node('bench.baseline'), { credentialTypes: coreCredentialResolvers });

  it('keeps one baseline per target: a regressed endpoint does not stop the others advancing', async () => {
    const t = box();
    await t.run({ items: [{ data: measurement('a', 'new', 100) }, { data: measurement('b', 'new', 100) }] as never, config: { remeasure: false } });
    const run = await t.run({ items: [{ data: measurement('a', 'new', 200) }, { data: measurement('b', 'new', 90) }] as never, config: { remeasure: false } });
    expect(run.items('regressions').map((i) => (i.data as unknown as TargetResult).key)).toEqual(['a']);
    expect(run.items('main').map((i) => (i.data as unknown as TargetResult).key)).toEqual(['b']);
    expect(t.state.dump(t.workflowId, 'test')).toMatchObject({ 'baseline:a:new': { value: { medianMs: 100 } }, 'baseline:b:new': { value: { medianMs: 90 } } });
  });

  it('keeps baselines per environment: numbers from a laptop never judge dev', async () => {
    const t = box();
    // Local: fast, and the first run there.
    await t.run({ items: [{ data: measurement('a', 'new', 15) }] as never, config: { remeasure: false }, variables: { baseUrl: 'http://localhost:8080/' } });
    // Dev is further away. Its first run creates its own baseline rather than "regressing" against local.
    const dev = await t.run({ items: [{ data: measurement('a', 'new', 120) }] as never, config: { remeasure: false }, variables: { baseUrl: 'https://dev.test' } });
    expect(dev.items('main')[0]?.data).toMatchObject({ verdict: 'baseline created' });
    expect(dev.items('regressions')).toEqual([]);
    expect(t.state.dump(t.workflowId, 'test')).toMatchObject({
      'baseline:a:new@http://localhost:8080': { value: { medianMs: 15 } },
      'baseline:a:new@https://dev.test': { value: { medianMs: 120 } },
    });
  });

  it('measures a suspected regression once more, which clears a one-off spike', async () => {
    const t = box();
    await t.run({ items: [{ data: measurement('a', 'new', 100) }] as never });
    t.http.mock('GET https://dev.test/a/new').reply(200, {}, { totalMs: 102 });
    const run = await t.run({ items: [{ data: measurement('a', 'new', 400) }] as never });
    const result = run.items('main')[0]!.data as unknown as TargetResult;
    expect(result).toMatchObject({ verdict: 'ok', remeasured: true, medianMs: 102, baselineMs: 100 });
    expect(run.items('regressions')).toEqual([]);
    // 1 warm-up + 5 timed, exactly as it was first measured.
    expect(t.http.calls).toHaveLength(6);
  });

  it('reports a regression the re-measurement confirms', async () => {
    const t = box();
    await t.run({ items: [{ data: measurement('a', 'new', 100) }] as never });
    t.http.mock('GET https://dev.test/a/new').reply(200, {}, { totalMs: 390 });
    const run = await t.run({ items: [{ data: measurement('a', 'new', 400) }] as never });
    expect(run.items('regressions')[0]?.data).toMatchObject({ verdict: 'regression', remeasured: true, medianMs: 390, deltaPct: 290 });
  });

  it('writes a Markdown report to blob storage, and puts only its reference on the item', async () => {
    const t = box();
    const run = await t.run({ items: [{ data: measurement('a', 'new', 100) }] as never, variables: { baseUrl: 'https://dev.test' } });
    const report = run.items('report')[0]!;
    expect(report.data).toMatchObject({ targets: 1, regressions: 0, created: 1, environment: 'https://dev.test' });
    expect(report.binary?.['report']).toMatchObject({ mimeType: 'text/markdown', fileName: 'endpoint-latency.md' });
    const text = new TextDecoder().decode(await t.blobs.get(report.binary!['report']!));
    expect(text).toMatch(/^# Endpoint latency/);
  });

  it('writes baselines conditionally: a baseline another run moved meanwhile is not overwritten', async () => {
    const t = box();
    await t.run({ items: [{ data: measurement('a', 'new', 100) }] as never });
    // This run reads version 1 ...
    const slow = t.run({ items: [{ data: measurement('a', 'new', 95) }] as never, commit: false });
    const pending = await slow;
    // ... another run commits version 2 first ...
    await t.run({ items: [{ data: measurement('a', 'new', 90) }] as never });
    // ... so this run's write (ifVersion: 1) is dropped when applied.
    const applied = await t.state.apply(t.workflowId, 'test', pending.writes, 'late-run');
    expect(applied.conflicts).toEqual(['baseline:a:new']);
    expect(t.state.dump(t.workflowId, 'test')['baseline:a:new']?.value).toMatchObject({ medianMs: 90 });
  });
});

describe('the report', () => {
  it('matches its golden file: same results, same bytes', async () => {
    const results: TargetResult[] = [
      { key: 'projects', label: 'old', url: 'u', medianMs: 212.4, maxMs: 260, bytes: 48_213, status: 200, baselineMs: 205, deltaPct: 3.6, verdict: 'ok', remeasured: false },
      { key: 'projects', label: 'new', url: 'u', medianMs: 38.1, maxMs: 44, bytes: 1_904, status: 200, baselineMs: 30, deltaPct: 27, verdict: 'regression', remeasured: true },
      { key: 'buyers', label: 'list', url: 'u', medianMs: 120, maxMs: 131, p95Ms: 129, bytes: 20_480, status: 200, verdict: 'baseline created', remeasured: false },
    ];
    const comparisons = compareAll(
      [{ data: measurement('projects', 'old', 212.4, 48_213) }, { data: measurement('projects', 'new', 38.1, 1_904) }] as { data: unknown }[],
      [['old', 'new']],
      10,
    ).comparisons;
    const markdown = renderReport({ title: 'Endpoint latency', environment: 'https://dev.example.com', regressionPct: 20, minDeltaMs: 5, tolerancePct: 10, policy: 'onPass', results, comparisons });
    const golden = await matchGolden(fileURLToPath(new URL('./golden/report.md', import.meta.url)), markdown);
    expect(golden.ok ? markdown : golden.expected).toBe(markdown);
  });
});

describe('bench.chart', () => {
  const pairs = () =>
    compareAll(
      [
        { data: measurement('projects', 'old', 212.4, 48_213) },
        { data: measurement('projects', 'new', 38.1, 1_904) },
        { data: measurement('users', 'old', 14.9, 140) },
        { data: measurement('users', 'new', 18.5, 162) },
        { data: measurement('cancellations', 'full', 31.5, 12_288) },
        { data: measurement('cancellations', 'list', 19.2, 1_331) },
      ] as { data: unknown }[],
      [
        ['old', 'new'],
        ['full', 'list'],
      ],
      10,
    ).comparisons;

  it('draws each pair’s before and after as a picture, kept as a file with only its reference on the item', async () => {
    const t = createNodeHarness(node('bench.chart'));
    const run = await t.run({ items: pairs().map((c) => ({ data: c as unknown as JsonValue })), variables: { baseUrl: 'https://dev.test' } });
    const out = run.items('main')[0]!;
    expect(out.data).toMatchObject({ pairs: 3, faster: 2, slower: 0, same: 1, metric: 'time' });
    expect(out.binary?.['chart']).toMatchObject({ mimeType: 'image/svg+xml', fileName: 'before-after.svg' });
    const svg = new TextDecoder().decode(await t.blobs.get(out.binary!['chart']!));
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    expect(svg).toContain('https://dev.test · 3 pairs');
    expect(svg).toContain('82.1% faster');
    // Plain drawing only: nothing in it can run or fetch.
    expect(svg).not.toMatch(/<script|on\w+=|href=|<foreignObject|url\(/i);
  });

  it('escapes names, so an endpoint called <script> is text, not markup', () => {
    const [c] = pairs();
    const svg = renderChart({ title: 'A & B', comparisons: [{ ...c!, key: '<script>alert(1)</script>' }], metric: 'time' });
    expect(svg).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('<title>A &amp; B</title>');
  });

  it('says so when there is nothing to draw', () => {
    expect(renderChart({ title: 'Before and after', comparisons: [], metric: 'both' })).toContain('No pairs to compare');
  });

  it('matches its golden file: same comparisons, same bytes', async () => {
    const svg = renderChart({ title: 'BM-1496: before and after', environment: 'https://dev.example.com', comparisons: pairs(), metric: 'both' });
    const golden = await matchGolden(fileURLToPath(new URL('./golden/chart.svg', import.meta.url)), svg);
    expect(golden.ok ? svg : golden.expected).toBe(svg);
  });
});
