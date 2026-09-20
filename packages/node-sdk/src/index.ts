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

export type { NodeManifest, ConfigField };

export function defineManifest(manifest: NodeManifest): NodeManifest {
  return manifest;
}

/** What an executor is handed. Everything ambient arrives through here. */
export interface ExecutorContext {
  readonly nodeId: string;
  readonly scopePath: string;
  readonly attempt: number;
  /** Stable across retries of this step — forward it to providers that honour it. */
  readonly idempotencyKey: string;
  readonly input: Record<PortId, Envelope>;
  readonly items: readonly Item[];
  readonly config: JsonObject;
  readonly credentials: Record<string, CredentialRef>;
  readonly signal: AbortSignal;
  readonly logger: { debug(msg: string, data?: JsonValue): void; info(msg: string, data?: JsonValue): void; warn(msg: string, data?: JsonValue): void };

  /** Resolve `{{ }}` in the node's config against this invocation's context. */
  resolveConfig<T = JsonObject>(extra?: Partial<ResolveContext>): T;
  /** Build the result envelope for a port. */
  emit(port: PortId, items: Item[]): Record<PortId, Envelope>;
  /** A typed failure. `retryable: false` stops the engine wasting attempts. */
  fail(message: string, options?: { code?: string; retryable?: boolean }): never;
}

export type ExecutorResult = Record<PortId, Envelope>;

export interface NodeDefinition {
  manifest: NodeManifest;
  execute: (ctx: ExecutorContext) => Promise<ExecutorResult> | ExecutorResult;
}

export function defineExecutor(
  manifest: NodeManifest,
  execute: NodeDefinition['execute'],
): NodeDefinition {
  return { manifest, execute };
}

export class NodeFailure extends Error {
  readonly code: string | undefined;
  readonly retryable: boolean;

  constructor(message: string, options?: { code?: string; retryable?: boolean }) {
    super(message);
    this.name = 'NodeFailure';
    this.code = options?.code;
    // Retryable by default: most failures at this boundary are network or
    // rate-limit shaped, and a node author who knows better says so explicitly.
    this.retryable = options?.retryable ?? true;
  }
}

/**
 * Build an executor context.
 *
 * The runtime hands over data; this assembles the conveniences an executor
 * expects, so that every node gets identical behaviour for expression
 * resolution, emission and failure instead of each one improvising.
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
  variables?: Record<string, JsonValue>;
  nodeOutputs?: Record<string, JsonValue>;
  logger?: ExecutorContext['logger'];
}): ExecutorContext {
  const items = args.input['main']?.items ?? [];
  const noop = () => {};
  const logger = args.logger ?? { debug: noop, info: noop, warn: noop };

  return {
    nodeId: args.nodeId,
    scopePath: args.scopePath,
    attempt: args.attempt,
    idempotencyKey: args.idempotencyKey,
    input: args.input,
    items,
    config: args.config,
    credentials: args.credentials,
    signal: args.signal,
    logger,

    resolveConfig<T = JsonObject>(extra?: Partial<ResolveContext>): T {
      const ctx: ResolveContext = {
        json: items[0]?.data ?? null,
        items: items.map((i) => i.data),
        vars: args.variables ?? {},
        nodes: args.nodeOutputs ?? {},
        run: { scopePath: args.scopePath, attempt: args.attempt },
        ...extra,
      };
      return resolveValue(args.config as JsonValue, ctx) as T;
    },

    emit(port: PortId, emitted: Item[]): Record<PortId, Envelope> {
      return {
        [port]: {
          items: emitted,
          meta: { node: args.nodeId, port, scopePath: args.scopePath, emittedAt: 0 },
        },
      };
    },

    fail(message: string, options?: { code?: string; retryable?: boolean }): never {
      throw new NodeFailure(message, options);
    },
  };
}

/**
 * A test harness for node authors.
 *
 * Every node pack gets the same contract test for free, which is the only way
 * a registry of third-party nodes stays trustworthy: "it works on my machine"
 * does not survive someone else's workflow.
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
  const input: Record<PortId, Envelope> =
    args.input ?? { main: { items: args.items ?? [] } };

  const ctx = makeContext({
    nodeId: 'test',
    scopePath: '',
    attempt: 1,
    idempotencyKey: 'test-key',
    input,
    config: args.config ?? {},
    credentials: args.credentials ?? {},
    signal: new AbortController().signal,
    ...(args.variables ? { variables: args.variables } : {}),
  });
  return definition.execute(ctx);
}
