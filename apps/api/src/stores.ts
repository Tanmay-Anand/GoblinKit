/**
 * Where workflows and runs are kept.
 *
 * Two ports and one implementation: plain JSON files in a workspace folder,
 * which is all one person on one machine needs. Postgres arrives in Stage 7
 * by implementing these same interfaces, and has to pass the same contract
 * tests (test/stores.test.ts) the file stores pass — that is what stops the
 * local version quietly growing assumptions a database cannot keep.
 */

import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { JournalEntry } from '@goblin/runtime';
import type { WorkflowDocument } from '@goblin/spec';

import { LOCAL_TENANT, type RunDetail, type RunRecord, type WorkflowSummary } from './protocol.js';

export interface WorkflowStore {
  list(): Promise<WorkflowSummary[]>;
  get(id: string): Promise<WorkflowDocument | undefined>;
  /** Stamps the tenant and `meta.updatedAt`, and returns what was stored. */
  put(document: WorkflowDocument): Promise<WorkflowDocument>;
  delete(id: string): Promise<boolean>;
}

/**
 * Runs, and their journals.
 *
 * The journal is appended as the run happens, a batch at a time, rather than
 * written once at the end: after a crash, what is on disk is everything that
 * had been decided, and the run picks up from there (Stage 4, §7.4).
 */
export interface RunStore {
  /** Record a new run, with the exact workflow it runs, so it can be resumed as it was. */
  create(record: RunRecord, document: WorkflowDocument): Promise<void>;
  append(runId: string, entries: readonly JournalEntry[]): Promise<void>;
  finish(record: RunRecord): Promise<void>;
  /** Newest first. */
  list(workflowId: string, limit?: number): Promise<RunRecord[]>;
  get(runId: string): Promise<RunDetail | undefined>;
  /** The workflow as it was when this run started. */
  document(runId: string): Promise<WorkflowDocument | undefined>;
  /** Runs that started and never recorded an end: the ones to resume. */
  unfinished(): Promise<RunRecord[]>;
}

/** Which workflows are switched on to start by themselves. */
export interface ActivationStore {
  isActive(workflowId: string): Promise<boolean>;
  /** When it was switched on, or undefined if it is off. */
  activatedAt(workflowId: string): Promise<number | undefined>;
  set(workflowId: string, active: boolean, at?: number): Promise<void>;
  /** Every active workflow's id. */
  list(): Promise<string[]>;
}

/**
 * Ids become file names, so they are held to a strict alphabet.
 *
 * Without this, a workflow id of "../../somewhere" writes outside the
 * workspace. The check lives here, at the one place ids touch the disk,
 * rather than trusting every caller to have validated first.
 */
export function assertSafeId(id: string): void {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new StoreError(`Not a valid id: ${JSON.stringify(id)}`);
}

export class StoreError extends Error {
  override readonly name = 'StoreError';
}

/**
 * Write to a temp file and rename, so a crash mid-write never leaves half a
 * JSON file.
 *
 * The temp name is unique per write: two saves of the same workflow can be in
 * flight at once (an autosave and a Run), and a shared temp file would let one
 * overwrite the other's half-written bytes.
 */
