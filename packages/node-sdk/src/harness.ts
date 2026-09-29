/**
 * The node test harness (§12.3): run one box with every platform capability
 * real except the network, which is mocked — with timings you choose.
 *
 *   const t = createNodeHarness(measureNode);
 *   t.http.mock('GET https://api.test/users').reply(200, { ok: true }, { ttfbMs: 40, totalMs: [120, 80, 95] });
 *   const out = await t.run({ config: { url: 'https://api.test/users' } });
 *
 * The mock sits under the real client, at the transport, so a test exercises
 * the client's own timing, size cap and credential handling rather than a
 * stand-in for them. The clock is a fake that the mock moves forward, so a
 * reply "taking 120 ms" takes no time and times as exactly 120.
 */

import type { CredentialRef, Envelope, Item, JsonObject, JsonValue, PortId, StateWrite } from '@goblin/spec';

import { InMemoryBlobStore } from './blobs.js';
import type { Capability } from './capabilities.js';
import { CredentialRuntime, InMemoryCredentialStore, type CredentialTypeDefinition } from './credentials.js';
import { redact } from './failure.js';
import { createHttpClient, type HttpClientOptions, type HttpTransport, type MeteredHttpClient } from './http.js';
import { createScopedKV, InMemoryStateStore } from './state.js';
import { makeContext, type ExecutorResult, type NodeDefinition } from './index.js';

export class FakeClock {
  private ms = 0;
  now = (): number => this.ms;
  advance(ms: number): void {
    this.ms += Math.max(0, ms);
  }
}

export interface MockReplyOptions {
  headers?: Record<string, string>;
  /** Per call in turn; the last value repeats. Default 10. */
  ttfbMs?: number | number[];
  /** Per call in turn; the last value repeats. Default ttfb + 5. */
  totalMs?: number | number[];
}

type Reply =
  | { kind: 'reply'; status: number; body: Uint8Array; options: MockReplyOptions; remaining: number; used: number }
  | { kind: 'fail'; code: string; remaining: number; used: number }
  | { kind: 'hang'; remaining: number; used: number };

export interface MockCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export class MockRoute {
  readonly replies: Reply[] = [];

  /** Answer every call (after any `replyTimes` are used up). */
  reply(status: number, body?: JsonValue | Uint8Array, options: MockReplyOptions = {}): this {
    this.replies.push({ kind: 'reply', status, body: encode(body), options, remaining: Infinity, used: 0 });
    return this;
  }

  replyTimes(times: number, status: number, body?: JsonValue | Uint8Array, options: MockReplyOptions = {}): this {
    this.replies.push({ kind: 'reply', status, body: encode(body), options, remaining: times, used: 0 });
    return this;
  }

  /** A network failure, as Node's fetch reports it (`cause.code`). */
  fail(code = 'ECONNREFUSED', times = Infinity): this {
    this.replies.push({ kind: 'fail', code, remaining: times, used: 0 });
    return this;
  }

  /** Never answers: for timeouts. Ends when the request is aborted. */
  hang(times = Infinity): this {
    this.replies.push({ kind: 'hang', remaining: times, used: 0 });
    return this;
  }
}

export class MockHttp {
  readonly calls: MockCall[] = [];
  private readonly routes: { method: string; url: string; route: MockRoute }[] = [];

  constructor(readonly clock: FakeClock = new FakeClock()) {}

  /** "GET https://api.test/x" — a trailing * matches any URL starting with what precedes it. */
  mock(spec: string): MockRoute {
    const [method = 'GET', url = ''] = spec.trim().split(/\s+/, 2);
    const route = new MockRoute();
    this.routes.unshift({ method: method.toUpperCase(), url, route });
    return route;
  }

  readonly transport: HttpTransport = async (url, init) => {
    this.calls.push({
      method: init.method,
      url,
      headers: { ...init.headers },
      ...(typeof init.body === 'string' ? { body: init.body } : {}),
    });
    const match = this.routes.find(
      (r) => (r.method === 'ANY' || r.method === init.method) && (r.url.endsWith('*') ? url.startsWith(r.url.slice(0, -1)) : r.url === url),
    );
    const reply = match?.route.replies.find((r) => r.remaining > 0);
    if (!reply) throw new Error(`No mock answers ${init.method} ${url}`);
    reply.remaining--;
    const n = reply.used++;

    if (reply.kind === 'fail') throw Object.assign(new TypeError('fetch failed'), { cause: { code: reply.code } });
    if (reply.kind === 'hang') {
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
        if (init.signal.aborted) abort();
        else init.signal.addEventListener('abort', abort, { once: true });
      });
    }

    const ttfb = pick(reply.options.ttfbMs, n) ?? 10;
    const total = Math.max(ttfb, pick(reply.options.totalMs, n) ?? ttfb + 5);
    this.clock.advance(ttfb);
    const clock = this.clock;
    const bytes = reply.body;
    const empty = reply.status === 204 || reply.status === 304;
    let sent = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          clock.advance(total - ttfb);
          if (bytes.byteLength) controller.enqueue(bytes);
          return;
        }
        controller.close();
      },
      // Pull only when the client reads, so the body's time lands after the headers'.
    }, { highWaterMark: 0 });
    return new Response(empty ? null : stream, { status: reply.status, headers: reply.options.headers ?? {} });
  };

  /** A real metered client over this mock, timed by its clock. */
  client(options: Omit<HttpClientOptions, 'transport' | 'now'> = {}): MeteredHttpClient {
    return createHttpClient({ ...options, transport: this.transport, now: this.clock.now });
  }
}

