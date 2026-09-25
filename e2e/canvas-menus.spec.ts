import { expect, test } from './support/fixtures.js';
import { greeterWorkflow } from './support/api.js';

test.describe('right-clicking the canvas', () => {
  test('offers to add a box, and puts the box where you clicked', async ({ page, api, canvas }) => {
    const doc = await api.save(greeterWorkflow(await api.createWorkflow('Add here')));
    await canvas.open(doc.id);

    const pane = (await canvas.pane.boundingBox())!;
    const spot = { x: 260, y: 520 };
    await canvas.rightClickCanvas(spot);
    await expect(canvas.menuItem('Add a box here')).toBeFocused();
    await canvas.menuItem('Add a box here').click();

    await expect(canvas.addPanel).toContainText('It goes where you right-clicked.');
    await canvas.addPanel.getByRole('textbox', { name: 'Search boxes' }).fill('Wait');
    await canvas.addPanel.getByRole('button', { name: /^Wait\b/ }).click();

    // The new box's title bar is centred on the spot that was clicked.
    const wait = (await canvas.box('Wait').boundingBox())!;
    expect(Math.abs(wait.x + wait.width / 2 - (pane.x + spot.x))).toBeLessThan(12);
    expect(Math.abs(wait.y + 17 - (pane.y + spot.y))).toBeLessThan(12);
    await expect(canvas.menu).toBeHidden();
    await expect(page.getByRole('group', { name: 'Wait', exact: true })).toBeVisible();
  });

  test('offers Tidy up', async ({ api, canvas, page }) => {
    const base = greeterWorkflow(await api.createWorkflow('Tidy from menu'));
    const place = { start: { x: 500, y: 420 }, greet: { x: -200, y: 200 }, note: { x: 150, y: 0 } };
    const doc = await api.save({ ...base, nodes: base.nodes.map((n) => ({ ...n, ui: { position: place[n.id as keyof typeof place] } })) });
    await canvas.open(doc.id);

    await canvas.rightClickCanvas();
    await canvas.menuItem('Tidy up').click();
    await canvas.expectSaved();

    const top = async (name: string) => (await canvas.box(name).boundingBox())!.y;
    expect(await top('Start')).toBeLessThan(await top('Greet'));
    expect(await top('Greet')).toBeLessThan(await top('Note'));
    await expect(page.getByRole('menu')).toBeHidden();
  });

  test('the menu works from the keyboard and closes with Escape', async ({ page, api, canvas }) => {
    const doc = await api.save(greeterWorkflow(await api.createWorkflow('Keyboard menu')));
    await canvas.open(doc.id);

    await canvas.rightClickCanvas();
    await page.keyboard.press('ArrowDown');
    await expect(canvas.menuItem('Tidy up')).toBeFocused();
    await page.keyboard.press('End');
    await expect(canvas.menuItem('Fit to screen')).toBeFocused();
    await page.keyboard.press('ArrowDown'); // wraps round
    await expect(canvas.menuItem('Add a box here')).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(canvas.menu).toBeHidden();
  });

  test('a wire can be deleted from its menu', async ({ api, canvas }) => {
    const doc = await api.save(greeterWorkflow(await api.createWorkflow('Cut a wire')));
    await canvas.open(doc.id);

    await canvas.rightClickWire('Start', 'Greet');
    await canvas.menuItem('Delete wire').click();

    await expect(canvas.wire('Start', 'Greet')).toHaveCount(0);
    await expect(canvas.wires).toHaveCount(1);
    await expect(canvas.box('Greet')).toContainText('has nothing wired into it yet');
  });
});

test.describe('turning a box', () => {
  test('moves its wires round the card and keeps its text upright', async ({ api, canvas }) => {
    const doc = await api.save(greeterWorkflow(await api.createWorkflow('Turn a box')));
    await canvas.open(doc.id);
    expect(await canvas.sideOf('Greet', 'Input')).toBe('top');
    expect(await canvas.sideOf('Greet', 'Output')).toBe('bottom');

    await canvas.rightClickBox('Greet');
    await canvas.menuItem('Rotate right').click();

    await expect.poll(() => canvas.sideOf('Greet', 'Input')).toBe('right');
    expect(await canvas.sideOf('Greet', 'Output')).toBe('left');
    // The card did not turn: it is still wider than tall, and so is its title.
    const card = (await canvas.box('Greet').boundingBox())!;
    const title = (await canvas.box('Greet').getByText('Greet', { exact: true }).first().boundingBox())!;
    expect(card.width).toBeGreaterThan(card.height);
    expect(title.width).toBeGreaterThan(title.height);
    // Wires stay attached through the turn.
    await expect(canvas.wire('Start', 'Greet')).toBeAttached();
    await expect(canvas.wire('Greet', 'Note')).toBeAttached();

    await canvas.expectSaved();
    expect((await api.getWorkflow(doc.id)).nodes.find((n) => n.id === 'greet')?.ui?.rotation).toBe(90);
  });

  test('R turns the selected box right, Shift+R turns it back', async ({ page, api, canvas }) => {
    const doc = await api.save(greeterWorkflow(await api.createWorkflow('Turn with keys')));
    await canvas.open(doc.id);
    await canvas.openSettings('Note');
    await canvas.closePanel();

    for (const expected of ['right', 'bottom', 'left', 'top'] as const) {
      await page.keyboard.press('r');
      await expect.poll(() => canvas.sideOf('Note', 'Input')).toBe(expected);
    }
    await page.keyboard.press('Shift+R');
    await expect.poll(() => canvas.sideOf('Note', 'Input')).toBe('left');
  });

  test('the settings panel says which way a box faces, and turns it', async ({ api, canvas }) => {
    const doc = await api.save(greeterWorkflow(await api.createWorkflow('Turn from settings')));
    await canvas.open(doc.id);
    await canvas.openSettings('Greet');
    const faces = canvas.settings.getByRole('group', { name: 'Faces' });
    await expect(faces).toContainText('In at the top, out at the bottom');

    await faces.getByRole('button', { name: 'Rotate left' }).click();

    await expect(faces).toContainText('In at the left, out at the right');
    await expect.poll(() => canvas.sideOf('Greet', 'Output')).toBe('right');
  });

  test('a box grown from a turned box continues in the same direction', async ({ api, canvas }) => {
    const base = greeterWorkflow(await api.createWorkflow('Keep going right'));
    const doc = await api.save({
      ...base,
      nodes: base.nodes.map((n) => (n.id === 'note' ? { ...n, ui: { ...n.ui, rotation: 270 as const } } : n)),
    });
    await canvas.open(doc.id);

    await canvas.addAfter('Note', 'Log');

    const note = (await canvas.box('Note').boundingBox())!;
    const log = (await canvas.box('Log').boundingBox())!;
    expect(log.x).toBeGreaterThan(note.x + note.width);
    expect(Math.abs(log.y - note.y)).toBeLessThan(4);
    expect(await canvas.sideOf('Log', 'Input')).toBe('left');
  });
});
