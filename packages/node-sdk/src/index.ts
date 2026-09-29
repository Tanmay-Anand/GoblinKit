/**
 * @goblin/node-sdk — the API node authors write against.
 *
 * The one rule that shapes everything here: a manifest is data and an executor
 * is code, and they live in separate artifacts. The editor renders a node from
 * its manifest alone, so manifests can be fetched as JSON and a node pack can
 * be added to the palette without shipping a single server dependency to the
 * browser. It also means manifests are analysable — by docs, by validation, by
 * search, by a model generating a workflow — which none of it would be if the
 * description of a node were tangled up with the code that runs it.
 *
 * Nodes do not import HTTP clients, credential stores or databases. Everything
 * they can touch arrives on `ctx` (§12.2): the platform capabilities in this
 * package — `ctx.http`, credentials, `ctx.blobs`, `ctx.state` — are the only
 * way to those things, which is what lets the platform meter, redact and
 * govern them once instead of trusting every pack to.
 */

import type {
  ConfigField,
  CredentialRef,
  Envelope,
  Item,
  JsonObject,
  JsonValue,
  NodeManifest,
  PortId,
} from '@goblin/spec';
import { resolveValue, type ResolveContext } from '@goblin/expressions';

import { InMemoryBlobStore, type BlobStore } from './blobs.js';
import type { ResolvedCredential } from './credentials.js';
import { NodeFailure, type FailureOptions } from './failure.js';
import { createHttpClient, type MeteredHttpClient } from './http.js';
import { createScopedKV, type ScopedKV } from './state.js';

export type { NodeManifest, ConfigField };
export * from './failure.js';
export * from './http.js';
export * from './capabilities.js';
export * from './credentials.js';
export * from './blobs.js';
export * from './state.js';
export * from './harness.js';
// The shared function library, so a pack computes a median exactly as an
// expression does, without depending on the expression engine.
export * as fn from '@goblin/fn';

export function defineManifest(manifest: NodeManifest): NodeManifest {
  return manifest;
}

export interface Logger {
  debug(msg: string, data?: JsonValue): void;
  info(msg: string, data?: JsonValue): void;
  warn(msg: string, data?: JsonValue): void;
}

/** What an executor is handed. Everything ambient arrives through here (§12.2). */
export interface ExecutorContext {
  readonly nodeId: string;
  readonly scopePath: string;
  readonly attempt: number;
  /** Stable across retries of this step — forward it to providers that honour it. */
  readonly idempotencyKey: string;
  readonly input: Record<PortId, Envelope>;
  readonly items: readonly Item[];
  readonly config: JsonObject;
  /** The references picked in the box's settings. Resolve one with `credential()`. */
  readonly credentials: Record<string, CredentialRef>;
  readonly signal: AbortSignal;
  /** Redacted: the secrets this invocation resolved are scrubbed from every line. */
  readonly logger: Logger;
  readonly run: { readonly id: string; readonly workflowId: string };

  /** The metered HTTP client: timing, size cap, egress rule, credentials applied for you. */
  readonly http: MeteredHttpClient;
  /** Where files the box makes go; items carry only the reference. */
  readonly blobs: BlobStore;
  /** Small durable storage for this box in this workflow. Writes land only if the box succeeds. */
  readonly state: ScopedKV;

  /**
   * The credential picked for a slot, ready to hand to `http.request({ auth })`.
   * Undefined when the slot is empty. Throws a NodeFailure the run view can
   * explain when the credential is gone or needs signing in again.
   */
  credential(slot: string): Promise<ResolvedCredential | undefined>;
  /** Resolve `{{ }}` in the node's config against this invocation's context. */
  resolveConfig<T = JsonObject>(extra?: Partial<ResolveContext>): T;
  /** Build the result envelope for a port. */
  emit(port: PortId, items: Item[]): Record<PortId, Envelope>;
  /** A typed failure. `retryable: false` stops the engine wasting attempts. */
  fail(message: string, options?: FailureOptions): never;
}

export type ExecutorResult = Record<PortId, Envelope>;

/** What a person can do to a box in a finished run (manifest `actions`). */
export interface ActionContext {
  readonly runId: string;
  readonly workflowId: string;
  readonly nodeId: string;
  /** What reached the box in that run, as the journal recorded it. */
  readonly input: Record<PortId, Envelope>;
  /** What the box emitted in that run. */
  readonly outputs: Record<PortId, Envelope>;
  readonly config: JsonObject;
  /** Buffered like an executor's; applied with the same version checks. */
  readonly state: ScopedKV;
}

export type ActionHandler = (ctx: ActionContext) => Promise<{ message: string }> | { message: string };

export interface NodeDefinition {
  manifest: NodeManifest;
  execute: (ctx: ExecutorContext) => Promise<ExecutorResult> | ExecutorResult;
  /**
   * How to upgrade a box saved with an older version of this type: one entry
   * per older version, each returning config for this version (ADR-009).
   */
  migrateFrom?: Record<number, (config: JsonObject) => JsonObject>;
  /** Server-side handlers for the manifest's `actions`, by id. */
  actions?: Record<string, ActionHandler>;
}

