import { expect, test } from './support/fixtures.js';

/**
 * The product in one test: start from an empty canvas, add boxes, wire them,
 * set them up, press Run, and see the result. If this fails, nothing else in
 * the app matters yet.
 */
test('build a workflow from an empty canvas and run it', async ({ api, canvas }) => {
  const doc = await api.createWorkflow('Hello flow');
  await canvas.open(doc.id);

  await test.step('grow the flow from Start with its + button', async () => {
    await canvas.addAfter('Start', 'Set');
    await expect(canvas.wire('Start', 'Set')).toBeAttached();

    await canvas.setField('Fields', '{"greeting": "Hello {{ $json.name }}"}');
    await expect(canvas.box('Set')).toContainText('Sets greeting');
  });

  await test.step('add a Log box on its own; it is flagged until something feeds it', async () => {
    await canvas.addFromList('Log');
    await expect(canvas.box('Log')).toContainText('has nothing wired into it yet');
    await expect(canvas.problems).toHaveText('1 problem');
  });

  await test.step('wire Set into Log by dragging between their dots', async () => {
    await canvas.closePanel();
    await canvas.connect('Set', 'Log');

    await expect(canvas.wire('Set', 'Log')).toBeAttached();
    await expect(canvas.problems).toBeHidden();
  });

  await test.step('give Start some test data, and run', async () => {
    await canvas.openSettings('Start');
    await canvas.setField('Test input', '{"name": "world"}');
    await canvas.run();
    await canvas.waitForRunToFinish();

    for (const box of ['Start', 'Set', 'Log']) await expect(canvas.box(box)).toContainText('Done · 1 item');
    // Each wire's pill counts what went through it: one item on both wires.
    await expect(canvas.page.getByText('1 item', { exact: true })).toHaveCount(2);
    await expect(canvas.toast).toHaveText('Run finished.');
  });

  await test.step('the Set box shows exactly what it produced', async () => {
    await canvas.openSettings('Set');
    await canvas.settings.getByRole('tab', { name: 'Output' }).click();
    await expect(canvas.settings).toContainText('"greeting": "Hello world"');
  });

  await test.step('the run is kept in the history', async () => {
    const [run] = await api.runs(doc.id);
    expect(run?.status).toBe('succeeded');
  });
});
