import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { expect, type APIRequestContext } from '@playwright/test';

import type { RunRecord } from '../../apps/api/src/protocol.js';
import type { WorkflowDocument } from '../../packages/spec/src/index.js';

/**
 * Arrange state through the API rather than by clicking.
 *
 * A test about running a workflow should not also be a test of building one:
 * setting up through the UI makes every test slow and makes one broken button
 * fail twenty unrelated tests. The UI is exercised where it is the subject.
 */
export class GoblinApi {
  private readonly created: string[] = [];

  constructor(private readonly request: APIRequestContext) {}

  /** A new workflow, with a Start box, as "New workflow" makes it. */
  async createWorkflow(name: string): Promise<WorkflowDocument> {
    const res = await this.request.post('/api/workflows', { data: { name } });
    expect(res.status(), await res.text()).toBe(201);
    return this.track((await res.json()) as WorkflowDocument);
  }

  /** A copy of one of the documents in examples/. */
  async createFromExample(file: string): Promise<WorkflowDocument> {
    const path = fileURLToPath(new URL(`../../examples/${file}`, import.meta.url));
    const document = JSON.parse(await readFile(path, 'utf8')) as WorkflowDocument;
    const res = await this.request.post('/api/workflows', { data: { document } });
    expect(res.status(), await res.text()).toBe(201);
    return this.track((await res.json()) as WorkflowDocument);
  }

  async save(document: WorkflowDocument): Promise<WorkflowDocument> {
    const res = await this.request.put(`/api/workflows/${document.id}`, { data: document });
    expect(res.status(), await res.text()).toBe(200);
    return (await res.json()) as WorkflowDocument;
  }

  async getWorkflow(id: string): Promise<WorkflowDocument> {
    const res = await this.request.get(`/api/workflows/${id}`);
    expect(res.status()).toBe(200);
    return (await res.json()) as WorkflowDocument;
  }

  async runs(workflowId: string): Promise<RunRecord[]> {
    const res = await this.request.get(`/api/workflows/${workflowId}/runs`);
    expect(res.status()).toBe(200);
    return (await res.json()) as RunRecord[];
  }

  /** Start a run without the canvas, and wait for it to finish. */
  async runToEnd(workflowId: string): Promise<RunRecord> {
    const res = await this.request.post(`/api/workflows/${workflowId}/runs`, { data: {} });
    expect(res.status(), await res.text()).toBe(202);
    const { runId } = (await res.json()) as RunRecord;
    await expect.poll(async () => (await this.runs(workflowId)).find((r) => r.runId === runId)?.finishedAt).toBeTruthy();
    return (await this.runs(workflowId)).find((r) => r.runId === runId)!;
  }

  /** Clean up a workflow the test created through the UI rather than through here. */
  adopt(workflowId: string): void {
    this.created.push(workflowId);
  }

  /** Delete everything this test created. Called by the fixture after each test. */
  async cleanUp(): Promise<void> {
    for (const id of this.created) await this.request.delete(`/api/workflows/${id}`);
  }

  private track(doc: WorkflowDocument): WorkflowDocument {
    this.created.push(doc.id);
    return doc;
  }
}

/** Start → Set → Log, with sample input: the smallest workflow that shows data moving. */
export function greeterWorkflow(doc: WorkflowDocument): WorkflowDocument {
  const start = doc.nodes[0]!;
  return {
    ...doc,
    nodes: [
      { ...start, config: { testInput: { name: 'world' } }, ui: { position: { x: 0, y: 0 } } },
      {
        id: 'greet',
        type: 'core.transform.set',
        typeVersion: 1,
        label: 'Greet',
        config: { values: { greeting: 'Hello {{ $json.name }}' }, keepInput: true },
        ui: { position: { x: 0, y: 200 } },
      },
      { id: 'note', type: 'core.log', typeVersion: 1, label: 'Note', config: {}, ui: { position: { x: 0, y: 400 } } },
    ],
    edges: [
      { id: 'e1', from: { node: start.id, port: 'main' }, to: { node: 'greet', port: 'main' } },
      { id: 'e2', from: { node: 'greet', port: 'main' }, to: { node: 'note', port: 'main' } },
    ],
  };
}
