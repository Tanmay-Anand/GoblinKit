import type { WorkflowDocument } from '../packages/spec/src/index.js';
import { expect, test } from './support/fixtures.js';
import type { GoblinApi } from './support/api.js';

/** The order-triage example, with an order that takes the high-value branch and has two lines. */
async function triage(api: GoblinApi): Promise<WorkflowDocument> {
  const doc = await api.createFromExample('order-triage.json');
  return api.save({
    ...doc,
    nodes: doc.nodes.map((n) =>
      n.type === 'core.trigger.manual'
        ? {
            ...n,
            config: {
              testInput: {
                total: 250,
                lines: [
                  { sku: 'A-1140', qty: 2, price: 30 },
                  { sku: 'B-0072', qty: 1, price: 190 },
                ],
              },
            },
          }
        : n,
    ),
  });
}

test.describe('watching a run', () => {
  test('the canvas shows the branch taken, the branch skipped, and each loop pass', async ({ api, canvas }) => {
    const doc = await triage(api);
    await canvas.open(doc.id);

    await canvas.run();
    await canvas.waitForRunToFinish();

    await expect(canvas.box('Flag for review')).toContainText('Done · 1 item');
    await expect(canvas.box('Auto-approve')).toContainText('Skipped');
    await expect(canvas.box('Each line item')).toContainText('2 passes');
    await expect(canvas.box('Price the line')).toContainText('Done · 2 items · 2 passes');
    await expect(canvas.box('End loop')).toContainText('Done · 2 passes');
    await expect(canvas.box('Summarise')).toContainText('Done · 2 items');
  });

  test('the Runs panel sums the run up and shows its result', async ({ page, api, canvas }) => {
    const doc = await triage(api);
    await canvas.open(doc.id);
    await canvas.run();
    await canvas.waitForRunToFinish();

    await page.getByRole('banner').getByRole('button', { name: 'Runs' }).click();

    await expect(canvas.runsPanel).toContainText('Succeeded');
    await expect(canvas.runsPanel).toContainText('"lineTotal": 60');
    await expect(canvas.runsPanel).toContainText('"lineTotal": 190');
    await expect(canvas.runsPanel).toContainText('priced 2 lines');
    await expect(canvas.runsPanel.getByRole('listitem')).toHaveCount(1 + 1); // one log line, one history row
  });

  test('a past run can be reopened, and Back to editing clears it', async ({ page, api, canvas }) => {
    const doc = await triage(api);
    await api.runToEnd(doc.id);
    await canvas.open(doc.id);
    await expect(canvas.box('Summarise')).not.toContainText('Done');

    await page.getByRole('banner').getByRole('button', { name: 'Runs' }).click();
    await canvas.runsPanel.getByRole('listitem').getByRole('button').first().click();

    await expect(page.getByText(/Showing a past run from/)).toBeVisible();
    await expect(canvas.box('Summarise')).toContainText('Done · 2 items');

    await page.getByRole('button', { name: 'Back to editing' }).first().click();
    await expect(page.getByText(/Showing a past run from/)).toBeHidden();
    await expect(canvas.box('Summarise')).not.toContainText('Done');
  });
});
