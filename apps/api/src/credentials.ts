/**
 * Credentials at rest: encrypted on disk, the key kept somewhere else (§14.1).
 *
 * Envelope encryption, the shape Stage 8's KMS keeps:
 *
 *  - Each credential record gets its own random data key (DEK). Each value is
 *    encrypted with it — AES-256-GCM, a fresh random IV per value.
 *  - The DEK is stored *wrapped*: encrypted by a master key the KeyProvider
 *    holds. Stage 8 swaps the provider for KMS; nothing else changes.
 *  - Every encryption carries associated data — tenant, credential id and
 *    field name — so a ciphertext copied into another record, or another
 *    field of the same record, fails to decrypt instead of quietly becoming
 *    that credential's password.
 *
 * Where the master key lives is the point. Never in `workspace/` and never
 * in the repo: a workspace folder that is copied, synced or committed then
 * carries only ciphertext. It lives in the user's profile directory, and if
 * it is lost, the credentials must be entered again (the screen says so).
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';

import { newCredentialId, setFields, type CredentialMeta, type CredentialStatus, type CredentialStore } from '@goblin/node-sdk';

import { LOCAL_TENANT } from './protocol.js';
import { StoreError, writeJson } from './stores.js';

/** Holds the master key, and only ever wraps and unwraps data keys with it. */
export interface KeyProvider {
  wrap(dek: Buffer, aad: string): Promise<string>;
  unwrap(wrapped: string, aad: string): Promise<Buffer>;
}

/** %APPDATA%\GoblinKit\master.key on Windows; ~/.config/goblinkit/master.key elsewhere. */
export function defaultKeyPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return join(env['APPDATA'] ?? join(homedir(), 'AppData', 'Roaming'), 'GoblinKit', 'master.key');
  return join(env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config'), 'goblinkit', 'master.key');
}

export class KeyError extends Error {
  override readonly name = 'KeyError';
}

/**
 * The local KeyProvider: a 256-bit key in a file in the profile directory,
 * made on first use with owner-only permissions. (On Windows, %APPDATA% is
 * already private to the account; DPAPI or the OS keychain arrive behind
 * this same port in Stage 8.)
 */
export class LocalKeyProvider implements KeyProvider {
  private key: Promise<Buffer> | undefined;

  constructor(
    private readonly path: string,
    /** Folders the key must never be inside — the workspace, the repo. */
    forbidden: string[] = [],
  ) {
    for (const root of forbidden) {
      const rel = relative(resolve(root), resolve(path));
      if (!rel.startsWith('..') && !isAbsolute(rel)) {
        throw new KeyError(`The credentials key must not live inside ${root}: anything copied from there would carry it. Use a path outside it.`);
      }
    }
  }

  get location(): string {
    return this.path;
  }

