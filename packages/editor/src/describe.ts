/**
 * How a box presents itself: its category, colour, glyph and one-line summary.
 *
 * Derived from the manifest and the box's settings, never stored, so a new
 * node pack gets sensible chrome without the editor knowing it exists: an
 * unknown type falls back to its manifest's `group`.
 */

import type { JsonValue, NodeInstance, NodeManifest } from '@goblin/spec';

export type Glyph = 'hook' | 'play' | 'branch' | 'switch' | 'merge' | 'set' | 'globe' | 'note' | 'loop' | 'repeat' | 'stop' | 'clock' | 'box';

export interface Category {
  id: string;
  title: string;
  hue: string;
  tint: string;
}

export const CATEGORIES: Record<string, Category> = {
  start: { id: 'start', title: 'Start', hue: '#2e9e6b', tint: '#e3f4ec' },
  logic: { id: 'logic', title: 'Logic', hue: '#e0892a', tint: '#fcefdf' },
  data: { id: 'data', title: 'Data', hue: '#7a5bd0', tint: '#eee9fa' },
  loops: { id: 'loops', title: 'Loops', hue: '#168f9c', tint: '#dff2f4' },
  actions: { id: 'actions', title: 'Actions', hue: '#1f84cc', tint: '#e1eff9' },
  timing: { id: 'timing', title: 'Timing', hue: '#c28a12', tint: '#f8f0d9' },
  other: { id: 'other', title: 'Other', hue: '#6b7280', tint: '#eef0f2' },
};

const BY_TYPE: Record<string, { category: string; glyph: Glyph }> = {
  'core.trigger.manual': { category: 'start', glyph: 'play' },
  'core.trigger.schedule': { category: 'start', glyph: 'clock' },
  'core.trigger.webhook': { category: 'start', glyph: 'hook' },
  'core.control.if': { category: 'logic', glyph: 'branch' },
  'core.control.switch': { category: 'logic', glyph: 'switch' },
  'core.control.merge': { category: 'logic', glyph: 'merge' },
  'core.transform.set': { category: 'data', glyph: 'set' },
  'core.scope.forEach': { category: 'loops', glyph: 'loop' },
  'core.scope.while': { category: 'loops', glyph: 'repeat' },
  'core.scope.end': { category: 'loops', glyph: 'stop' },
  'core.http.request': { category: 'actions', glyph: 'globe' },
  'core.log': { category: 'actions', glyph: 'note' },
  'core.wait': { category: 'timing', glyph: 'clock' },
};

export function describeType(manifest: NodeManifest): { category: Category; glyph: Glyph } {
  const known = BY_TYPE[manifest.type];
  if (known) return { category: CATEGORIES[known.category]!, glyph: known.glyph };
  if (manifest.trigger) return { category: CATEGORIES['start']!, glyph: 'play' };
  return { category: CATEGORIES[manifest.group] ?? CATEGORIES['other']!, glyph: 'box' };
}

/** Boxes the plan adds later, shown in the palette so the road ahead is visible. */
export const COMING: { title: string; stage: number; category: string; glyph: Glyph; blurb: string }[] = [
  { title: 'Code', stage: 5, category: 'data', glyph: 'set', blurb: 'Run your own JavaScript, sandboxed' },
  { title: 'Sub-workflow', stage: 5, category: 'actions', glyph: 'box', blurb: 'Run another workflow as one step' },
  { title: 'AI step', stage: 5, category: 'actions', glyph: 'note', blurb: 'Summarize, classify or write with a model' },
  { title: 'Slack', stage: 6, category: 'actions', glyph: 'note', blurb: 'Post and read messages' },
  { title: 'Email', stage: 6, category: 'actions', glyph: 'note', blurb: 'Send mail, or start on new mail' },
  { title: 'Google Sheets', stage: 6, category: 'actions', glyph: 'set', blurb: 'Read and write rows' },
];

/** A short line of what this box is set to do, shown under its name. */
export function summarize(node: NodeInstance, manifest: NodeManifest | undefined, trigger?: { description: string }): string {
  const c = node.config;
  const str = (v: JsonValue | undefined) => (typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v));
  switch (node.type) {
    case 'core.trigger.manual':
      return 'Starts when you press Run';
    case 'core.trigger.schedule':
      // The server's wording, when known: it owns what a schedule means.
      return trigger?.description ?? 'On a timer';
    case 'core.trigger.webhook':
      return trigger?.description ? `Starts on ${trigger.description} to its URL` : 'Starts when its URL is called';
    case 'core.http.request':
      return c['url'] ? `${str(c['method']) || 'GET'} ${str(c['url'])}` : 'No address yet';
    case 'core.control.if':
      return c['condition'] ? `When ${stripBraces(str(c['condition']))}` : 'No condition yet';
    case 'core.control.switch': {
      const cases = Array.isArray(c['cases']) ? c['cases'].length : 0;
      return cases ? `${cases} case${cases === 1 ? '' : 's'}, then fallback` : 'No cases yet';
    }
    case 'core.control.merge':
      return 'Continues with whichever branch ran';
    case 'core.transform.set': {
      const keys = c['values'] && typeof c['values'] === 'object' && !Array.isArray(c['values']) ? Object.keys(c['values']) : [];
      return keys.length ? `Sets ${keys.join(', ')}` : 'Sets nothing yet';
    }
    case 'core.scope.forEach':
      return c['items'] ? `Each of ${stripBraces(str(c['items']))}` : 'Each incoming item';
    case 'core.scope.while':
      return c['condition'] ? `While ${stripBraces(str(c['condition']))}` : 'No condition yet';
    case 'core.scope.end':
      return 'Closes the loop';
    case 'core.wait':
      return `Waits ${humanMs(Number(c['ms'] ?? 0))}`;
    case 'core.log':
      return c['message'] ? stripBraces(str(c['message'])) : 'Records the items';
    default:
      return manifest?.description ?? '';
  }
}

/** What a port is called on the canvas. "main" is the default and goes unlabelled. */
export function portLabel(nodeType: string, port: string): string {
  if (port === 'main') return '';
  if (nodeType === 'core.control.switch' && /^\d+$/.test(port)) return `case ${Number(port) + 1}`;
  if (nodeType === 'core.control.merge') return port === 'a' ? 'first' : port === 'b' ? 'second' : port;
  return port;
}

/** Wire colour by the port it leaves from, echoing the reference's green / orange branches. */
export function portHue(port: string): string {
  switch (port) {
    case 'true':
      return '#2e9e6b';
    case 'false':
      return '#e0892a';
    case 'error':
      return '#d24c4c';
    case 'item':
      return '#168f9c';
    case 'done':
      return '#7a5bd0';
    case 'fallback':
      return '#8a9099';
    default:
      return /^\d+$/.test(port) ? '#1f84cc' : '#9aa1a9';
  }
}

export function humanMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0 s';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${+(ms / 1000).toFixed(1)} s`;
  if (ms < 3_600_000) return `${+(ms / 60_000).toFixed(1)} min`;
  return `${+(ms / 3_600_000).toFixed(1)} h`;
}

function stripBraces(expr: string): string {
  return expr.replace(/\{\{\s*([\s\S]*?)\s*\}\}/g, '$1');
}
