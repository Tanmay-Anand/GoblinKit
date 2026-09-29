import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { InMemoryCredentialStore, type CredentialStore } from '@goblin/node-sdk';
import { coreCredentialResolvers, coreManifests, coreNodes } from '@goblin/nodes-core';
import { MapRegistry } from '@goblin/spec';

import { MemoryAuditLog } from '../src/audit.js';
import { defaultKeyPath, FileCredentialStore, KeyError, LocalKeyProvider } from '../src/credentials.js';
import { createApi } from '../src/server.js';
import { FileActivationStore, FileRunStore, FileWorkflowStore } from '../src/stores.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'goblin-creds-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const fileStore = () => new FileCredentialStore(join(dir, 'workspace', 'credentials.enc.json'), new LocalKeyProvider(join(dir, 'profile', 'master.key')));

/**
 * The contract every CredentialStore keeps. The encrypted file store and its
 * in-memory twin both pass it, and Stage 8's KMS-backed store will have to.
 */
describe.each([
  ['encrypted file', fileStore],
  ['in memory', () => new InMemoryCredentialStore()],
] as [string, () => CredentialStore][])('CredentialStore contract: %s', (_name, make) => {
  it('round-trips values, and lists only metadata', async () => {
    const store = make();
    const meta = await store.create({ type: 'http.bearerToken', name: 'Dev API', values: { token: 'sk-12345678' } });
    expect(meta).toMatchObject({ type: 'http.bearerToken', name: 'Dev API', status: 'ok', fields: ['token'] });
    expect(await store.values(meta.id)).toEqual({ token: 'sk-12345678' });
    const listed = await store.list();
    expect(JSON.stringify(listed)).not.toContain('sk-12345678');
    expect(listed.map((c) => c.id)).toEqual([meta.id]);
  });

  it('replace swaps every value, moves the revision on, and clears "needs sign-in"', async () => {
    const store = make();
    const meta = await store.create({ type: 'http.bearerToken', name: 'Dev', values: { token: 'old-token' } });
    await store.setStatus(meta.id, 'needs_reauth', 'revoked');
    expect((await store.get(meta.id))?.status).toBe('needs_reauth');
    const replaced = await store.replace(meta.id, { values: { token: 'new-token' } });
    expect(replaced.updatedAt > meta.updatedAt).toBe(true);
    expect(replaced.status).toBe('ok');
    expect(replaced.statusMessage).toBeUndefined();
    expect(await store.values(meta.id)).toEqual({ token: 'new-token' });
  });

  it('deletes', async () => {
    const store = make();
    const meta = await store.create({ type: 'http.bearerToken', name: 'Dev', values: { token: 'x-token-1' } });
    expect(await store.delete(meta.id)).toBe(true);
    expect(await store.get(meta.id)).toBeUndefined();
    expect(await store.delete(meta.id)).toBe(false);
  });
});

describe('the encrypted file store', () => {
  it('writes ciphertext only: no value is readable in the workspace file', async () => {
    const store = fileStore();
    await store.create({ type: 'http.basicAuth', name: 'Staging', values: { username: 'ada', password: 'correct horse battery' } });
    const text = await readFile(join(dir, 'workspace', 'credentials.enc.json'), 'utf8');
    expect(text).not.toContain('correct horse battery');
    expect(text).not.toContain('"ada"');
  });

  it('cannot be read with a different key — the profile key was lost', async () => {
    const meta = await fileStore().create({ type: 'http.bearerToken', name: 'Dev', values: { token: 'sk-lost' } });
    const other = new FileCredentialStore(join(dir, 'workspace', 'credentials.enc.json'), new LocalKeyProvider(join(dir, 'other-profile', 'master.key')));
    await expect(other.values(meta.id)).rejects.toThrow(/saved with a different key/);
  });

  it('binds each value to its record and field: a copied ciphertext does not decrypt', async () => {
    const store = fileStore();
    const a = await store.create({ type: 'http.basicAuth', name: 'A', values: { username: 'alice', password: 'alice-secret' } });
    const path = join(dir, 'workspace', 'credentials.enc.json');
    const file = JSON.parse(await readFile(path, 'utf8'));
    // Swap the two fields of one record: same DEK, same record, different field.
    const record = file.records[a.id];
    [record.values.username, record.values.password] = [record.values.password, record.values.username];
    await writeFile(path, JSON.stringify(file));
    await expect(fileStore().values(a.id)).rejects.toThrow(/does not belong to it/);
  });

  it('a whole record moved under another id does not decrypt either', async () => {
    const store = fileStore();
    const a = await store.create({ type: 'http.bearerToken', name: 'A', values: { token: 'token-of-a' } });
    const b = await store.create({ type: 'http.bearerToken', name: 'B', values: { token: 'token-of-b' } });
    const path = join(dir, 'workspace', 'credentials.enc.json');
    const file = JSON.parse(await readFile(path, 'utf8'));
    file.records[b.id] = { ...file.records[a.id], id: b.id };
    await writeFile(path, JSON.stringify(file));
    await expect(fileStore().values(b.id)).rejects.toThrow(KeyError);
  });

  it('makes the key on first use, and keeps it', async () => {
    const keyPath = join(dir, 'profile', 'master.key');
    const store = fileStore();
    const meta = await store.create({ type: 'http.bearerToken', name: 'Dev', values: { token: 'sk-kept' } });
    const key = await readFile(keyPath, 'utf8');
    expect(Buffer.from(key.trim(), 'base64')).toHaveLength(32);
    expect(await fileStore().values(meta.id)).toEqual({ token: 'sk-kept' });
  });
});