export function defineExecutor(
  manifest: NodeManifest,
  execute: NodeDefinition['execute'],
  extra: Pick<NodeDefinition, 'migrateFrom' | 'actions'> = {},
): NodeDefinition {
  return { manifest, execute, ...extra };
}

/** Every `migrateFrom` in a set of packs, as the document loader wants them. */
export function nodeMigrations(
  nodes: readonly NodeDefinition[],
): { type: string; from: number; to: number; up: (c: JsonObject) => JsonObject }[] {
  return nodes.flatMap((n) =>
    Object.entries(n.migrateFrom ?? {}).map(([from, up]) => ({ type: n.manifest.type, from: Number(from), to: n.manifest.version, up })),
  );
}

/**
 * Build an executor context.
 *
 * The runtime hands over data; this assembles the conveniences an executor
 * expects, so that every node gets identical behaviour for expression
 * resolution, emission and failure instead of each one improvising. Services
 * a caller does not supply get a harmless local stand-in: a real HTTP client,
 * an in-memory blob store, state that is never committed.
 */
export function makeContext(args: {
  nodeId: string;
  scopePath: string;
  attempt: number;
  idempotencyKey: string;
  input: Record<PortId, Envelope>;
  config: JsonObject;
  credentials: Record<string, CredentialRef>;
  signal: AbortSignal;
  /** The box's manifest: a setting left unset means its declared default. */
  manifest?: NodeManifest;
  variables?: Record<string, JsonValue>;
  nodeOutputs?: Record<string, JsonValue>;
  logger?: Logger;
  run?: { id: string; workflowId: string };
  http?: MeteredHttpClient;
  blobs?: BlobStore;
  state?: ScopedKV;
  credential?: (slot: string) => Promise<ResolvedCredential | undefined>;
}): ExecutorContext {
  const items = args.input['main']?.items ?? [];
  const noop = () => {};
  const logger = args.logger ?? { debug: noop, info: noop, warn: noop };
  const run = args.run ?? { id: 'local', workflowId: 'local' };
  const config = args.manifest ? withDefaults(args.manifest, args.config) : args.config;

  return {
    nodeId: args.nodeId,
    scopePath: args.scopePath,
    attempt: args.attempt,
    idempotencyKey: args.idempotencyKey,
    input: args.input,
    items,
    config,
    credentials: args.credentials,
    signal: args.signal,
    logger,
    run,
    http: args.http ?? createHttpClient(),
    blobs: args.blobs ?? new InMemoryBlobStore(),
    state: args.state ?? createScopedKV({ workflowId: run.workflowId, nodeId: args.nodeId }),

    async credential(slot: string): Promise<ResolvedCredential | undefined> {
      if (!args.credentials[slot]) return undefined;
      if (!args.credential) {
        throw new NodeFailure('Credentials are not available where this box is running.', { code: 'NO_CREDENTIALS', errorClass: 'permanent' });
      }
      return args.credential(slot);
    },

    resolveConfig<T = JsonObject>(extra?: Partial<ResolveContext>): T {
      const ctx: ResolveContext = {
        json: items[0]?.data ?? null,
        items: items.map((i) => i.data),
        vars: args.variables ?? {},
        nodes: args.nodeOutputs ?? {},
        run: { scopePath: args.scopePath, attempt: args.attempt },
        ...extra,
      };
      return resolveValue(config as JsonValue, ctx) as T;
    },

    emit(port: PortId, emitted: Item[]): Record<PortId, Envelope> {
      return {
        [port]: {
          items: emitted,
          meta: { node: args.nodeId, port, scopePath: args.scopePath, emittedAt: 0 },
        },
      };
    },

    fail(message: string, options?: FailureOptions): never {
      throw new NodeFailure(message, options);
    },
  };
}

/**
 * The box's settings with every unset field at its declared default — what
 * the settings panel shows is what the box gets.
 */
export function withDefaults(manifest: NodeManifest, config: JsonObject): JsonObject {
  const out: JsonObject = { ...config };
  for (const field of manifest.config?.fields ?? []) {
    if (out[field.name] === undefined && field.default !== undefined) out[field.name] = field.default;
  }
  return out;
}

/**
 * Run one box by itself, for a quick test. For HTTP mocks, credentials and
 * state, use `createNodeHarness` (harness.ts).
 */
export async function runNode(
  definition: NodeDefinition,
  args: {
    config?: JsonObject;
    items?: Item[];
    input?: Record<PortId, Envelope>;
    variables?: Record<string, JsonValue>;
    credentials?: Record<string, CredentialRef>;
  } = {},
): Promise<ExecutorResult> {
  const input: Record<PortId, Envelope> = args.input ?? { main: { items: args.items ?? [] } };

  const ctx = makeContext({
    nodeId: 'test',
    scopePath: '',
    attempt: 1,
    idempotencyKey: 'test-key',
    input,
    config: args.config ?? {},
    credentials: args.credentials ?? {},
    signal: new AbortController().signal,
    manifest: definition.manifest,
    ...(args.variables ? { variables: args.variables } : {}),
  });
  return definition.execute(ctx);
}
