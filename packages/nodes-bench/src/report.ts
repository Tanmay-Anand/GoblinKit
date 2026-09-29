/**
 * The Markdown report `bench.baseline` writes, kept as a file with the run.
 *
 * No timestamps and no run ids in it: the same results always make the same
 * report, byte for byte, so it can be golden-file tested and two reports can
 * be diffed. The run it belongs to already says when it happened.
 */

import type { Comparison } from './compare.js';
import type { TargetResult } from './baseline.js';

const ms = (n: number | undefined) => (n === undefined ? '—' : n.toFixed(1));
const pct = (n: number | undefined) => (n === undefined ? '—' : `${n > 0 ? '+' : ''}${n.toFixed(1)}%`);

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/** A change that is only noise shows as ≈, so a big percentage of a tiny number cannot alarm. */
const saved = (n: number, meaningful: boolean) => (meaningful ? pct(n) : '≈');

/** "faster · smaller", "same time · smaller", or, when neither moved, "about the same". */
export function pairVerdict(c: Pick<Comparison, 'verdict' | 'sizeVerdict'>): string {
  const size = c.sizeVerdict ?? 'about the same';
  if (c.verdict === 'about the same' && size === 'about the same') return 'about the same';
  return `${c.verdict === 'about the same' ? 'same time' : c.verdict} · ${size === 'about the same' ? 'same size' : size}`;
}

const VERDICT: Record<TargetResult['verdict'], string> = {
  'baseline created': 'baseline created',
  ok: 'ok',
  faster: 'faster',
  regression: '**REGRESSION**',
};

export function renderReport(args: {
  title: string;
  environment: string;
  regressionPct: number;
  tolerancePct: number;
  policy: string;
  /** The baseline box's noise floor, in ms. */
  minDeltaMs?: number;
  results: TargetResult[];
  comparisons: Comparison[];
}): string {
  const { results, comparisons } = args;
  const regressions = results.filter((r) => r.verdict === 'regression').length;
  const lines: string[] = [
    `# ${args.title}`,
    '',
    `**${results.length} target${results.length === 1 ? '' : 's'}: ${regressions ? `${regressions} regression${regressions === 1 ? '' : 's'}` : 'no regressions'}.**`,
    '',
    `- Environment: ${args.environment || '(not set — set $vars.baseUrl)'}`,
    `- A regression is a median more than ${args.regressionPct}%${args.minDeltaMs ? ` and at least ${args.minDeltaMs} ms` : ''} over its baseline, confirmed by measuring once more. Baselines are kept per environment and advance by \`${args.policy}\`, rising at most ${args.tolerancePct}% per run.`,
    '- ≈ marks a change too small to mean anything: inside the tolerance, or under the noise floor (a few milliseconds, or a few hundred bytes).',
    '- Connections are kept alive between runs, where `curl` opens a fresh one each time, so these times leave out connection setup.',
    '- Sizes are the decoded body. This client asks for gzip and counts what it unpacks to; `curl` without `--compressed` asks for uncompressed bodies. Old and new are measured the same way, so comparisons stay like-for-like.',
    '',
    '| Endpoint | Variant | Median (ms) | Baseline (ms) | Change | p95 / max (ms) | Size | Verdict |',
    '|---|---|---:|---:|---:|---:|---:|---|',
  ];
  for (const r of [...results].sort((a, b) => a.key.localeCompare(b.key) || a.label.localeCompare(b.label))) {
    const tail = r.p95Ms !== undefined ? `p95 ${ms(r.p95Ms)}` : `max ${ms(r.maxMs)}`;
    const note = r.remeasured ? ' (re-measured)' : '';
    lines.push(`| ${r.key} | ${r.label} | ${ms(r.medianMs)} | ${ms(r.baselineMs)} | ${pct(r.deltaPct)} | ${tail} | ${bytes(r.bytes)} | ${VERDICT[r.verdict]}${note} |`);
  }

  if (comparisons.length) {
    lines.push('', '## Variants compared', '', '| Endpoint | Pair | Median (ms) | Time saved | Size | Size saved | Verdict |', '|---|---|---:|---:|---:|---:|---|');
    for (const c of [...comparisons].sort((a, b) => a.key.localeCompare(b.key))) {
      lines.push(
        `| ${c.key} | ${c.baseline} → ${c.candidate} | ${ms(c.baselineMedianMs)} → ${ms(c.candidateMedianMs)} | ${saved(c.timeSavedPct, c.verdict !== 'about the same')} | ${bytes(c.baselineBytes)} → ${bytes(c.candidateBytes)} | ${saved(c.sizeSavedPct, (c.sizeVerdict ?? 'about the same') !== 'about the same')} | ${pairVerdict(c)} |`,
      );
    }
  }
  return `${lines.join('\n')}\n`;
}
