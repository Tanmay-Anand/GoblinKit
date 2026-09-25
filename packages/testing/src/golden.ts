import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { runWorkflow } from '@goblin/drivers-inprocess';
import type { NodeDefinition } from '@goblin/node-sdk';
import type { JournalEntry } from '@goblin/runtime';
import type { Envelope, ManifestRegistry, WorkflowDocument } from '@goblin/spec';

export interface TraceOptions {
  document: WorkflowDocument;
  registry: ManifestRegistry;
  nodes: NodeDefinition[];
  input?: Envelope;
}

/**
 * Run a workflow with every ambient input pinned, and return its trace.
 *
 * Fixed run id, frozen clock, timers that fire immediately: the only things
 * left that can change the trace are the document, the input and the engine.
 * That is the whole point — when the trace changes, one of those three did.
 */
export async function traceRun(options: TraceOptions): Promise<string> {
  const result = await runWorkflow({
    ...options,
    runId: 'golden',
    realTimers: false,
    clock: () => 0,
  });
  return formatTrace(result.journal);
}

/**
 * A journal, as lines a person can review.
 *
 * Timestamps and node-run ids are left out on purpose: they are either
 * frozen or derived, so they would only add noise to every diff. What is kept
 * is what a reviewer needs to judge a change — which box ran, in which loop
 * pass, what each edge carried, and how the run ended.
 */
export function formatTrace(journal: readonly JournalEntry[]): string {
  const runs = new Map<string, string>();
  const at = (nodeId: string, scopePath: string) => (scopePath ? `${nodeId} @${scopePath}` : nodeId);
  // State keys end in "#<scopePath>"; at the top level that is a bare "#".
  const key = (k: string) => k.replace(/#$/, '');
  const lines: string[] = [];

  for (const e of journal) {
    switch (e.kind) {
      case 'RunStarted':
        lines.push(`run started with ${e.trigger.items.length} item(s)`);
        break;
      case 'NodeRunStarted':
        runs.set(e.nodeRunId, at(e.nodeId, e.scopePath));
        lines.push(`→ ${at(e.nodeId, e.scopePath)}${e.attempt > 1 ? ` (attempt ${e.attempt})` : ''}`);
        break;
      case 'NodeRunSucceeded': {
        const ports = Object.entries(e.outputs).map(([port, env]) => `${port}=${env.items.length}`);
        lines.push(`✓ ${runs.get(e.nodeRunId) ?? e.nodeRunId}${ports.length ? ` ${ports.join(' ')}` : ''}`);
        break;
      }
      case 'NodeRunFailed':
        lines.push(`✗ ${runs.get(e.nodeRunId) ?? e.nodeRunId}: ${e.error.message}`);
        break;
      case 'NodeRunSkipped':
        lines.push(`· ${at(e.nodeId, e.scopePath)} skipped: ${e.reason}`);
        break;
      case 'EdgeDelivered':
        lines.push(`  ${key(e.key)} carried ${e.envelope.items.length}`);
        break;
      case 'EdgePruned':
        lines.push(`  ${key(e.key)} pruned: ${e.reason}`);
        break;
      case 'ScopeOpened':
        lines.push(`↻ ${key(e.key)} opened over ${e.scope.items.length}`);
        break;
      case 'ScopeIterated':
        lines.push(`↻ ${key(e.key)} pass ${e.iteration}`);
        break;
      case 'ScopeClosed':
        lines.push(`↻ ${key(e.key)} closed`);
        break;
      case 'TimerScheduled':
        lines.push(`⏲ ${e.timer.purpose} for ${at(e.timer.nodeId, e.timer.scopePath)} after ${e.timer.fireAt - e.at}ms`);
        break;
      case 'TimerCleared':
        lines.push('⏲ cleared');
        break;
      case 'SignalAwaited':
        lines.push(`… waiting on a signal for ${e.signal.nodeId}`);
        break;
      case 'SignalCleared':
        lines.push('… signal cleared');
        break;
      case 'RunStatusChanged':
        lines.push(`run ${e.status}`);
        break;
      case 'RunCompleted':
        lines.push(`run ${e.status}${e.error ? `: ${e.error.message}` : ''}`);
        for (const item of e.output?.items ?? []) lines.push(`  output ${JSON.stringify(item.data)}`);
        break;
    }
  }
  return `${lines.join('\n')}\n`;
}

export interface GoldenResult {
  ok: boolean;
  expected?: string;
  /** True when this call wrote the file rather than compared against it. */
  recorded: boolean;
}

/**
 * Compare a trace with its golden file.
 *
 * A missing file is recorded on the spot, like a first snapshot, except on
 * CI where a missing golden means someone forgot to commit it. Set
 * UPDATE_GOLDEN=1 to accept a deliberate change; the diff then goes to
 * review, which is where an engine change should be judged.
 */
export async function matchGolden(path: string, actual: string): Promise<GoldenResult> {
  const record = async (): Promise<GoldenResult> => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, actual, 'utf8');
    return { ok: true, recorded: true };
  };

  if (process.env['UPDATE_GOLDEN']) return record();

  let expected: string;
  try {
    expected = (await readFile(path, 'utf8')).replace(/\r\n/g, '\n');
  } catch {
    if (process.env['CI']) return { ok: false, recorded: false, expected: '(missing golden file)' };
    return record();
  }
  return { ok: expected === actual, expected, recorded: false };
}
