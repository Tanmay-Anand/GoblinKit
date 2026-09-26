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

import type { NodeDefinition } from '@goblin/node-sdk';
import { migrateDocument, type JsonValue, type NodeManifest, type ManifestRegistry, type WorkflowDocument } from '@goblin/spec';

import { LOCAL_TENANT, type ApiError, type RunStreamMessage } from './protocol.js';
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
}

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly body?: Partial<ApiError>) {
    super(message);
  }
}

const MAX_BODY = 2 * 1024 * 1024;

export function createApi(options: ApiOptions): { server: Server; runs: RunManager; triggers: TriggerService } {
  const runs = new RunManager({ registry: options.registry, nodes: options.nodes, runs: options.runs });
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
        const document = asDocument(await readBody(req));
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
          ? { ...asDocument(body.document), id: newWorkflowId() }
          : blankWorkflow(typeof body?.name === 'string' && body.name.trim() ? body.name.trim() : 'Untitled workflow');
        return send(res, 201, await options.workflows.put(document));
      }

      case 'GET /workflows/:id': {
        const document = await options.workflows.get(id);
        if (!document) throw new HttpError(404, 'That workflow does not exist. It may have been deleted.');
        return send(res, 200, migrateDocument(document).document);
      }

      case 'PUT /workflows/:id': {
        const document = asDocument(await readBody(req));
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
          document = asDocument(body.document);
          if (document.id !== id) throw new HttpError(400, 'The document id does not match the workflow being run.');
          document = await options.workflows.put(document);
        } else {
          document = await options.workflows.get(id);
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

      default:
        throw new HttpError(404, `No such endpoint: ${method} ${url.pathname}`);
    }
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

  return { server, runs, triggers };
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
