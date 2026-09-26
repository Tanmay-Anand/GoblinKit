/**
 * The web app's client for the local GoblinKit server.
 *
 * Everything goes to the same origin under /api (Vite proxies it in dev), so
 * the server's "refuse other websites" rule never gets in the way.
 */

import { RunRefused, type EditorBackend } from '@goblin/editor';
import type { NodeManifest, WorkflowDocument } from '@goblin/spec';
import type { ActivationStatus, ApiError, RunDetail, RunRecord, RunStreamMessage, WorkflowSummary } from '@goblin/api/protocol';

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      ...init,
      headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers },
    });
  } catch {
    throw new Error('Cannot reach the local GoblinKit server. Is `pnpm dev` still running?');
  }
  const body = (await res.json().catch(() => null)) as (T & Partial<ApiError>) | null;
  if (!res.ok) {
    if (res.status === 422 && body?.diagnostics) throw new RunRefused(body.error ?? 'This workflow has problems to fix.', body.diagnostics);
    throw new Error(body?.error ?? `The local server answered ${res.status}.`);
  }
  return body as T;
}

const send = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

export const api = {
  nodes: () => call<NodeManifest[]>('/nodes'),
  listWorkflows: () => call<WorkflowSummary[]>('/workflows'),
  createWorkflow: (name: string) => call<WorkflowDocument>('/workflows', send('POST', { name })),
  getWorkflow: (id: string) => call<WorkflowDocument>(`/workflows/${encodeURIComponent(id)}`),
  deleteWorkflow: (id: string) => call<{ deleted: boolean }>(`/workflows/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};

export const backend: EditorBackend = {
  save: (doc) => call<WorkflowDocument>(`/workflows/${encodeURIComponent(doc.id)}`, send('PUT', doc)),
  startRun: (doc) => call<RunRecord>(`/workflows/${encodeURIComponent(doc.id)}/runs`, send('POST', { document: doc })),
  listRuns: (workflowId) => call<RunRecord[]>(`/workflows/${encodeURIComponent(workflowId)}/runs`),
  getRun: (runId) => call<RunDetail>(`/runs/${encodeURIComponent(runId)}`),
  getActivation: (workflowId) => call<ActivationStatus>(`/workflows/${encodeURIComponent(workflowId)}/activation`),
  setActive: (workflowId, active) =>
    call<ActivationStatus>(`/workflows/${encodeURIComponent(workflowId)}/activation`, send('PUT', { active })),

  follow(runId, onMessage) {
    const source = new EventSource(`/api/runs/${encodeURIComponent(runId)}/events`);
    const handle = (event: MessageEvent<string>) => {
      const message = JSON.parse(event.data) as RunStreamMessage;
      onMessage(message);
      if (message.type === 'end') source.close();
    };
    for (const type of ['entries', 'log', 'end'] as const) source.addEventListener(type, handle);
    source.addEventListener('missing', () => source.close());
    // EventSource reconnects by itself, and the server replays a run from the
    // start on every connection — which would count each step twice. A
    // dropped stream is closed instead; reopening the run replays it once.
    source.onerror = () => source.close();
    return () => source.close();
  },
};
