/**
 * Credentials: types, the store port, and the runtime that resolves them (§14).
 *
 * The same split as a box. A credential *type* is data — which fields to ask
 * for, which are secret, which capabilities it provides — and can go to the
 * browser. Its *resolver* is code that turns stored values into something
 * usable (a header, a signer, a freshly minted token) and runs only on the
 * server, at the moment a box needs it.
 *
 * Everything between those two is shared, because it is where credential
 * bugs live: caching until expiry, refreshing once when ten boxes ask at the
 * same moment (§14.3's single-flight), forgetting a cached token the instant
 * its credential is replaced, and marking a credential "needs sign-in" when
 * the provider says the refresh token is dead instead of retrying forever.
 */

import type { CredentialRef, CredentialTypeManifest } from '@goblin/spec';

import { coreCapabilities, type Capability } from './capabilities.js';
import { NodeFailure } from './failure.js';
import type { MeteredHttpClient } from './http.js';

export function defineCredentialType(manifest: CredentialTypeManifest): CredentialTypeManifest {
  return manifest;
}

export interface ResolverContext {
  /** The metered client: a resolver calling a token endpoint is governed like any box. */
  readonly http: MeteredHttpClient;
  readonly signal: AbortSignal;
  readonly logger: { info(msg: string): void; warn(msg: string): void };
  /** Epoch milliseconds, for turning "expires in 3600 s" into `expiresAt`. */
  now(): number;
}

export interface Resolved {
  /** Must satisfy every capability the type provides. */
  value: unknown;
  /** Epoch ms. The runtime refreshes a little before this. Absent: never expires. */
  expiresAt?: number;
  /** Values derived from the secret — a minted token — to scrub from logs too. */
  secrets?: string[];
}

export type CredentialResolver = (values: Readonly<Record<string, string>>, rctx: ResolverContext) => Promise<Resolved> | Resolved;

export interface CredentialTypeDefinition {
  manifest: CredentialTypeManifest;
  resolve: CredentialResolver;
}

/** A credential type's server half. Never imported by browser code. */
export function defineCredentialResolver(manifest: CredentialTypeManifest, resolve: CredentialResolver): CredentialTypeDefinition {
  return { manifest, resolve };
}

/**
 * Thrown by a resolver when the provider refused the stored secret itself —
 * a revoked refresh token, a wrong password. Not a network blip: retrying
 * cannot help, and the person has to sign in again.
 */
export class CredentialAuthError extends Error {
  override readonly name = 'CredentialAuthError';
}

/* ------------------------------------------------------------------ store */

export type CredentialStatus = 'ok' | 'needs_reauth';

/** Everything about a credential except its values, which never leave the store. */
export interface CredentialMeta {
  id: string;
  type: string;
  name: string;
  createdAt: string;
  /** Changes whenever the values do; the runtime's cache is keyed on it. */
  updatedAt: string;
  status: CredentialStatus;
  statusMessage?: string;
  /** Names of the fields that hold a value. Never the values. */
  fields: string[];
}

export interface CredentialStore {
  list(): Promise<CredentialMeta[]>;
  get(id: string): Promise<CredentialMeta | undefined>;
  create(input: { type: string; name: string; values: Record<string, string> }): Promise<CredentialMeta>;
  /** New values replace all the old ones, and reset the status to ok. */
  replace(id: string, input: { name?: string; values?: Record<string, string> }): Promise<CredentialMeta>;
  delete(id: string): Promise<boolean>;
  /** Decrypted values. Server-side only, for the runtime. */
  values(id: string): Promise<Record<string, string>>;
  setStatus(id: string, status: CredentialStatus, message?: string): Promise<void>;
}