  private load(): Promise<Buffer> {
    this.key ??= (async () => {
      try {
        const text = (await readFile(this.path, 'utf8')).trim();
        const key = Buffer.from(text, 'base64');
        if (key.length !== 32) throw new KeyError(`${this.path} is not a GoblinKit key.`);
        return key;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const key = randomBytes(32);
        await mkdir(dirname(this.path), { recursive: true });
        // 'wx': never overwrite a key another process made a moment ago.
        try {
          await writeFile(this.path, `${key.toString('base64')}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        } catch (raced) {
          if ((raced as NodeJS.ErrnoException).code === 'EEXIST') {
            this.key = undefined;
            return this.load();
          }
          throw raced;
        }
        await chmod(this.path, 0o600).catch(() => {});
        return key;
      }
    })();
    return this.key;
  }

  async wrap(dek: Buffer, aad: string): Promise<string> {
    return seal(await this.load(), dek, aad);
  }

  async unwrap(wrapped: string, aad: string): Promise<Buffer> {
    try {
      return open(await this.load(), wrapped, aad);
    } catch (error) {
      if (error instanceof KeyError) throw error;
      throw new KeyError('This credential was saved with a different key — the key file in your profile folder was lost or replaced. Enter the credential again.');
    }
  }
}

/** AES-256-GCM: "v1.<iv>.<tag>.<ciphertext>", base64url parts. */
function seal(key: Buffer, plain: Buffer, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

function open(key: Buffer, sealed: string, aad: string): Buffer {
  const [version, iv, tag, ct] = sealed.split('.');
  if (version !== 'v1' || !iv || !tag || ct === undefined) throw new Error('Not a sealed value.');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]);
}

/** Tenant ‖ credential ‖ field: what a ciphertext is bound to. */
const aadFor = (tenant: string, id: string, field: string) => `${tenant}\u0000${id}\u0000${field}`;
const DEK_FIELD = '#dek';

interface StoredRecord {
  id: string;
  tenantId: string;
  type: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  status: CredentialStatus;
  statusMessage?: string;
  dek: string;
  values: Record<string, string>;
}

interface StoredFile {
  version: 1;
  records: Record<string, StoredRecord>;
}

/**
 * `workspace/credentials.enc.json`: ciphertext and wrapped keys, nothing
 * readable. Writes are serialised in this process and land atomically.
 */
export class FileCredentialStore implements CredentialStore {
  private queue: Promise<unknown> = Promise.resolve();
  private tick = 0;

  constructor(
    private readonly path: string,
    private readonly keys: KeyProvider,
    private readonly tenantId = LOCAL_TENANT,
  ) {}

  private async read(): Promise<StoredFile> {
    try {
      return JSON.parse(await readFile(this.path, 'utf8')) as StoredFile;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, records: {} };
      throw error;
    }
  }

  /** One change at a time, read-modify-write, so two saves cannot lose each other. */
  private change<T>(fn: (file: StoredFile) => Promise<T>): Promise<T> {
    const next = this.queue.then(async () => {
      const file = await this.read();
      const result = await fn(file);
      await mkdir(dirname(this.path), { recursive: true });
      await writeJson(this.path, file);
      return result;
    });
    this.queue = next.catch(() => {});
    return next;
  }

  private stamp(): string {
    const at = Math.max(Date.now(), this.tick + 1);
    this.tick = at;
    return new Date(at).toISOString();
  }

  private async encrypt(id: string, values: Record<string, string>): Promise<{ dek: string; values: Record<string, string> }> {
    const dek = randomBytes(32);
    const sealed: Record<string, string> = {};
    for (const [field, value] of Object.entries(values)) {
      if (value === '') continue;
      sealed[field] = seal(dek, Buffer.from(value, 'utf8'), aadFor(this.tenantId, id, field));
    }
    return { dek: await this.keys.wrap(dek, aadFor(this.tenantId, id, DEK_FIELD)), values: sealed };
  }

  async list(): Promise<CredentialMeta[]> {
    await this.queue;
    return Object.values((await this.read()).records)
      .map(toMeta)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(id: string): Promise<CredentialMeta | undefined> {
    await this.queue;
    const record = (await this.read()).records[id];
    return record ? toMeta(record) : undefined;
  }

  async create(input: { type: string; name: string; values: Record<string, string> }): Promise<CredentialMeta> {
    const id = newCredentialId();
    const sealed = await this.encrypt(id, input.values);
    return this.change(async (file) => {
      const now = this.stamp();
      const record: StoredRecord = { id, tenantId: this.tenantId, type: input.type, name: input.name, createdAt: now, updatedAt: now, status: 'ok', ...sealed };
      file.records[id] = record;
      return toMeta(record);
    });
  }

  async replace(id: string, input: { name?: string; values?: Record<string, string> }): Promise<CredentialMeta> {
    // A new DEK with new values: nothing of the old secret survives in the file.
    const sealed = input.values ? await this.encrypt(id, input.values) : undefined;
    return this.change(async (file) => {
      const record = file.records[id];
      if (!record) throw new StoreError('That credential does not exist.');
      if (input.name) record.name = input.name;
      if (sealed) {
        record.dek = sealed.dek;
        record.values = sealed.values;
        record.status = 'ok';
        delete record.statusMessage;
      }
      record.updatedAt = this.stamp();
      return toMeta(record);
    });
  }

  async delete(id: string): Promise<boolean> {
    return this.change(async (file) => {
      if (!file.records[id]) return false;
      delete file.records[id];
      return true;
    });
  }

  async values(id: string): Promise<Record<string, string>> {
    await this.queue;
    const record = (await this.read()).records[id];
    if (!record) throw new StoreError('That credential does not exist.');
    // The record's own tenant and id are what the ciphertext is bound to. A
    // record moved under another id fails here, which is the point.
    const dek = await this.keys.unwrap(record.dek, aadFor(this.tenantId, id, DEK_FIELD));
    const out: Record<string, string> = {};
    for (const [field, sealed] of Object.entries(record.values)) {
      try {
        out[field] = open(dek, sealed, aadFor(this.tenantId, id, field)).toString('utf8');
      } catch {
        throw new KeyError(`The stored value for "${field}" of “${record.name}” does not belong to it and cannot be read. Enter the credential again.`);
      }
    }
    return out;
  }

  async setStatus(id: string, status: CredentialStatus, message?: string): Promise<void> {
    await this.change(async (file) => {
      const record = file.records[id];
      if (!record) return;
      record.status = status;
      if (message) record.statusMessage = message;
      else delete record.statusMessage;
    });
  }
}

function toMeta(r: StoredRecord): CredentialMeta {
  return {
    id: r.id,
    type: r.type,
    name: r.name,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    status: r.status,
    ...(r.statusMessage ? { statusMessage: r.statusMessage } : {}),
    fields: setFields(r.values),
  };
}