describe('where the key lives', () => {
  it('in the profile folder, never under the workspace', () => {
    expect(defaultKeyPath({ APPDATA: 'C:\\Users\\ada\\AppData\\Roaming' }, 'win32')).toBe(join('C:\\Users\\ada\\AppData\\Roaming', 'GoblinKit', 'master.key'));
    expect(defaultKeyPath({ XDG_CONFIG_HOME: '/home/ada/.config' }, 'linux')).toBe(join('/home/ada/.config', 'goblinkit', 'master.key'));
  });

  it('refuses a key path inside the workspace or the repo', () => {
    const workspace = join(dir, 'workspace');
    expect(() => new LocalKeyProvider(join(workspace, 'master.key'), [workspace])).toThrow(/must not live inside/);
    expect(() => new LocalKeyProvider(join(workspace, 'sub', 'k'), [workspace])).toThrow(KeyError);
    expect(() => new LocalKeyProvider(join(dir, 'profile', 'master.key'), [workspace])).not.toThrow();
  });
});

describe('the credentials API', () => {
  async function start() {
    const audit = new MemoryAuditLog();
    const { server, credentials } = createApi({
      workflows: new FileWorkflowStore(join(dir, 'workflows')),
      runs: new FileRunStore(join(dir, 'runs')),
      activations: new FileActivationStore(join(dir, 'activations.json')),
      registry: new MapRegistry(coreManifests),
      manifests: coreManifests,
      nodes: coreNodes,
      credentials: fileStore(),
      credentialTypes: coreCredentialResolvers,
      audit,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`${base}${path}`, {
        method,
        ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
      });
      return { status: res.status, text: await res.text() };
    };
    return { server, call, audit, credentials };
  }

  it('takes values in, and never sends one back — not on create, list, get or replace', async () => {
    const { server, call, audit } = await start();
    try {
      const created = await call('POST', '/credentials', { type: 'http.headerKey', name: 'Dev key', values: { value: 'key-abcdef-123' } });
      expect(created.status).toBe(201);
      expect(created.text).not.toContain('key-abcdef-123');
      const meta = JSON.parse(created.text);
      // The default header name filled itself in.
      expect(meta.fields).toEqual(['header', 'value']);

      const listed = await call('GET', '/credentials');
      expect(listed.text).not.toContain('key-abcdef-123');

      const replaced = await call('PUT', `/credentials/${meta.id}`, { values: { header: 'x-key', value: 'key-zyxw-987' } });
      expect(replaced.status).toBe(200);
      expect(replaced.text).not.toContain('key-zyxw-987');

      expect((await call('DELETE', `/credentials/${meta.id}`)).status).toBe(200);
      expect(audit.events.map((e) => e.action)).toEqual(['credential.created', 'credential.replaced', 'credential.deleted']);
      expect(JSON.stringify(audit.events)).not.toContain('key-');
    } finally {
      server.close();
    }
  });

  it('refuses a credential that is missing a required value, or has fields its type does not', async () => {
    const { server, call } = await start();
    try {
      const error = async (body: unknown) => (JSON.parse((await call('POST', '/credentials', body)).text) as { error: string }).error;
      expect(await error({ type: 'http.bearerToken', name: 'x', values: {} })).toBe('Token is needed.');
      expect(await error({ type: 'http.bearerToken', name: 'x', values: { token: 't', extra: 'y' } })).toBe('Bearer token has no field "extra".');
      expect((await call('POST', '/credentials', { type: 'nope.type', name: 'x', values: {} })).status).toBe(400);
    } finally {
      server.close();
    }
  });

  it('lists the credential types the packs ship', async () => {
    const { server, call } = await start();
    try {
      const types = JSON.parse((await call('GET', '/credential-types')).text) as { type: string }[];
      expect(types.map((t) => t.type)).toEqual(['http.bearerToken', 'http.headerKey', 'http.basicAuth', 'http.queryKey']);
    } finally {
      server.close();
    }
  });
});
