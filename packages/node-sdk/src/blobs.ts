/**
 * `ctx.blobs` — files a box makes, kept by reference (§6.1, ADR-013).
 *
 * A report, a download, an image: the bytes go to a BlobStore and only a
 * small BinaryRef travels on the item and into the journal. Content-addressed
 * (the key is the SHA-256 of the bytes), so the same report written twice is
 * stored once and a key can never point at different contents over time.
 *
 * Local mode keeps blobs in the workspace folder; Stage 7 implements the
 * same port on S3. Cleanup is deferred to run retention (§9): until then,
 * blobs are kept.
 */

import type { BinaryRef } from '@goblin/spec';

import { NodeFailure } from './failure.js';

export interface BlobStore {
  put(bytes: Uint8Array, meta: { mimeType: string; fileName?: string }): Promise<BinaryRef>;
  get(ref: BinaryRef | string): Promise<Uint8Array | undefined>;
  stat(ref: BinaryRef | string): Promise<{ size: number } | undefined>;
}

export const DEFAULT_MAX_BLOB_BYTES = 25 * 1024 * 1024;

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Keys are 64 hex characters: safe as a file name and as a URL segment. */
export const isBlobKey = (key: string) => /^[0-9a-f]{64}$/.test(key);

export function assertBlobSize(size: number, max: number): void {
  if (size > max) {
    throw new NodeFailure(`That file is ${Math.ceil(size / 1024 / 1024)} MB; files kept with a run can be at most ${Math.round(max / 1024 / 1024)} MB.`, {
      code: 'BLOB_TOO_LARGE',
      errorClass: 'validation',
    });
  }
}

export class InMemoryBlobStore implements BlobStore {
  private readonly blobs = new Map<string, Uint8Array>();

  constructor(private readonly maxBytes = DEFAULT_MAX_BLOB_BYTES) {}

  async put(bytes: Uint8Array, meta: { mimeType: string; fileName?: string }): Promise<BinaryRef> {
    assertBlobSize(bytes.byteLength, this.maxBytes);
    const key = await sha256Hex(bytes);
    if (!this.blobs.has(key)) this.blobs.set(key, bytes.slice());
    return { key, mimeType: meta.mimeType, size: bytes.byteLength, ...(meta.fileName ? { fileName: meta.fileName } : {}) };
  }

  async get(ref: BinaryRef | string): Promise<Uint8Array | undefined> {
    return this.blobs.get(typeof ref === 'string' ? ref : ref.key)?.slice();
  }

  async stat(ref: BinaryRef | string): Promise<{ size: number } | undefined> {
    const b = this.blobs.get(typeof ref === 'string' ? ref : ref.key);
    return b ? { size: b.byteLength } : undefined;
  }
}
