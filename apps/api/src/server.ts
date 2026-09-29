/**
 * @goblin/api in local mode: the server behind the canvas.
 *
 * No framework — a dozen routes do not need one, and every dependency here is
 * one more thing between a request and the engine. No login either, because
 * local mode has one user; which makes two protections non-negotiable:
 *
 *  - It listens on 127.0.0.1 only, never on the network (see main.ts).
 *  - It refuses requests another website makes from your browser. Without
 *    that, any page you visit could POST a workflow here and have this machine
 *    make HTTP requests on its behalf. Browsers send an Origin header on such
 *    requests, and a JSON content type forces a preflight this server never
 *    approves, so checking both closes the door.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { randomBytes } from 'node:crypto';

import {
  createHttpClient,
  createScopedKV,
  CredentialRuntime,
  InMemoryBlobStore,
  InMemoryCredentialStore,
  InMemoryStateStore,
  isBlobKey,
  nodeMigrations,
  type BlobStore,
  type Capability,
  type CredentialStore,
  type CredentialTypeDefinition,
  type MeteredHttpClient,
  type NodeDefinition,
  type StateStore,
} from '@goblin/node-sdk';
import { foldJournal } from '@goblin/runtime';
import {
  migrateDocument,
  migrateNodes,
  type CredentialTypeManifest,
  type Envelope,
  type JsonValue,
  type ManifestRegistry,
  type NodeManifest,
  type WorkflowDocument,
} from '@goblin/spec';

import { MemoryAuditLog, type AuditLog } from './audit.js';
import { LOCAL_TENANT, type ActionResult, type ApiError, type RunStreamMessage } from './protocol.js';
import { InvalidWorkflowError, RunManager, diagnose, toEnvelope } from './runs.js';
import { StoreError, type ActivationStore, type RunStore, type WorkflowStore } from './stores.js';
import { ActivationError, TriggerService, safeHeaders } from './triggers.js';

export interface ApiOptions {
  workflows: WorkflowStore;
  runs: RunStore;
  activations: ActivationStore;
  registry: ManifestRegistry;
  manifests: NodeManifest[];
  nodes: NodeDefinition[];
  /** Built web app to serve at `/`, if there is one. In dev, Vite serves it instead. */
  staticDir?: string;
  /** Origins allowed to call the API, e.g. the Vite dev server. Same-origin is always allowed. */
  allowedOrigins?: string[];
  /** Where webhook URLs point: this server's own address, e.g. http://127.0.0.1:8787 */
  hooksBase?: string;
  /** Saved credentials. Absent: an in-memory store, for tests. */
  credentials?: CredentialStore;
  /** Every credential type the installed packs ship, with its resolver. */
  credentialTypes?: CredentialTypeDefinition[];
  /** Capabilities packs define, beside the kit's httpAuth@1 and httpSigner@1. */
  capabilities?: Capability[];
  /** Where ctx.blobs keeps files. Absent: memory. */
  blobs?: BlobStore;
  /** Where ctx.state is kept. Absent: memory. */
  state?: StateStore;
  audit?: AuditLog;
  /** 'local' (default) lets boxes call servers on this machine, like your own dev API. */
  httpMode?: 'local' | 'hosted';
  /** The client boxes and credential resolvers use. Tests hand in a mock. */
  http?: MeteredHttpClient;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly body?: Partial<ApiError>) {
    super(message);
  }
}

const MAX_BODY = 2 * 1024 * 1024;