export function newCredentialId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return `cred_${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * The in-memory twin of the encrypted file store: same port, same contract
 * tests, no disk. For tests and the node harness.
 */
export class InMemoryCredentialStore implements CredentialStore {
  private readonly records = new Map<string, { meta: CredentialMeta; values: Record<string, string> }>();
  private tick = 0;

  // A strictly increasing stamp, so two changes in one millisecond still
  // count as two for the runtime's cache.
  private stamp(): string {
    const at = Math.max(Date.now(), this.tick + 1);
    this.tick = at;
    return new Date(at).toISOString();
  }

  async list(): Promise<CredentialMeta[]> {
    return [...this.records.values()].map((r) => ({ ...r.meta }));
  }

  async get(id: string): Promise<CredentialMeta | undefined> {
    const r = this.records.get(id);
    return r ? { ...r.meta } : undefined;
  }

  async create(input: { type: string; name: string; values: Record<string, string> }): Promise<CredentialMeta> {
    const now = this.stamp();
    const meta: CredentialMeta = { id: newCredentialId(), type: input.type, name: input.name, createdAt: now, updatedAt: now, status: 'ok', fields: setFields(input.values) };
    this.records.set(meta.id, { meta, values: { ...input.values } });
    return { ...meta };
  }

  async replace(id: string, input: { name?: string; values?: Record<string, string> }): Promise<CredentialMeta> {
    const r = this.records.get(id);
    if (!r) throw new Error('That credential does not exist.');
    const meta: CredentialMeta = { ...r.meta, updatedAt: this.stamp() };
    if (input.name) meta.name = input.name;
    if (input.values) {
      // New values are a fresh start: whatever was wrong with the old ones is gone.
      meta.status = 'ok';
      delete meta.statusMessage;
      meta.fields = setFields(input.values);
    }
    this.records.set(id, { meta, values: input.values ? { ...input.values } : r.values });
    return { ...meta };
  }

  async delete(id: string): Promise<boolean> {
    return this.records.delete(id);
  }

  async values(id: string): Promise<Record<string, string>> {
    const r = this.records.get(id);
    if (!r) throw new Error('That credential does not exist.');
    return { ...r.values };
  }

  async setStatus(id: string, status: CredentialStatus, message?: string): Promise<void> {
    const r = this.records.get(id);
    if (!r) return;
    const { statusMessage: _old, ...rest } = r.meta;
    r.meta = { ...rest, status, ...(message ? { statusMessage: message } : {}) };
  }
}

export const setFields = (values: Record<string, string>) => Object.keys(values).filter((k) => values[k] !== '').sort();

/* ---------------------------------------------------------------- runtime */

export interface ResolvedCredential {
  credentialId: string;
  type: string;
  /** Which of the box's accepted capabilities this credential is being used as. */
  capability: string;
  value: unknown;
}

export interface CredentialProvider {
  /** Resolve for a box slot that accepts these capabilities. Throws NodeFailure. */
  resolve(ref: CredentialRef, options: { accepts: readonly string[]; signal: AbortSignal }): Promise<ResolvedCredential & { secrets: readonly string[] }>;
}

interface CacheEntry {
  revision: string;
  value: unknown;
  expiresAt?: number;
  secrets: string[];
}

export class CredentialRuntime implements CredentialProvider {
  private readonly types: Map<string, CredentialTypeDefinition>;
  private readonly capabilities: Map<string, Capability>;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<CacheEntry>>();
  private readonly now: () => number;
  private readonly skewMs: number;

  constructor(
    private readonly deps: {
      store: CredentialStore;
      types: CredentialTypeDefinition[];
      http: MeteredHttpClient;
      /** Pack-defined capabilities, alongside the kit's own. */
      capabilities?: Capability[];
      now?: () => number;
      /** Refresh this long before a token says it expires. Default 60 s. */
      skewMs?: number;
      logger?: ResolverContext['logger'];
    },
  ) {
    this.types = new Map(deps.types.map((t) => [t.manifest.type, t]));
    this.capabilities = new Map([...coreCapabilities, ...(deps.capabilities ?? [])].map((c) => [c.id, c]));
    this.now = deps.now ?? Date.now;
    this.skewMs = deps.skewMs ?? 60_000;
  }

  /** Forget the cached value: called when a credential is replaced or deleted. */
  invalidate(id: string): void {
    this.cache.delete(id);
    this.inflight.delete(id);
  }

  async resolve(ref: CredentialRef, options: { accepts: readonly string[]; signal: AbortSignal }): Promise<ResolvedCredential & { secrets: readonly string[] }> {
    const meta = await this.deps.store.get(ref.id);
    if (!meta) {
      throw new NodeFailure('The credential this box uses no longer exists. Pick another one in its settings.', {
        code: 'CREDENTIAL_MISSING',
        errorClass: 'validation',
      });
    }
    const definition = this.types.get(meta.type);
    if (!definition) {
      throw new NodeFailure(`“${meta.name}” is a ${meta.type} credential, and no installed pack knows that type.`, {
        code: 'CREDENTIAL_TYPE_UNKNOWN',
        errorClass: 'validation',
      });
    }
    const capability = options.accepts.find((c) => definition.manifest.provides.includes(c));
    if (!capability) {
      throw new NodeFailure(`“${meta.name}” (${definition.manifest.title}) cannot be used by this box. Pick a credential it accepts.`, {
        code: 'CREDENTIAL_WRONG_TYPE',
        errorClass: 'validation',
      });
    }
    if (meta.status === 'needs_reauth') throw this.needsReauth(meta, meta.statusMessage);

    const entry = await this.entry(meta, definition, options.signal);
    return { credentialId: meta.id, type: meta.type, capability, value: entry.value, secrets: entry.secrets };
  }

  private async entry(meta: CredentialMeta, definition: CredentialTypeDefinition, signal: AbortSignal): Promise<CacheEntry> {
    const cached = this.cache.get(meta.id);
    if (cached && cached.revision === meta.updatedAt && (cached.expiresAt === undefined || this.now() < cached.expiresAt - this.skewMs)) {
      return cached;
    }
    // Single-flight: everyone who asks while a refresh is under way waits for
    // that one refresh. Two refreshes racing can invalidate each other's
    // token with some providers — the classic mystery failure (§14.3).
    const key = `${meta.id}@${meta.updatedAt}`;
    const running = this.inflight.get(key);
    if (running) return running;
    const task = this.load(meta, definition, signal).finally(() => this.inflight.delete(key));
    this.inflight.set(key, task);
    return task;
  }

  private async load(meta: CredentialMeta, definition: CredentialTypeDefinition, signal: AbortSignal): Promise<CacheEntry> {
    const values = await this.deps.store.values(meta.id);
    let resolved: Resolved;
    try {
      resolved = await definition.resolve(values, {
        http: this.deps.http,
        signal,
        logger: this.deps.logger ?? { info: () => {}, warn: () => {} },
        now: this.now,
      });
    } catch (error) {
      if (error instanceof CredentialAuthError) {
        await this.deps.store.setStatus(meta.id, 'needs_reauth', error.message);
        this.invalidate(meta.id);
        throw this.needsReauth(meta, error.message);
      }
      if (error instanceof NodeFailure) throw error;
      throw new NodeFailure(`Could not use “${meta.name}”: ${error instanceof Error ? error.message : String(error)}`, {
        code: 'CREDENTIAL_RESOLVE',
        errorClass: 'transient',
      });
    }

    const problems = checkResolved(definition.manifest.provides, resolved.value, this.capabilities);
    if (problems.length) {
      throw new NodeFailure(`The ${definition.manifest.type} pack returned a value that does not fit what it promises: ${problems.join('; ')}.`, {
        code: 'CREDENTIAL_BAD_OUTPUT',
        errorClass: 'permanent',
      });
    }

    const secretFields = definition.manifest.fields.filter((f) => f.secret).map((f) => values[f.name] ?? '');
    const entry: CacheEntry = {
      revision: meta.updatedAt,
      value: resolved.value,
      ...(resolved.expiresAt !== undefined ? { expiresAt: resolved.expiresAt } : {}),
      secrets: [...secretFields, ...(resolved.secrets ?? []), ...derivedSecrets(resolved.value)].filter((s) => s.length > 0),
    };
    // Only cache what is still current: a replace during the resolve wins.
    const latest = await this.deps.store.get(meta.id);
    if (latest?.updatedAt === meta.updatedAt) this.cache.set(meta.id, entry);
    return entry;
  }

  private needsReauth(meta: CredentialMeta, why?: string): NodeFailure {
    return new NodeFailure(
      `“${meta.name}” needs signing in again${why ? ` (${why})` : ''}. Replace its values on the Credentials screen.`,
      { code: 'NEEDS_REAUTH', errorClass: 'auth' },
    );
  }
}

/** A resolved value, checked against every capability its type claims (the contract suite uses this too). */
export function checkResolved(provides: readonly string[], value: unknown, capabilities: ReadonlyMap<string, Capability>): string[] {
  const problems: string[] = [];
  for (const id of provides) {
    const capability = capabilities.get(id);
    if (!capability) {
      problems.push(`${id} is not a registered capability`);
      continue;
    }
    for (const p of capability.check(value)) problems.push(`${id} ${p}`);
  }
  return problems;
}

/** Header values carry tokens: scrub the whole value and each long word in it ("Bearer <token>"). */
function derivedSecrets(value: unknown): string[] {
  const headers = (value as { headers?: unknown } | null)?.headers;
  if (!headers || typeof headers !== 'object') return [];
  const out: string[] = [];
  for (const v of Object.values(headers as Record<string, unknown>)) {
    if (typeof v !== 'string') continue;
    out.push(v);
    for (const part of v.split(/\s+/)) if (part.length >= 8) out.push(part);
  }
  return out;
}
