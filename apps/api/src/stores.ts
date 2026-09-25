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
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

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

export interface RunStore {
  create(record: RunRecord): Promise<void>;
  finish(record: RunRecord, journal: readonly JournalEntry[]): Promise<void>;
  /** Newest first. */
  list(workflowId: string, limit?: number): Promise<RunRecord[]>;
  get(runId: string): Promise<RunDetail | undefined>;
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

  private journalPath(runId: string) {
    return join(this.dir, `${runId}.journal.json`);
  }

  async create(record: RunRecord): Promise<void> {
    assertSafeId(record.runId);
    await mkdir(this.dir, { recursive: true });
    await writeJson(this.recordPath(record.runId), record);
  }

  async finish(record: RunRecord, journal: readonly JournalEntry[]): Promise<void> {
    assertSafeId(record.runId);
    await mkdir(this.dir, { recursive: true });
    // Journal first: a record that says "finished" must never point at a
    // journal that was not written.
    await writeJson(this.journalPath(record.runId), journal);
    await writeJson(this.recordPath(record.runId), record);
  }

  async list(workflowId: string, limit = 50): Promise<RunRecord[]> {
    await mkdir(this.dir, { recursive: true });
    const records: RunRecord[] = [];
    for (const file of await readdir(this.dir)) {
      if (!file.endsWith('.run.json')) continue;
      const record = await readJson<RunRecord>(join(this.dir, file));
      if (record && record.workflowId === workflowId) records.push(record);
    }
    return records.sort((a, b) => b.startedAt - a.startedAt).slice(0, limit);
  }

  async get(runId: string): Promise<RunDetail | undefined> {
    assertSafeId(runId);
    const record = await readJson<RunRecord>(this.recordPath(runId));
    if (!record) return undefined;
    const journal = (await readJson<JournalEntry[]>(this.journalPath(runId))) ?? [];
    return { record, journal };
  }
}