export function createApi(options: ApiOptions): {
  server: Server;
  runs: RunManager;
  triggers: TriggerService;
  credentials: CredentialRuntime;
} {
  const http = options.http ?? createHttpClient({ mode: options.httpMode ?? 'local' });
  const credentialStore = options.credentials ?? new InMemoryCredentialStore();
  const credentialTypes = options.credentialTypes ?? [];
  const credentials = new CredentialRuntime({
    store: credentialStore,
    types: credentialTypes,
    http,
    ...(options.capabilities ? { capabilities: options.capabilities } : {}),
  });
  const blobs = options.blobs ?? new InMemoryBlobStore();
  const state = options.state ?? new InMemoryStateStore();
  const audit = options.audit ?? new MemoryAuditLog();
  const migrations = nodeMigrations(options.nodes);
  // Every document that comes in is brought up to date, box by box, before
  // anything reads it: an old HTTP Request opens and saves as the current one.
  const load = (value: unknown): WorkflowDocument => migrateNodes(asDocument(value), migrations).document;

  const runs = new RunManager({
    registry: options.registry,
    nodes: options.nodes,
    runs: options.runs,
    services: { http, credentials, blobs, state },
  });
  const triggers = new TriggerService({
    workflows: options.workflows,
    activations: options.activations,
    runs,
    registry: options.registry,
    hooksBase: options.hooksBase ?? 'http://127.0.0.1:8787',
  });

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (error instanceof HttpError) return send(res, error.status, { error: error.message, ...error.body });
      if (error instanceof InvalidWorkflowError) {
        return send(res, 422, { error: error.message, diagnostics: error.diagnostics });
      }
      if (error instanceof StoreError) return send(res, 400, { error: error.message });
      if (error instanceof ActivationError) return send(res, 422, { error: error.message });
      console.error(error);
      send(res, 500, { error: 'Something went wrong on the local server. Its console has the details.' });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';

    if (url.pathname.startsWith('/hooks/')) return handleHook(req, res, url);

    if (!url.pathname.startsWith('/api/')) {
      if (method === 'GET' && options.staticDir) return serveStatic(options.staticDir, url.pathname, res);
      throw new HttpError(404, 'Not found.');
    }

    guardOrigin(req, options.allowedOrigins ?? []);
    const parts = url.pathname.slice('/api/'.length).split('/').filter(Boolean);
    const route = `${method} /${parts.map((p, i) => (i % 2 === 1 ? ':id' : p)).join('/')}`;
    const id = parts[1] ?? '';

    switch (route) {
      case 'GET /health':
        return send(res, 200, { ok: true, tenant: LOCAL_TENANT });

      case 'GET /nodes':
        return send(res, 200, options.manifests);

      case 'POST /validate': {
        const document = load(await readBody(req));
        return send(res, 200, { diagnostics: diagnose(document, options.registry) });
      }

      case 'GET /workflows': {
        const [list, active] = await Promise.all([options.workflows.list(), options.activations.list()]);
        const on = new Set(active);
        return send(res, 200, list.map((w) => ({ ...w, active: on.has(w.id) })));
      }

      case 'POST /workflows': {
        const body = (await readBody(req)) as { name?: unknown; document?: unknown } | null;
        const document: WorkflowDocument = body?.document
          ? { ...load(body.document), id: newWorkflowId() }
          : blankWorkflow(typeof body?.name === 'string' && body.name.trim() ? body.name.trim() : 'Untitled workflow');
        return send(res, 201, await options.workflows.put(document));
      }

      case 'GET /workflows/:id': {
        const document = await options.workflows.get(id);
        if (!document) throw new HttpError(404, 'That workflow does not exist. It may have been deleted.');
        return send(res, 200, migrateNodes(migrateDocument(document).document, migrations).document);
      }

      case 'PUT /workflows/:id': {
        const document = load(await readBody(req));
        if (document.id !== id) throw new HttpError(400, 'The document id does not match the address it was saved to.');
        // Saved even when it has problems: a half-built workflow is still work
        // worth keeping. Problems block running, not saving.
        const saved = await options.workflows.put(document);
        // A changed schedule takes effect at once on a workflow that is switched on.
        await triggers.refresh(id);
        return send(res, 200, saved);
      }

      case 'DELETE /workflows/:id': {
        await triggers.setActive(id, false);
        const deleted = await options.workflows.delete(id);
        if (!deleted) throw new HttpError(404, 'That workflow does not exist.');
        return send(res, 200, { deleted: true });
      }

      case 'GET /workflows/:id/activation':
        return send(res, 200, await triggers.status(id));

      case 'PUT /workflows/:id/activation': {
        const body = (await readBody(req)) as { active?: unknown } | null;
        if (typeof body?.active !== 'boolean') throw new HttpError(400, 'Send { "active": true } or { "active": false }.');
        return send(res, 200, await triggers.setActive(id, body.active));
      }

      case 'GET /workflows/:id/runs':
        return send(res, 200, await options.runs.list(id));

      case 'POST /workflows/:id/runs': {
        const body = (await readBody(req)) as { document?: unknown; input?: JsonValue } | null;
        // The canvas sends what is on screen, so Run runs what you see even if
        // the last autosave has not landed yet. It is saved first, so the run
        // history always points at a version of the workflow that exists.
        let document: WorkflowDocument | undefined;
        if (body?.document) {
          document = load(body.document);
          if (document.id !== id) throw new HttpError(400, 'The document id does not match the workflow being run.');
          document = await options.workflows.put(document);
        } else {
          const stored = await options.workflows.get(id);
          document = stored ? migrateNodes(migrateDocument(stored).document, migrations).document : undefined;
        }
        if (!document) throw new HttpError(404, 'That workflow does not exist.');
        const record = await runs.start(document, body && 'input' in body ? { input: toEnvelope(body.input) } : {});
        return send(res, 202, record);
      }

      case 'GET /runs/:id': {
        const detail = await options.runs.get(id);
        if (!detail) throw new HttpError(404, 'That run does not exist.');
        return send(res, 200, detail);
      }

      case 'GET /runs/:id/events':
        return streamRun(id, res);

      case 'POST /runs/:id/nodes/:id/actions/:id':
        return send(res, 200, await runAction(id, parts[3] ?? '', parts[5] ?? ''));

      /* ------------------------------------------------------ credentials */

      case 'GET /credential-types':
        return send(res, 200, credentialTypes.map((t) => t.manifest));

      case 'GET /credentials':
        return send(res, 200, await credentialStore.list());

      case 'POST /credentials': {
        const input = credentialInput(await readBody(req), credentialTypes.map((t) => t.manifest));
        const meta = await credentialStore.create(input);
        await audit.record({ action: 'credential.created', subject: meta.id, detail: { type: meta.type, name: meta.name } });
        return send(res, 201, meta);
      }

      case 'PUT /credentials/:id': {
        const existing = await credentialStore.get(id);
        if (!existing) throw new HttpError(404, 'That credential does not exist.');
        const body = (await readBody(req)) as { name?: unknown; values?: unknown } | null;
        const name = typeof body?.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 80) : undefined;
        const values =
          body?.values !== undefined
            ? credentialInput({ type: existing.type, name: name ?? existing.name, values: body.values }, credentialTypes.map((t) => t.manifest)).values
            : undefined;
        const meta = await credentialStore.replace(id, { ...(name ? { name } : {}), ...(values ? { values } : {}) });
        // The cached token belongs to the old values; the next box that asks gets a fresh one.
        credentials.invalidate(id);
        await audit.record({ action: values ? 'credential.replaced' : 'credential.renamed', subject: id, detail: { name: meta.name } });
        return send(res, 200, meta);
      }

      case 'DELETE /credentials/:id': {
        const deleted = await credentialStore.delete(id);
        credentials.invalidate(id);
        if (!deleted) throw new HttpError(404, 'That credential does not exist.');
        await audit.record({ action: 'credential.deleted', subject: id });
        return send(res, 200, { deleted: true });
      }

      /* ------------------------------------------------------------ blobs */

      case 'GET /blobs/:id':
        return sendBlob(id, url, res);

      default:
        throw new HttpError(404, `No such endpoint: ${method} ${url.pathname}`);
    }
  }

  /**
   * A person's action on a box in a finished run — "Accept as baseline".
   * Only here, behind /api's origin guard: a webhook or a schedule can start
   * a run, but can never accept its results.
   */
  async function runAction(runId: string, nodeId: string, actionId: string): Promise<ActionResult> {
    const detail = await options.runs.get(runId);
    if (!detail) throw new HttpError(404, 'That run does not exist.');
    if (detail.record.finishedAt === undefined) throw new HttpError(409, 'Wait for the run to finish first.');
    const document = (await options.runs.document(runId)) ?? (await options.workflows.get(detail.record.workflowId));
    const node = document?.nodes.find((n) => n.id === nodeId);
    if (!document || !node) throw new HttpError(404, 'That box is not part of this run.');
    const definition = options.nodes.find((d) => d.manifest.type === node.type && d.manifest.version === node.typeVersion);
    const handler = definition?.actions?.[actionId];
    if (!handler) throw new HttpError(404, 'That box has no such action.');

    const folded = foldJournal(runId, detail.journal);
    const finished = Object.values(folded.nodeRuns).some((r) => r.nodeId === nodeId && r.scopePath === '' && r.status === 'succeeded');
    if (!finished) throw new HttpError(409, 'That box did not finish in this run, so there is nothing to act on.');

    // What the box received and emitted, exactly as the journal recorded it.
    const input: Record<string, Envelope> = {};
    for (const edge of document.edges) {
      if (edge.to.node !== nodeId) continue;
      const delivered = folded.edges[`${edge.id}#`];
      if (delivered?.status !== 'delivered') continue;
      input[edge.to.port] = { items: [...(input[edge.to.port]?.items ?? []), ...delivered.envelope.items] };
    }
    const outputs: Record<string, Envelope> = {};
    for (const [key, envelope] of Object.entries(folded.outputs)) {
      if (key.startsWith(`${nodeId}:`) && key.endsWith('#')) outputs[key.slice(nodeId.length + 1, -1)] = envelope;
    }

    const workflowId = detail.record.workflowId;
    const kv = createScopedKV({ store: state, workflowId, nodeId });
    const { message } = await handler({ runId, workflowId, nodeId, input, outputs, config: node.config, state: kv });
    const writes = kv.writes();
    let conflicts: string[] = [];
    if (writes.length) ({ conflicts } = await state.apply(workflowId, nodeId, writes, `action:${runId}:${nodeId}:${actionId}:${Date.now()}`));
    await audit.record({ action: `box.${actionId}`, subject: `${workflowId}/${nodeId}`, detail: { runId, keys: writes.map((w) => w.key), conflicts } });
    return { message, conflicts };
  }

  /**
   * A file a box made, as a download. Always an attachment and never sniffed,
   * so a stored file can never run as a page on this origin. Images keep
   * their type so the editor can show them in an `<img>` — which never runs
   * an SVG's scripts — and carry a sandboxing CSP in case one is opened
   * directly.
   */
  async function sendBlob(key: string, url: URL, res: ServerResponse): Promise<void> {
    if (!isBlobKey(key)) throw new HttpError(404, 'No such file.');
    const bytes = await blobs.get(key);
    if (!bytes) throw new HttpError(404, 'That file is no longer kept.');
    const type = url.searchParams.get('type') ?? '';
    const image = ['image/svg+xml', 'image/png'].includes(type);
    const safe = ['text/markdown', 'text/plain', 'text/csv', 'application/json', 'image/svg+xml'].includes(type)
      ? `${type}; charset=utf-8`
      : image
        ? type
        : 'application/octet-stream';
    const name = (url.searchParams.get('name') ?? key.slice(0, 12)).replace(/[^\w.\- ]+/g, '_').slice(0, 100) || 'download';
    res.writeHead(200, {
      'content-type': safe,
      'content-length': bytes.byteLength,
      'content-disposition': `attachment; filename="${name}"`,
      'x-content-type-options': 'nosniff',
      ...(image ? { 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" } : {}),
    });
    res.end(Buffer.from(bytes));
  }

  async function streamRun(runId: string, res: ServerResponse): Promise<void> {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    });
    const write = (message: RunStreamMessage) => {
      res.write(`event: ${message.type}\ndata: ${JSON.stringify(message)}\n\n`);
      if (message.type === 'end') res.end();
    };
    const stop = await runs.follow(runId, write);
    if (!stop) {
      res.write(`event: missing\ndata: ${JSON.stringify({ error: 'That run does not exist.' })}\n\n`);
      res.end();
      return;
    }
    res.on('close', stop);
  }

  /**
   * A call to a Webhook box: /hooks/<workflow>/<box>. Meant for other programs
   * on this machine — your scraper, a script. A web page in your browser must
   * not be able to fire your workflows, so a request carrying another site's
   * Origin is refused, exactly as for /api.
   */
  async function handleHook(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const origin = req.headers.origin;
    if (origin && origin !== `http://${req.headers.host}`) {
      throw new HttpError(403, 'Webhooks cannot be called from a web page in your browser.');
    }
    const [workflowId = '', nodeId = '', ...rest] = url.pathname.slice('/hooks/'.length).split('/');
    if (!workflowId || !nodeId || rest.length) throw new HttpError(404, 'Webhook addresses look like /hooks/<workflow>/<box>.');
    const answer = await triggers.webhook(workflowId, nodeId, {
      method: req.method ?? 'GET',
      query: Object.fromEntries(url.searchParams),
      headers: safeHeaders(req.headers),
      body: await readHookBody(req),
    });
    send(res, answer.status, answer.body);
  }

  return { server, runs, triggers, credentials };
}

