import type { WorkflowDocument } from '../packages/spec/src/index.js';
import { expect, test } from './support/fixtures.js';
import type { GoblinApi } from './support/api.js';

/** Webhook → Set a greeting from the caller's body, answering with the result. */
async function hookGreeter(api: GoblinApi): Promise<WorkflowDocument> {
  const doc = await api.createWorkflow('Hook greeter');
  return api.save({
    ...doc,
    nodes: [
      {
        id: 'hook',
        type: 'core.trigger.webhook',
        typeVersion: 1,
        label: 'Incoming call',
        config: { method: 'POST', respond: 'when the run finishes', testInput: { body: { name: 'test' } } },
        ui: { position: { x: 0, y: 0 } },
      },
      {
        id: 'greet',
        type: 'core.transform.set',
        typeVersion: 1,
        label: 'Greet',
        config: { values: { greeting: 'Hello {{ $json.body.name }}' }, keepInput: false },
        ui: { position: { x: 0, y: 220 } },
      },
    ],
    edges: [{ id: 'e1', from: { node: 'hook', port: 'main' }, to: { node: 'greet', port: 'main' } }],
  });
}

test.describe('workflows that start by themselves', () => {
  test('Activate explains itself on a workflow only Run can start', async ({ page, api, canvas }) => {
    const doc = await api.createWorkflow('Manual only');
    await canvas.open(doc.id);

    await page.getByRole('button', { name: 'Activate' }).click();

    await expect(canvas.toast).toContainText('Add a Schedule or Webhook box first');
    await expect(page.getByRole('banner').getByText('Draft', { exact: true })).toBeVisible();
  });

  test('a switched-on webhook runs when another program calls it, and stops when switched off', async ({ page, api, canvas }) => {
    const doc = await hookGreeter(api);
    await canvas.open(doc.id);
    await expect(canvas.box('Incoming call')).toContainText('Starts on POST requests to its URL');

    await test.step('its settings show the URL to call', async () => {
      await canvas.openSettings('Incoming call');
      const url = canvas.settings.getByRole('textbox', { name: 'URL to call' });
      await expect(url).toHaveValue(new RegExp(`/hooks/${doc.id}/hook$`));
      await expect(canvas.settings).toContainText('Answers only while the workflow is active');
    });

    await test.step('Activate switches it on, and the canvas says what that means', async () => {
      await page.getByRole('button', { name: 'Activate' }).click();
      await expect(page.getByRole('banner').getByText('Active', { exact: true })).toBeVisible();
      await expect(page.getByText(/Starts by itself only while GoblinKit is open/)).toBeVisible();
      await expect(canvas.box('Incoming call')).toContainText('Listening');
    });

    await test.step('a call to the URL runs the workflow and gets its result back', async () => {
      const { url } = (await api.activation(doc.id)).triggers[0]!;
      const answer = await api.callHook(url!, { name: 'scraper' });
      expect(answer).toEqual({ status: 200, body: { greeting: 'Hello scraper' } });

      await page.getByRole('banner').getByRole('button', { name: 'Runs' }).click();
      await expect(canvas.runsPanel.getByRole('listitem').first()).toContainText('by a webhook call');
    });

    await test.step('Deactivate switches it off, and the URL stops answering', async () => {
      await page.getByRole('button', { name: 'Deactivate' }).click();
      await expect(page.getByRole('banner').getByText('Draft', { exact: true })).toBeVisible();
      const { url } = (await api.activation(doc.id)).triggers[0]!;
      expect((await api.callHook(url!, {})).status).toBe(404);
    });
  });

  test('a schedule shows only the settings its Repeat needs, and when it runs next once active', async ({ page, api, canvas }) => {
    const doc = await api.createWorkflow('Every morning');
    await canvas.open(doc.id);
    await canvas.addFromList('Schedule');
    const repeat = canvas.settings.getByRole('combobox', { name: 'Repeat' });

    await expect(repeat).toHaveValue('minutes');
    await expect(canvas.settings.getByRole('spinbutton', { name: 'Every' })).toBeVisible();
    await expect(canvas.settings.getByRole('textbox', { name: 'At' })).toHaveCount(0);

    await repeat.selectOption('day');
    await expect(canvas.settings.getByRole('textbox', { name: 'At' })).toHaveValue('09:00');
    await expect(canvas.settings.getByRole('spinbutton', { name: 'Every' })).toHaveCount(0);
    await expect(canvas.box('Schedule')).toContainText('Every day at 09:00');

    // Give it something to do, then switch it on.
    await canvas.addAfter('Schedule', 'Log');
    await page.getByRole('button', { name: 'Activate' }).click();

    await expect(canvas.box('Schedule')).toContainText(/Next run/);
    await expect(page.getByText(/Schedule: every day at 09:00, next at/)).toBeVisible();
  });

  test('a cron rule that cannot work is caught before anything is switched on', async ({ page, api, canvas }) => {
    const doc = await api.createWorkflow('Bad cron');
    await canvas.open(doc.id);
    await canvas.addFromList('Schedule');
    await canvas.settings.getByRole('combobox', { name: 'Repeat' }).selectOption('cron');
    await canvas.setField('Cron rule', '99 * * * *');

    await expect(canvas.box('Schedule')).toContainText("outside the minute field's range");
    await page.getByRole('button', { name: 'Activate' }).click();
    await expect(canvas.toast).toContainText("outside the minute field's range");
    expect((await api.activation(doc.id)).active).toBe(false);
  });

  test('the workflow list marks which workflows are switched on', async ({ page, api, workflows }) => {
    // A name only this test uses: other tests running alongside create "Hook greeter"s too.
    const base = await hookGreeter(api);
    const doc = await api.save({ ...base, name: `Listed ${base.id}` });
    await page.request.put(`/api/workflows/${doc.id}/activation`, { data: { active: true } });

    await workflows.open();
    await expect(workflows.row(doc.name)).toContainText('Active');
  });
});
