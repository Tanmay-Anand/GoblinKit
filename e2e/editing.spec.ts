import { expect, test } from './support/fixtures.js';
import { greeterWorkflow } from './support/api.js';

test.describe('editing on the canvas', () => {
  test('undo takes a step back and redo brings it back', async ({ page, api, canvas }) => {
    const doc = await api.save(greeterWorkflow(await api.createWorkflow('Undo me')));
    await canvas.open(doc.id);

    await canvas.addAfter('Note', 'Wait');
    await expect(canvas.box('Wait')).toBeVisible();
    await canvas.pane.click({ position: { x: 40, y: 40 } });

    await page.keyboard.press('ControlOrMeta+Z');
    await expect(canvas.box('Wait')).toHaveCount(0);

    await page.keyboard.press('ControlOrMeta+Shift+Z');
    await expect(canvas.box('Wait')).toBeVisible();
    await expect(canvas.wire('Note', 'Wait')).toBeAttached();
  });

  test('Delete removes the selected box and every wire touching it', async ({ page, api, canvas }) => {
    const doc = await api.save(greeterWorkflow(await api.createWorkflow('Delete a box')));
    await canvas.open(doc.id);

    await canvas.openSettings('Greet');
    await page.keyboard.press('Delete');

    await expect(canvas.box('Greet')).toHaveCount(0);
    await expect(canvas.wires).toHaveCount(0);
    await canvas.expectSaved();
    expect((await api.getWorkflow(doc.id)).nodes.map((n) => n.id)).toEqual(['start', 'note']);
  });

  test('a box renamed in its settings is renamed on the canvas and on disk', async ({ api, canvas }) => {
    const doc = await api.save(greeterWorkflow(await api.createWorkflow('Rename a box')));
    await canvas.open(doc.id);

    await canvas.openSettings('Greet');
    await canvas.settings.getByRole('textbox', { name: 'Box name' }).fill('Say hello');

    await expect(canvas.box('Say hello')).toBeVisible();
    await expect(canvas.wire('Start', 'Say hello')).toBeAttached();
    await canvas.expectSaved();
    expect((await api.getWorkflow(doc.id)).nodes.find((n) => n.id === 'greet')?.label).toBe('Say hello');
  });

  test('Tidy up lays the flow out top to bottom', async ({ page, api, canvas }) => {
    const base = greeterWorkflow(await api.createWorkflow('Messy'));
    // Scrambled: Note on top, Start at the bottom.
    const place = { start: { x: 400, y: 500 }, greet: { x: -300, y: 250 }, note: { x: 200, y: 0 } };
    const doc = await api.save({
      ...base,
      nodes: base.nodes.map((n) => ({ ...n, ui: { position: place[n.id as keyof typeof place] } })),
    });
    await canvas.open(doc.id);

    await page.getByRole('banner').getByRole('button', { name: 'Tidy up' }).click();
    await canvas.expectSaved();

    const top = async (name: string) => (await canvas.box(name).boundingBox())!.y;
    const [start, greet, note] = [await top('Start'), await top('Greet'), await top('Note')];
    expect(start).toBeLessThan(greet);
    expect(greet).toBeLessThan(note);
  });
});
