/**
 * The before/after chart `bench.chart` draws: for every compared endpoint,
 * the "before" variant as a grey bar and the "after" as a coloured one —
 * green when it got better, red when worse, grey when the change is noise.
 *
 * Plain SVG built from strings, with no scripts, no external fonts and no
 * links, so the file is safe to show inline and opens anywhere. Like the
 * report it carries no timestamps: the same comparisons draw the same bytes.
 */

import type { Comparison } from './compare.js';
import { bytes } from './report.js';

export type ChartMetric = 'time' | 'size' | 'both';

const WIDTH = 760;
const LABEL_X = 16;
const BAR_X = 220;
const BAR_MAX = 330;
const VERDICT_X = WIDTH - 16;
const ROW = 50;
const BAR_H = 14;

const COLOR = {
  text: '#1f2933',
  muted: '#667085',
  rule: '#e4e7ec',
  before: '#c3cad5',
  better: '#2f9e5b',
  worse: '#d64545',
  same: '#8a96a8',
};

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const n1 = (n: number) => (Math.round(n * 10) / 10).toFixed(1);

interface Section {
  heading: string;
  value: (c: Comparison, side: 'before' | 'after') => number;
  format: (n: number) => string;
  /** Colour and words for the change. */
  change: (c: Comparison) => { color: string; words: string };
}

const TIME: Section = {
  heading: 'Median response time',
  value: (c, side) => (side === 'before' ? c.baselineMedianMs : c.candidateMedianMs),
  format: (n) => `${n1(n)} ms`,
  change: (c) =>
    c.verdict === 'faster'
      ? { color: COLOR.better, words: `${n1(c.timeSavedPct)}% faster` }
      : c.verdict === 'slower'
        ? { color: COLOR.worse, words: `${n1(-c.timeSavedPct)}% slower` }
        : { color: COLOR.same, words: 'about the same' },
};

const SIZE: Section = {
  heading: 'Response size',
  value: (c, side) => (side === 'before' ? c.baselineBytes : c.candidateBytes),
  format: bytes,
  change: (c) =>
    c.sizeVerdict === 'smaller'
      ? { color: COLOR.better, words: `${n1(c.sizeSavedPct)}% smaller` }
      : c.sizeVerdict === 'larger'
        ? { color: COLOR.worse, words: `${n1(-c.sizeSavedPct)}% larger` }
        : { color: COLOR.same, words: 'about the same' },
};

function text(x: number, y: number, body: string, attrs = ''): string {
  return `<text x="${x}" y="${y}"${attrs ? ` ${attrs}` : ''}>${esc(body)}</text>`;
}

function drawSection(section: Section, rows: Comparison[], top: number): { svg: string[]; height: number } {
  const out: string[] = [text(LABEL_X, top + 16, section.heading, `font-size="14" font-weight="600" fill="${COLOR.text}"`)];
  const max = Math.max(0, ...rows.flatMap((c) => [section.value(c, 'before'), section.value(c, 'after')]));
  const width = (v: number) => (max > 0 ? Math.max(2, Math.round((v / max) * BAR_MAX)) : 2);
  let y = top + 30;
  for (const c of rows) {
    const change = section.change(c);
    const before = section.value(c, 'before');
    const after = section.value(c, 'after');
    out.push(
      `<line x1="${LABEL_X}" y1="${y}" x2="${WIDTH - 16}" y2="${y}" stroke="${COLOR.rule}"/>`,
      text(LABEL_X, y + 20, c.key, `font-size="13" font-weight="600" fill="${COLOR.text}"`),
      text(LABEL_X, y + 37, `${c.baseline} → ${c.candidate}`, `font-size="12" fill="${COLOR.muted}"`),
      `<rect x="${BAR_X}" y="${y + 8}" width="${width(before)}" height="${BAR_H}" rx="2" fill="${COLOR.before}"/>`,
      text(BAR_X + width(before) + 6, y + 19, `${c.baseline} ${section.format(before)}`, `font-size="11.5" fill="${COLOR.muted}"`),
      `<rect x="${BAR_X}" y="${y + 26}" width="${width(after)}" height="${BAR_H}" rx="2" fill="${change.color}"/>`,
      text(BAR_X + width(after) + 6, y + 37, `${c.candidate} ${section.format(after)}`, `font-size="11.5" fill="${COLOR.text}"`),
      text(VERDICT_X, y + 29, change.words, `font-size="12.5" font-weight="600" text-anchor="end" fill="${change.color}"`),
    );
    y += ROW;
  }
  return { svg: out, height: y - top + 8 };
}

export function renderChart(args: { title: string; environment?: string; comparisons: readonly Comparison[]; metric: ChartMetric }): string {
  const rows = [...args.comparisons].sort((a, b) => a.key.localeCompare(b.key) || a.baseline.localeCompare(b.baseline) || a.candidate.localeCompare(b.candidate));
  const body: string[] = [
    text(LABEL_X, 30, args.title, `font-size="18" font-weight="700" fill="${COLOR.text}"`),
    text(LABEL_X, 50, args.environment ? `${args.environment} · ${rows.length} pair${rows.length === 1 ? '' : 's'}` : `${rows.length} pair${rows.length === 1 ? '' : 's'}`, `font-size="12" fill="${COLOR.muted}"`),
  ];
  // The legend: what the colours mean.
  let lx = LABEL_X;
  for (const [color, words] of [
    [COLOR.before, 'before'],
    [COLOR.better, 'after: better'],
    [COLOR.worse, 'after: worse'],
    [COLOR.same, 'after: about the same'],
  ] as const) {
    body.push(`<rect x="${lx}" y="62" width="12" height="12" rx="2" fill="${color}"/>`, text(lx + 17, 72, words, `font-size="12" fill="${COLOR.muted}"`));
    lx += 30 + words.length * 6.6;
  }

  let y = 88;
  if (!rows.length) {
    body.push(text(LABEL_X, y + 24, 'No pairs to compare: no endpoint had both its before and after variant measured.', `font-size="13" fill="${COLOR.muted}"`));
    y += 44;
  } else {
    const sections = args.metric === 'size' ? [SIZE] : args.metric === 'both' ? [TIME, SIZE] : [TIME];
    for (const section of sections) {
      const drawn = drawSection(section, rows, y);
      body.push(...drawn.svg);
      y += drawn.height + 8;
    }
  }

  const height = Math.round(y + 8);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" role="img" aria-label="${esc(args.title)}" font-family="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif">`,
    `<title>${esc(args.title)}</title>`,
    `<rect width="${WIDTH}" height="${height}" fill="#ffffff"/>`,
    ...body,
    '</svg>',
    '',
  ].join('\n');
}