/* ------------------------------------------------------------------ helpers */

function guardOrigin(req: IncomingMessage, allowed: string[]): void {
  const origin = req.headers.origin;
  const host = req.headers.host;
  // No Origin header: not a cross-site browser request (curl, the CLI, tests).
  if (origin && origin !== `http://${host}` && !allowed.includes(origin)) {
    throw new HttpError(403, 'Requests from other websites are not accepted by the local GoblinKit server.');
  }
  const method = req.method ?? 'GET';
  if ((method === 'POST' || method === 'PUT') && !String(req.headers['content-type'] ?? '').startsWith('application/json')) {
    throw new HttpError(415, 'Send JSON with a content-type of application/json.');
  }
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'That request is too large for the local server (2 MB limit).');
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'The request body is not valid JSON.');
  }
}

/**
 * A webhook body, as whatever the caller sent: JSON becomes data, a form
 * becomes an object of its fields, anything else arrives as text. Programs
 * call webhooks in all three ways, and each should just work.
 */
async function readHookBody(req: IncomingMessage): Promise<JsonValue> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'That request is too large (2 MB limit).');
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return null;
  const text = Buffer.concat(chunks).toString('utf8');
  const type = String(req.headers['content-type'] ?? '').toLowerCase();
  if (type.includes('json')) {
    try {
      return JSON.parse(text) as JsonValue;
    } catch {
      throw new HttpError(400, 'The request says it is JSON, but its body is not valid JSON.');
    }
  }
  if (type.startsWith('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(text));
  return text;
}

/**
 * Check a credential against its type: a known type, a name, only the
 * fields it declares, every required one filled in. Defaults fill the rest.
 */
function credentialInput(value: unknown, types: CredentialTypeManifest[]): { type: string; name: string; values: Record<string, string> } {
  const body = value as { type?: unknown; name?: unknown; values?: unknown } | null;
  const type = types.find((t) => t.type === body?.type);
  if (!type) throw new HttpError(400, `Unknown credential type ${JSON.stringify(body?.type)}.`);
  const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 80) : '';
  if (!name) throw new HttpError(400, 'Give the credential a name, so you can tell it apart in the picker.');
  if (!body?.values || typeof body.values !== 'object' || Array.isArray(body.values)) throw new HttpError(400, 'Send the values as an object of field → text.');
  const raw = body.values as Record<string, unknown>;
  const values: Record<string, string> = {};
  for (const [field, v] of Object.entries(raw)) {
    if (!type.fields.some((f) => f.name === field)) throw new HttpError(400, `${type.title} has no field "${field}".`);
    if (typeof v !== 'string') throw new HttpError(400, `"${field}" must be text.`);
    values[field] = v;
  }
  for (const f of type.fields) {
    if (!values[f.name]?.trim() && f.default !== undefined) values[f.name] = f.default;
    if (f.required && !values[f.name]?.trim()) throw new HttpError(400, `${f.label ?? f.name} is needed.`);
  }
  return { type: type.type, name, values };
}

