import { expect, test } from './support/fixtures.js';
import { greeterWorkflow } from './support/api.js';
import { unusedPort } from './support/network.js';

test.describe('problems are caught before and during a run', () => {
  test('a missing setting is marked on the box, and Run refuses until it is filled in', async ({ api, canvas }) => {
    const doc = await api.createWorkflow('Needs a URL');
    await canvas.open(doc.id);

    await canvas.addAfter('Start', 'HTTP Request');
    await expect(canvas.box('HTTP Request')).toContainText('needs its URL filled in');

    await canvas.run();
    await expect(canvas.toast).toHaveText(/Fix the problem marked in red first/);
    expect(await api.runs(doc.id)).toHaveLength(0);

    await canvas.setField('URL', 'https://example.com/');
    await expect(canvas.problems).toBeHidden();
  });

  test('a request that gets no answer says why, after its retries', async ({ api, canvas }) => {
    const port = await unusedPort();
    const doc = await api.createWorkflow('Unreachable');
    await api.save({
      ...doc,
      nodes: [
        doc.nodes[0]!,
        {
          id: 'call',
          type: 'core.http.request',
          typeVersion: 1,
          label: 'Call the scraper',
          config: { method: 'GET', url: `http://127.0.0.1:${port}/scrape` },
          // Two quick attempts keep the test fast and still exercise a retry.
          policy: { retry: { maxAttempts: 2, backoffMs: 50, maxBackoffMs: 50 } },
          ui: { position: { x: 0, y: 200 } },
        },
      ],
      edges: [{ id: 'e1', from: { node: 'start', port: 'main' }, to: { node: 'call', port: 'main' } }],
    });
    await canvas.open(doc.id);

    await canvas.run();
    await canvas.waitForRunToFinish();

    await expect(canvas.box('Call the scraper')).toContainText(`Could not connect to 127.0.0.1:${port}: nothing is listening there`);
    await expect(canvas.toast).toHaveText(/^Run failed:/);
    const [run] = await api.runs(doc.id);
    expect(run?.counters?.retries).toBe(1);
  });

  test('a wire that would loop forever is refused', async ({ api, canvas }) => {
    const doc = await api.save(greeterWorkflow(await api.createWorkflow('No loops')));
    await canvas.open(doc.id);
    await expect(canvas.wires).toHaveCount(2);

    // Note → Greet would send Greet's output back into itself.
    await canvas.connect('Note', 'Greet');

    await expect(canvas.wires).toHaveCount(2);
    await expect(canvas.wire('Note', 'Greet')).toHaveCount(0);
  });
});