async function writeJson(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  try {
    await renameWithRetry(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

/**
 * Windows refuses to replace a file that another handle has open — a
 * concurrent read of the same file, or a virus scanner looking at it — with
 * EPERM, EACCES or EBUSY. It clears within milliseconds, so the rename is
 * retried briefly instead of failing the save. (The same thing graceful-fs
 * does for the same reason.) Found by the e2e suite under parallel load.
 */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const transient = code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
      if (!transient || attempt >= 8) throw error;
      await new Promise((r) => setTimeout(r, 10 * 2 ** attempt));
    }
  }
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export class FileWorkflowStore implements WorkflowStore {
  constructor(private readonly dir: string) {}

  async list(): Promise<WorkflowSummary[]> {
    await mkdir(this.dir, { recursive: true });
    const out: WorkflowSummary[] = [];
    for (const file of await readdir(this.dir)) {
      if (!file.endsWith('.json')) continue;
      const doc = await readJson<WorkflowDocument>(join(this.dir, file));
      if (!doc) continue;
      out.push({
        id: doc.id,
        name: doc.name,
        ...(doc.description ? { description: doc.description } : {}),
        boxes: doc.nodes.length,
        updatedAt: doc.meta?.updatedAt ?? new Date(0).toISOString(),
      });
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async get(id: string): Promise<WorkflowDocument | undefined> {
    assertSafeId(id);
    return readJson<WorkflowDocument>(join(this.dir, `${id}.json`));
  }

  async put(document: WorkflowDocument): Promise<WorkflowDocument> {
    assertSafeId(document.id);
    await mkdir(this.dir, { recursive: true });
    const now = new Date().toISOString();
    const stored: WorkflowDocument = {
      ...document,
      tenantId: LOCAL_TENANT,
      meta: { ...document.meta, createdAt: document.meta?.createdAt ?? now, updatedAt: now },
    };
    await writeJson(join(this.dir, `${document.id}.json`), stored);
    return stored;
  }

  async delete(id: string): Promise<boolean> {
    assertSafeId(id);
    const path = join(this.dir, `${id}.json`);
    if (!(await readJson(path))) return false;
    await rm(path);
    return true;
  }
}

export class FileRunStore implements RunStore {
  constructor(private readonly dir: string) {}

  private recordPath(runId: string) {
    return join(this.dir, `${runId}.run.json`);
  }

  /** One JSON entry per line, appended as the run goes. */
  private journalPath(runId: string) {
    return join(this.dir, `${runId}.journal.ndjson`);
  }

  /** Stage 3 wrote the whole journal as one JSON array at the end; still readable. */
  private legacyJournalPath(runId: string) {
    return join(this.dir, `${runId}.journal.json`);
  }

  private documentPath(runId: string) {
    return join(this.dir, `${runId}.workflow.json`);
  }

  async create(record: RunRecord, document: WorkflowDocument): Promise<void> {
    assertSafeId(record.runId);
    await mkdir(this.dir, { recursive: true });
    await writeJson(this.documentPath(record.runId), document);
    await writeJson(this.recordPath(record.runId), record);
  }

  async append(runId: string, entries: readonly JournalEntry[]): Promise<void> {
    assertSafeId(runId);
    if (entries.length === 0) return;
    await mkdir(this.dir, { recursive: true });
    await appendFile(this.journalPath(runId), entries.map((e) => `${JSON.stringify(e)}\n`).join(''), 'utf8');
  }

  async finish(record: RunRecord): Promise<void> {
    assertSafeId(record.runId);
    await mkdir(this.dir, { recursive: true });
    await writeJson(this.recordPath(record.runId), record);
  }

  async list(workflowId: string, limit = 50): Promise<RunRecord[]> {
    return (await this.records())
      .filter((r) => r.workflowId === workflowId)
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, limit);
  }

  async get(runId: string): Promise<RunDetail | undefined> {
    assertSafeId(runId);
    const record = await readJson<RunRecord>(this.recordPath(runId));
    if (!record) return undefined;
    return { record, journal: await this.journal(runId) };
  }

  async document(runId: string): Promise<WorkflowDocument | undefined> {
    assertSafeId(runId);
    return readJson<WorkflowDocument>(this.documentPath(runId));
  }

  async unfinished(): Promise<RunRecord[]> {
    return (await this.records()).filter((r) => r.finishedAt === undefined);
  }

  private async records(): Promise<RunRecord[]> {
    await mkdir(this.dir, { recursive: true });
    const out: RunRecord[] = [];
    for (const file of await readdir(this.dir)) {
      if (!file.endsWith('.run.json')) continue;
      const record = await readJson<RunRecord>(join(this.dir, file));
      if (record) out.push(record);
    }
    return out;
  }

  private async journal(runId: string): Promise<JournalEntry[]> {
    let text: string;
    try {
      text = await readFile(this.journalPath(runId), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return (await readJson<JournalEntry[]>(this.legacyJournalPath(runId))) ?? [];
    }
    const entries: JournalEntry[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as JournalEntry);
      } catch {
        // A crash mid-append leaves at most one half-written last line. What
        // came before it is intact, and that is what the run resumes from.
        break;
      }
    }
    return entries;
  }
}

export class FileActivationStore implements ActivationStore {
  constructor(private readonly path: string) {}

  private async read(): Promise<Record<string, { activatedAt: number }>> {
    return (await readJson<Record<string, { activatedAt: number }>>(this.path)) ?? {};
  }

  async isActive(workflowId: string): Promise<boolean> {
    return (await this.activatedAt(workflowId)) !== undefined;
  }

  async activatedAt(workflowId: string): Promise<number | undefined> {
    return (await this.read())[workflowId]?.activatedAt;
  }

  async set(workflowId: string, active: boolean, at = Date.now()): Promise<void> {
    assertSafeId(workflowId);
    const all = await this.read();
    if (active) all[workflowId] = { activatedAt: all[workflowId]?.activatedAt ?? at };
    else delete all[workflowId];
    await mkdir(dirname(this.path), { recursive: true });
    await writeJson(this.path, all);
  }

  async list(): Promise<string[]> {
    return Object.keys(await this.read());
  }
}
