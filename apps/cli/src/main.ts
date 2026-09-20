#!/usr/bin/env node
/**
 * goblin — run a workflow document from the command line.
 *
 * The deliverable of Stage 1: a real graph with branching, loops, retries and
 * skips executes with no database, no queue and no UI. If that works, the rest
 * of the platform is comparatively mechanical; if it does not, no amount of
 * platform will save it.
 */

import { readFile } from 'node:fs/promises';
import { argv, exit, stderr, stdout } from 'node:process';

import { runWorkflow, replay } from '@goblin/drivers-inprocess';
import { coreManifests, coreNodes } from '@goblin/nodes-core';
import { compile } from '@goblin/graph';
import {
  MapRegistry,
  formatDiagnostic,
  hasErrors,
  migrateDocument,
  validateDocument,
  type Envelope,
  type JsonValue,
} from '@goblin/spec';
import type { JournalEntry } from '@goblin/runtime';

const registry = new MapRegistry(coreManifests);

async function main(): Promise<number> {
  const [command, ...rest] = argv.slice(2);

  switch (command) {
    case 'run':
      return run(rest);
    case 'validate':
      return validate(rest);
    case 'replay':
      return replayJournal(rest);
    case 'nodes':
      return listNodes();
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      usage();
      return 0;
    default:
      stderr.write(`goblin: unknown command ${JSON.stringify(command)}\n\n`);
      usage();
      return 2;
  }
}

function usage(): void {
  stderr.write(`goblin — run a workflow, with the engine that decides nothing twice.

  goblin run WORKFLOW.json [--input '{"k":1}'] [--journal out.json] [--quiet]
  goblin validate WORKFLOW.json
  goblin replay JOURNAL.json
  goblin nodes

Every run writes a journal. State is a fold of it, so a journal replays to the
same state anywhere — which is what "replay" is for.
`);
}

async function loadDocument(path: string | undefined) {
  if (!path) throw new Error('A workflow file is required.');
  const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
  const { document, applied } = migrateDocument(raw);
  for (const note of applied) stderr.write(`migrated → ${note}\n`);
  return document;
}

async function validate(args: string[]): Promise<number> {
  const doc = await loadDocument(args[0]);
  const diagnostics = [...validateDocument(doc, registry), ...compile(doc, registry).diagnostics];

  if (diagnostics.length === 0) {
    stdout.write(`${doc.name}: no problems found.\n`);
    return 0;
  }
  for (const d of diagnostics) stdout.write(`${formatDiagnostic(d)}\n`);
  return hasErrors(diagnostics) ? 1 : 0;
}

async function run(args: string[]): Promise<number> {
  const path = args.find((a) => !a.startsWith('--'));
  const doc = await loadDocument(path);

  const inputArg = flag(args, '--input');
  const journalPath = flag(args, '--journal');
  const quiet = args.includes('--quiet');

  const diagnostics = [...validateDocument(doc, registry), ...compile(doc, registry).diagnostics];
  if (hasErrors(diagnostics)) {
    // Failing before the first node runs, with the precise reason, beats
    // failing halfway through with a partial side effect already committed.
    stderr.write('This workflow cannot run:\n');
    for (const d of diagnostics.filter((x) => x.severity === 'error')) stderr.write(`  ${formatDiagnostic(d)}\n`);
    return 1;
  }
  for (const d of diagnostics.filter((x) => x.severity !== 'error')) stderr.write(`  ${formatDiagnostic(d)}\n`);

  const input: Envelope = inputArg
    ? { items: toItems(JSON.parse(inputArg) as JsonValue) }
    : { items: [{ data: {} }] };

  const started = Date.now();
  const result = await runWorkflow({
    document: doc,
    registry,
    nodes: coreNodes,
    input,
    // Spread rather than a conditional property: under
    // exactOptionalPropertyTypes an explicit `undefined` is not the same thing
    // as an absent key.
    ...(quiet
      ? {}
      : {
          onLog: (line: { level: string; node: string; message: string; data?: JsonValue }) => {
            stderr.write(`  [${line.node}] ${line.message}${line.data ? ` ${JSON.stringify(line.data)}` : ''}\n`);
          },
        }),
  });

  if (!quiet) printRun(result.journal, Date.now() - started);

  if (journalPath) {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(journalPath, `${JSON.stringify(result.journal, null, 2)}\n`);
    stderr.write(`journal → ${journalPath}\n`);
  }

  if (result.state.status === 'succeeded') {
    stdout.write(`${JSON.stringify(result.state.output ?? { items: [] }, null, 2)}\n`);
    return 0;
  }
  stderr.write(`\nrun ${result.state.status}: ${result.state.error?.message ?? 'no reason recorded'}\n`);
  return 1;
}

async function replayJournal(args: string[]): Promise<number> {
  const path = args[0];
  if (!path) throw new Error('A journal file is required.');
  const entries = JSON.parse(await readFile(path, 'utf8')) as JournalEntry[];
  const state = replay('replayed', entries);

  stdout.write(`status      ${state.status}\n`);
  stdout.write(`entries     ${entries.length}\n`);
  stdout.write(`nodes run   ${state.counters.nodesRun}\n`);
  stdout.write(`items       ${state.counters.itemsProcessed}\n`);
  stdout.write(`errors      ${state.counters.errors}, retries ${state.counters.retries}\n`);
  if (state.error) stdout.write(`error       ${state.error.message}\n`);
  return 0;
}

function listNodes(): number {
  for (const manifest of coreManifests) {
    const engine = manifest.scope || manifest.type === 'core.wait' ? '  (engine-implemented)' : '';
    stdout.write(`${manifest.type}@${manifest.version}  ${manifest.title}${engine}\n`);
    if (manifest.description) stdout.write(`    ${manifest.description}\n`);
  }
  return 0;
}

/**
 * The run, as it happened.
 *
 * Printed from the journal rather than from state, because the journal is the
 * only place the ORDER of what happened survives — and the order is most of
 * what a person wants when a workflow did something surprising.
 */
function printRun(journal: readonly JournalEntry[], ms: number): void {
  stderr.write('\n');
  for (const entry of journal) {
    switch (entry.kind) {
      case 'NodeRunStarted':
        stderr.write(`  → ${entry.nodeId}${entry.scopePath ? ` @${entry.scopePath}` : ''}${entry.attempt > 1 ? ` (attempt ${entry.attempt})` : ''}\n`);
        break;
      case 'NodeRunFailed':
        stderr.write(`  ✗ ${entry.error.message}\n`);
        break;
      case 'NodeRunSkipped':
        stderr.write(`  · ${entry.nodeId} skipped — ${entry.reason}\n`);
        break;
      case 'ScopeOpened':
        stderr.write(`  ↻ ${entry.scope.scopeId} over ${entry.scope.items.length} items\n`);
        break;
      case 'TimerScheduled':
        stderr.write(`  ⏲ ${entry.timer.purpose} ${entry.timer.fireAt - entry.at}ms\n`);
        break;
      case 'RunCompleted':
        stderr.write(`  ${entry.status === 'succeeded' ? '✓' : '✗'} run ${entry.status} in ${ms}ms\n`);
        break;
      default:
        break;
    }
  }
}

function toItems(value: JsonValue) {
  return Array.isArray(value) ? value.map((data) => ({ data })) : [{ data: value }];
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

main()
  .then((code) => exit(code))
  .catch((error: unknown) => {
    stderr.write(`goblin: ${error instanceof Error ? error.message : String(error)}\n`);
    exit(1);
  });