function asDocument(value: unknown): WorkflowDocument {
  if (!value || typeof value !== 'object' || !Array.isArray((value as WorkflowDocument).nodes)) {
    throw new HttpError(400, 'Expected a workflow document with a nodes list.');
  }
  const { document } = migrateDocument(value);
  return { ...document, tenantId: LOCAL_TENANT };
}

export function newWorkflowId(): string {
  return `wf_${randomBytes(6).toString('hex')}`;
}

/** A new workflow starts with the one box every workflow needs. */
export function blankWorkflow(name: string): WorkflowDocument {
  return {
    schemaVersion: 1,
    id: newWorkflowId(),
    tenantId: LOCAL_TENANT,
    name,
    nodes: [
      {
        id: 'start',
        type: 'core.trigger.manual',
        typeVersion: 1,
        label: 'Start',
        config: { testInput: {} },
        ui: { position: { x: 0, y: 0 } },
      },
    ],
    edges: [],
  };
}

function send(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(json) });
  res.end(json);
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

async function serveStatic(root: string, pathname: string, res: ServerResponse): Promise<void> {
  const base = normalize(root + sep);
  let file = normalize(join(root, decodeURIComponent(pathname)));
  // Never serve anything outside the built app, whatever the path says.
  if (!file.startsWith(base)) throw new HttpError(404, 'Not found.');
  let info = await stat(file).catch(() => undefined);
  if (!info || info.isDirectory()) {
    // Unknown paths get the app, which does its own routing.
    file = join(root, 'index.html');
    info = await stat(file).catch(() => undefined);
    if (!info) throw new HttpError(404, 'The web app has not been built. Run `pnpm dev` instead.');
  }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
}
