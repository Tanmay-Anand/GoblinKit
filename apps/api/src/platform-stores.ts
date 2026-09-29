/**
 * Local implementations of the kit's box-facing stores: `ctx.state` and
 * `ctx.blobs`. Stage 7 puts Postgres and S3 behind the same ports, and must
 * pass the same contract tests (test/platform-stores.test.ts).
 */

import { createReadStream, type ReadStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import {
  applyWrites,
  assertBlobSize,
  DEFAULT_MAX_BLOB_BYTES,
  isBlobKey,
  sha256Hex,
  type ApplyResult,
  type BlobStore,
  type StateEntry,
  type StateStore,
} from '@goblin/node-sdk';
import type { BinaryRef, StateWrite } from '@goblin/spec';

import { assertSafeId, writeJson } from './stores.js';

interface StateFile {
  /** Box id → key → entry. */
  nodes: Record<string, Record<string, StateEntry>>;
  /** The most recent writers applied, so applying one again is a no-op. */
  applied: string[];
}

const APPLIED_KEPT = 500;

/**
 * `workspace/state/<workflowId>.json`. One file per workflow, changed one
 * apply at a time, so a version check and the write it guards cannot be
 * split by another run's write in between.
 */
export class FileStateStore implements StateStore {
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly dir: string) {}

  private path(workflowId: string) {
    assertSafeId(workflowId);
    return join(this.dir, `${workflowId}.json`);
  }

  private async read(workflowId: string): Promise<StateFile> {
    try {
      return JSON.parse(await readFile(this.path(workflowId), 'utf8')) as StateFile;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { nodes: {}, applied: [] };
      throw error;
    }
  }

  async get(workflowId: string, nodeId: string, key: string): Promise<StateEntry | undefined> {
    await this.queues.get(workflowId);
    return (await this.read(workflowId)).nodes[nodeId]?.[key];
  }

  async apply(workflowId: string, nodeId: string, writes: readonly StateWrite[], writer: string): Promise<ApplyResult> {
    const previous = this.queues.get(workflowId) ?? Promise.resolve();
    const next = previous.then(async (): Promise<ApplyResult> => {
      const file = await this.read(workflowId);
      if (file.applied.includes(writer)) return { conflicts: [], alreadyApplied: true };
      const entries = file.nodes[nodeId] ?? {};
      const conflicts = applyWrites(entries, writes);
      file.nodes[nodeId] = entries;
      file.applied = [...file.applied, writer].slice(-APPLIED_KEPT);
      await mkdir(this.dir, { recursive: true });
      await writeJson(this.path(workflowId), file);
      return { conflicts, alreadyApplied: false };
    });
    this.queues.set(workflowId, next.catch(() => {}));
    return next;
  }

  /** Everything one box holds, for the API and tests. */
  async dump(workflowId: string, nodeId: string): Promise<Record<string, StateEntry>> {
    await this.queues.get(workflowId);
    return (await this.read(workflowId)).nodes[nodeId] ?? {};
  }
}

/**
 * `workspace/blobs/<sha256>`: content-addressed, so a file written twice is
 * kept once and a key always means the same bytes. Kept until run retention
 * arrives (§9) — nothing deletes them yet.
 */
export class FileBlobStore implements BlobStore {
  constructor(
    private readonly dir: string,
    private readonly maxBytes = DEFAULT_MAX_BLOB_BYTES,
  ) {}

  private path(key: string): string {
    if (!isBlobKey(key)) throw new Error(`Not a blob key: ${JSON.stringify(key)}`);
    return join(this.dir, key);
  }

  async put(bytes: Uint8Array, meta: { mimeType: string; fileName?: string }): Promise<BinaryRef> {
    assertBlobSize(bytes.byteLength, this.maxBytes);
    const key = await sha256Hex(bytes);
    const path = this.path(key);
    if (!(await stat(path).catch(() => undefined))) {
      await mkdir(this.dir, { recursive: true });
      const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
      await writeFile(tmp, bytes);
      await rename(tmp, path).catch(async (error: NodeJS.ErrnoException) => {
        await rm(tmp, { force: true });
        // Someone else stored the same bytes first: same key, same content.
        if (!(await stat(path).catch(() => undefined))) throw error;
      });
    }
    return { key, mimeType: meta.mimeType, size: bytes.byteLength, ...(meta.fileName ? { fileName: meta.fileName } : {}) };
  }

  async get(ref: BinaryRef | string): Promise<Uint8Array | undefined> {
    try {
      return new Uint8Array(await readFile(this.path(typeof ref === 'string' ? ref : ref.key)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async stat(ref: BinaryRef | string): Promise<{ size: number } | undefined> {
    const info = await stat(this.path(typeof ref === 'string' ? ref : ref.key)).catch(() => undefined);
    return info ? { size: info.size } : undefined;
  }

  /** For downloads: a stream, so a large file is never held in memory. */
  open(key: string): ReadStream {
    return createReadStream(this.path(key));
  }
}