function pick(value: number | number[] | undefined, n: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number') return value;
  return value[Math.min(n, value.length - 1)];
}

function encode(body: JsonValue | Uint8Array | undefined): Uint8Array {
  if (body === undefined) return new Uint8Array();
  if (body instanceof Uint8Array) return body;
  return new TextEncoder().encode(typeof body === 'string' ? body : JSON.stringify(body));
}

export interface HarnessRun {
  outputs: ExecutorResult;
  /** Items emitted on a port; empty when it emitted nothing. */
  items(port?: PortId): Item[];
  /** What the box wrote to its state (already applied unless `commit: false`). */
  writes: StateWrite[];
  conflicts: string[];
  logs: { level: string; message: string; data?: JsonValue }[];
}

export function createNodeHarness(
  definition: NodeDefinition,
  options: { credentialTypes?: CredentialTypeDefinition[]; capabilities?: Capability[]; workflowId?: string; mode?: 'local' | 'hosted' } = {},
) {
  const clock = new FakeClock();
  const http = new MockHttp(clock);
  const client = http.client({ mode: options.mode ?? 'local' });
  const state = new InMemoryStateStore();
  const blobs = new InMemoryBlobStore();
  const credentials = new InMemoryCredentialStore();
  const runtime = new CredentialRuntime({
    store: credentials,
    types: options.credentialTypes ?? [],
    http: client,
    ...(options.capabilities ? { capabilities: options.capabilities } : {}),
    // Epoch-shaped, and moved by the same fake clock: expiry is testable.
    now: () => 1_700_000_000_000 + clock.now(),
  });
  const workflowId = options.workflowId ?? 'wf_test';
  let runs = 0;

  return {
    clock,
    http,
    state,
    blobs,
    credentials,
    runtime,
    workflowId,

    /** Store a credential and get the reference a box's settings would hold. */
    async addCredential(type: string, values: Record<string, string>, name = type): Promise<CredentialRef> {
      const meta = await credentials.create({ type, name, values });
      return { id: meta.id, type };
    },

    async run(args: {
      config?: JsonObject;
      items?: Item[];
      input?: Record<PortId, Envelope>;
      credentials?: Record<string, CredentialRef>;
      variables?: Record<string, JsonValue>;
      attempt?: number;
      /** Apply the box's state writes, as the driver would on success. Default true. */
      commit?: boolean;
    } = {}): Promise<HarnessRun> {
      const nodeRun = `run${++runs}`;
      const kv = createScopedKV({ store: state, workflowId, nodeId: 'test' });
      const secrets = new Set<string>();
      const logs: HarnessRun['logs'] = [];
      const log = (level: string) => (message: string, data?: JsonValue) =>
        logs.push({ level, message: redact(message, secrets), ...(data !== undefined ? { data: redact(data, secrets) } : {}) });
      const slots = definition.manifest.credentials ?? [];
      const refs = args.credentials ?? {};

      const ctx = makeContext({
        nodeId: 'test',
        scopePath: '',
        attempt: args.attempt ?? 1,
        idempotencyKey: `test-key-${nodeRun}`,
        input: args.input ?? { main: { items: args.items ?? [{ data: {} }] } },
        config: args.config ?? {},
        manifest: definition.manifest,
        credentials: refs,
        signal: new AbortController().signal,
        variables: args.variables ?? {},
        logger: { debug: log('debug'), info: log('info'), warn: log('warn') },
        run: { id: nodeRun, workflowId },
        http: client,
        blobs,
        state: kv,
        credential: async (slot) => {
          const ref = refs[slot]!;
          const accepts = slots.find((s) => s.name === slot)?.accepts ?? [];
          const { secrets: found, ...resolved } = await runtime.resolve(ref, { accepts, signal: ctx.signal });
          for (const s of found) secrets.add(s);
          return resolved;
        },
      });

      const outputs = await definition.execute(ctx);
      const writes = kv.writes();
      let conflicts: string[] = [];
      if (args.commit !== false && writes.length) ({ conflicts } = await state.apply(workflowId, 'test', writes, nodeRun));
      return { outputs, items: (port = 'main') => outputs[port]?.items ?? [], writes, conflicts, logs };
    },
  };
}
