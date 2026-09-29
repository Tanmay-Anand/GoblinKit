import { readFile } from 'node:fs/promises';

import type { WorkflowDocument } from '../packages/spec/src/index.js';
import { expect, test } from './support/fixtures.js';
import type { GoblinApi } from './support/api.js';
import { startStubApi } from './support/stub-api.js';

type Stub = Awaited<ReturnType<typeof startStubApi>>;
let stub: Stub;

test.beforeEach(async () => {
  stub = await startStubApi();
});
test.afterEach(async () => {
  await stub.close();
});

/** The endpoint-latency example, pointed at this test's stub API. */
async function latencyWorkflow(api: GoblinApi, name: string): Promise<WorkflowDocument> {
  const doc = await api.createFromExample('endpoint-latency.json');
  return api.save({ ...doc, name, variables: { ...doc.variables, baseUrl: stub.url, tenantId: 'acme' } });
}

test.describe('measuring endpoints with a saved credential', () => {
  test('a credential is added on its screen, picked on the boxes, and signs every request without being shown again', async ({ page, api, canvas, credentials }) => {
    const token = `e2e-token-${Date.now().toString(36)}`;
    const name = `Stub API ${test.info().workerIndex}-${Date.now().toString(36)}`;
    const doc = await latencyWorkflow(api, `Latency ${name}`);

    await test.step('add it on the Credentials screen', async () => {
      await credentials.open();
      await credentials.add('Bearer token', name, { Token: token });
      await api.adoptCredential(name);
      await expect(credentials.row(name)).toContainText('Bearer token');
      // Written once, never shown back.
      await expect(page.locator('body')).not.toContainText(token);
    });

    await test.step('it is offered on boxes that can sign in, and only there', async () => {
      await canvas.open(doc.id);
      await canvas.openSettings('BM-1496 targets');
      await expect(canvas.settings.getByRole('combobox', { name: 'Sign in with' })).toHaveCount(0);
      for (const box of ['Measure latency', 'Check against baseline']) {
        await canvas.openSettings(box);
        await canvas.settings.getByRole('combobox', { name: 'Sign in with' }).selectOption({ label: `${name} · Bearer token` });
      }
      await canvas.expectSaved();
    });

    await test.step('a run measures every endpoint, each request signed', async () => {
      await canvas.run();
      await canvas.waitForRunToFinish();
      await expect(canvas.box('Check against baseline')).toContainText('Done');
      expect(stub.requests.length).toBe(15 * 6);
      expect(stub.requests.every((r) => r.headers.authorization === `Bearer ${token}` && r.headers['x-tenant-id'] === 'acme')).toBe(true);
    });

    await test.step('the report downloads from the box’s output', async () => {
      await canvas.openSettings('Check against baseline');
      await canvas.settings.getByRole('tab', { name: 'Output' }).click();
      const download = page.waitForEvent('download');
      await canvas.settings.getByRole('link', { name: /endpoint-latency\.md/ }).click();
      const file = await download;
      expect(file.suggestedFilename()).toBe('endpoint-latency.md');
      const text = await readFile(await file.path(), 'utf8');
      expect(text).toContain('# Endpoint latency — BM-1496');
      expect(text).toContain('| projects | old → new |');
      expect(text).not.toContain(token);
    });

    await test.step('the chart box shows before and after as a picture', async () => {
      await canvas.openSettings('Before/after chart');
      await canvas.settings.getByRole('tab', { name: 'Output' }).click();
      const chart = canvas.settings.getByRole('img', { name: 'before-after.svg' });
      await expect(chart).toBeVisible();
      // It loaded and drew: an image that failed would have no size.
      await expect.poll(() => chart.evaluate((img: HTMLImageElement) => (img.complete ? img.naturalWidth : 0))).toBeGreaterThan(0);
      await expect(canvas.settings.getByRole('link', { name: /before-after\.svg/ })).toBeVisible();
    });
  });

  test('a box whose credential was deleted is marked before anything runs', async ({ api, canvas }) => {
    const credential = await api.createCredential('http.bearerToken', `Short-lived ${Date.now().toString(36)}`, { token: 'short-lived-token' });
    const base = await api.createWorkflow('Deleted credential');
    const doc = await api.save({
      ...base,
      nodes: [
        base.nodes[0]!,
        {
          id: 'call',
          type: 'core.http.request',
          typeVersion: 2,
          label: 'Call the API',
          config: { url: `${stub.url}/health` },
          credentials: { auth: credential },
          ui: { position: { x: 0, y: 220 } },
        },
      ],
      edges: [{ id: 'e1', from: { node: base.nodes[0]!.id, port: 'main' }, to: { node: 'call', port: 'main' } }],
    });
    await api.deleteCredential(credential.id);

    await canvas.open(doc.id);
    await expect(canvas.box('Call the API')).toContainText('was deleted. Pick another.');
    await canvas.openSettings('Call the API');
    await expect(canvas.settings.getByRole('combobox', { name: 'Sign in with' })).toHaveValue(credential.id);
    await expect(canvas.settings.getByRole('option', { name: 'A deleted credential' })).toBeAttached();
  });
});

test.describe('baselines', () => {
  // Three full measuring runs.
  test.slow();

  test('an intended slowdown is accepted as the new baseline from the run view, without measuring again', async ({ page, api, canvas }) => {
    const doc = await latencyWorkflow(api, `Latency accept ${Date.now().toString(36)}`);
    // A run is 15 endpoints × 6 requests, against a stub that takes tens of ms.
    await api.runToEnd(doc.id, { timeout: 30_000 });

    // The new projects endpoint now does more on purpose.
    stub.slowDown('/platform/projects/autocomplete', 250);
    const regressed = await api.runToEnd(doc.id, { timeout: 30_000 });
    expect(JSON.stringify(regressed.output)).toContain('projects/new');

    await canvas.open(doc.id);
    await page.getByRole('banner').getByRole('button', { name: 'Runs' }).click();
    await canvas.runsPanel.getByRole('listitem').getByRole('button').first().click();
    await expect(page.getByText(/Showing a past run from/)).toBeVisible();
    await expect(canvas.box('REGRESSION')).toContainText('Done · 1 item');

    await canvas.openSettings('Check against baseline');
    await canvas.settings.getByRole('tab', { name: 'Output' }).click();
    const requestsBefore = stub.requests.length;
    await canvas.settings.getByRole('button', { name: 'Accept as baseline' }).click();
    await expect(canvas.toast).toContainText('This run’s numbers are now the baseline for 15 endpoints.');
    expect(stub.requests.length).toBe(requestsBefore);

    // Still slow, and now that is normal.
    const after = await api.runToEnd(doc.id, { timeout: 30_000 });
    expect(JSON.stringify(after.output)).not.toContain('projects/new');
  });
});
