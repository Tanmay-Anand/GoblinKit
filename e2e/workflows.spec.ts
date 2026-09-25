import { expect, test } from './support/fixtures.js';

test.describe('the workflow list', () => {
  test('a new workflow opens on a canvas with a Start box', async ({ page, workflows, canvas, api }) => {
    await workflows.open();
    await workflows.newWorkflowButton.click();

    await expect(page).toHaveURL(/#\/w\/wf_/);
    api.adopt(page.url().split('/w/')[1]!);
    await expect(canvas.workflowName).toHaveValue('Untitled workflow');
    await expect(canvas.box('Start')).toBeVisible();
  });

  test('opening a workflow from the list shows its boxes', async ({ workflows, canvas, api }) => {
    const doc = await api.createFromExample('order-triage.json');
    await api.save({ ...doc, name: `Triage ${doc.id}` });

    await workflows.open();
    await workflows.openWorkflow(`Triage ${doc.id}`);

    await expect(canvas.workflowName).toHaveValue(`Triage ${doc.id}`);
    await expect(canvas.box('High value?')).toBeVisible();
    await expect(canvas.wires).toHaveCount(9);
  });

  test('a renamed workflow keeps its name after a reload', async ({ page, canvas, api }) => {
    const doc = await api.createWorkflow('Before');
    await canvas.open(doc.id);

    await canvas.workflowName.fill('Weekly report');
    await canvas.expectSaved();
    await page.reload();

    await expect(canvas.workflowName).toHaveValue('Weekly report');
  });

  test('deleting asks first, and Keep keeps it', async ({ workflows, api }) => {
    const doc = await api.createWorkflow(`Throwaway ${Date.now()}`);
    await workflows.open();
    const row = workflows.row(doc.name);

    await row.getByRole('button', { name: `Delete ${doc.name}` }).click();
    await expect(row).toContainText('Delete for good?');
    await row.getByRole('button', { name: 'Keep' }).click();
    await expect(row).toBeVisible();

    await row.getByRole('button', { name: `Delete ${doc.name}` }).click();
    await row.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(row).toHaveCount(0);
  });
});
