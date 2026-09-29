import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { InMemoryBlobStore, InMemoryStateStore, type BlobStore, type StateStore } from '@goblin/node-sdk';

import { FileBlobStore, FileStateStore } from '../src/platform-stores.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'goblin-platform-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Every StateStore keeps this contract: files now, Postgres in Stage 7. */
describe.each([
  ['files', () => new FileStateStore(join(dir, 'state'))],
  ['memory', () => new InMemoryStateStore()],
] as [string, () => StateStore][])('StateStore contract: %s', (_name, make) => {
  it('versions each key from 1, per box', async () => {
    const store = make();
    await store.apply('wf_1', 'box', [{ op: 'set', key: 'k', value: { ms: 10 } }], 'w1');
    await store.apply('wf_1', 'box', [{ op: 'set', key: 'k', value: { ms: 12 } }], 'w2');
    expect(await store.get('wf_1', 'box', 'k')).toEqual({ value: { ms: 12 }, version: 2 });
    expect(await store.get('wf_1', 'other', 'k')).toBeUndefined();
  });

  it('checks ifVersion at apply time, dropping only the writes that fail', async () => {
    const store = make();
    await store.apply('wf_1', 'box', [{ op: 'set', key: 'a', value: 1 }], 'w1');
    const result = await store.apply(
      'wf_1',
      'box',
      [
        { op: 'set', key: 'a', value: 2, ifVersion: 'absent' }, // a exists: dropped
        { op: 'set', key: 'b', value: 1, ifVersion: 'absent' }, // b does not: kept
        { op: 'set', key: 'a', value: 3, ifVersion: 1 }, // matches: kept
      ],
      'w2',
    );
    expect(result).toEqual({ conflicts: ['a'], alreadyApplied: false });
    expect(await store.get('wf_1', 'box', 'a')).toEqual({ value: 3, version: 2 });
    expect(await store.get('wf_1', 'box', 'b')).toEqual({ value: 1, version: 1 });
  });

  it('applies one writer once: a second apply is a no-op, which makes resume safe', async () => {
    const store = make();
    await store.apply('wf_1', 'box', [{ op: 'set', key: 'n', value: 1, ifVersion: 'absent' }], 'nodeRun_x');
    const again = await store.apply('wf_1', 'box', [{ op: 'set', key: 'n', value: 1, ifVersion: 'absent' }], 'nodeRun_x');
    expect(again).toEqual({ conflicts: [], alreadyApplied: true });
    expect(await store.get('wf_1', 'box', 'n')).toEqual({ value: 1, version: 1 });
  });

  it('serialises overlapping applies: two creates of one key, exactly one wins', async () => {
    const store = make();
    const [a, b] = await Promise.all([
      store.apply('wf_1', 'box', [{ op: 'set', key: 'k', value: 'a', ifVersion: 'absent' }], 'wa'),
      store.apply('wf_1', 'box', [{ op: 'set', key: 'k', value: 'b', ifVersion: 'absent' }], 'wb'),
    ]);
    expect([a.conflicts, b.conflicts].filter((c) => c.length)).toEqual([['k']]);
    expect((await store.get('wf_1', 'box', 'k'))?.version).toBe(1);
  });

  it('deletes', async () => {
    const store = make();
    await store.apply('wf_1', 'box', [{ op: 'set', key: 'k', value: 1 }], 'w1');
    await store.apply('wf_1', 'box', [{ op: 'delete', key: 'k', ifVersion: 1 }], 'w2');
    expect(await store.get('wf_1', 'box', 'k')).toBeUndefined();
  });
});

describe.each([
  ['files', () => new FileBlobStore(join(dir, 'blobs'), 1024)],
  ['memory', () => new InMemoryBlobStore(1024)],
] as [string, () => BlobStore][])('BlobStore contract: %s', (_name, make) => {
  it('is content-addressed: the key is the SHA-256 of the bytes', async () => {
    const store = make();
    const bytes = new TextEncoder().encode('# Report\n');
    const ref = await store.put(bytes, { mimeType: 'text/markdown', fileName: 'report.md' });
    expect(ref).toEqual({ key: createHash('sha256').update(bytes).digest('hex'), mimeType: 'text/markdown', size: 9, fileName: 'report.md' });
    const again = await store.put(bytes, { mimeType: 'text/markdown' });
    expect(again.key).toBe(ref.key);
    expect(new TextDecoder().decode(await store.get(ref))).toBe('# Report\n');
    expect(await store.stat(ref.key)).toEqual({ size: 9 });
  });

  it('refuses a file over the size cap', async () => {
    await expect(make().put(new Uint8Array(2048), { mimeType: 'application/octet-stream' })).rejects.toThrow(/at most/);
  });

  it('answers undefined for a key it does not hold', async () => {
    expect(await make().get('0'.repeat(64))).toBeUndefined();
  });
});
