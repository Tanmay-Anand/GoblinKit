import { expect, type Locator, type Page } from '@playwright/test';

/**
 * The canvas screen, in the words a person would use: boxes, wires, the
 * settings panel, Run.
 *
 * Locators are by role and accessible name wherever the app gives one —
 * which is also a standing check that the canvas stays usable with a screen
 * reader. The one exception is dragging a wire, which is pointer work by
 * nature; it is done here, once, so no test has to know how.
 */
export class CanvasPage {
  readonly runButton: Locator;
  readonly workflowName: Locator;
  readonly addPanel: Locator;
  readonly settings: Locator;
  readonly runsPanel: Locator;
  readonly toast: Locator;
  readonly problems: Locator;
  readonly pane: Locator;

  constructor(readonly page: Page) {
    this.runButton = page.getByRole('button', { name: /^(Run|Running)$/ });
    this.workflowName = page.getByRole('textbox', { name: 'Workflow name' });
    this.addPanel = page.getByRole('complementary', { name: 'Add a box' });
    this.settings = page.getByRole('complementary', { name: /^Settings for / });
    this.runsPanel = page.getByRole('complementary', { name: 'Runs' });
    this.toast = page.getByRole('status');
    this.problems = page.getByRole('button', { name: /\d+ problems?/ });
    // React Flow's own id for its pane: there is no user-facing name for "empty canvas".
    this.pane = page.locator('.react-flow__pane');
  }

  async open(workflowId: string): Promise<void> {
    await this.page.goto(`/#/w/${workflowId}`);
    await expect(this.runButton).toBeVisible();
  }

  box(name: string): Locator {
    return this.page.getByRole('group', { name, exact: true });
  }

  /**
   * A wire, by the boxes it joins. Assert it with toBeAttached, not
   * toBeVisible: a straight vertical wire's SVG group is zero pixels wide,
   * which Playwright counts as hidden even though it is plainly on screen.
   */
  wire(from: string, to: string): Locator {
    return this.page.getByRole('group', { name: `Wire from ${from} to ${to}`, exact: true });
  }

  get wires(): Locator {
    return this.page.getByRole('group', { name: /^Wire from / });
  }

  /** Grow the flow from a box with its "+": the new box lands below and is wired in. */
  async addAfter(boxName: string, boxTitle: string): Promise<void> {
    await this.box(boxName).getByRole('button', { name: 'Add a box after this one' }).click();
    await this.pickFromPanel(boxTitle);
  }

  /** Add a box from the box list, unconnected. */
  async addFromList(boxTitle: string): Promise<void> {
    await this.page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Add a box' }).click();
    await this.pickFromPanel(boxTitle);
  }

  private async pickFromPanel(boxTitle: string): Promise<void> {
    await expect(this.addPanel).toBeVisible();
    await this.addPanel.getByRole('textbox', { name: 'Search boxes' }).fill(boxTitle);
    await this.addPanel.getByRole('button', { name: new RegExp(`^${escape(boxTitle)}\\b`) }).click();
    // Adding a box opens its settings, which is what a person does next.
    await expect(this.settings).toBeVisible();
  }

  /**
   * Draw a wire by dragging from one box's output dot to another's input dot.
   *
   * Moved in steps, as a hand would: React Flow only starts a connection
   * after the pointer travels, and a single jump to the target is not a drag.
   */
  async connect(from: string, to: string, options: { output?: string; input?: string } = {}): Promise<void> {
    // Fit the flow on screen first, as a person scrolls the target into view.
    // A dot near the edge of the canvas makes React Flow pan while the wire
    // is dragged, which slides the target out from under the pointer.
    await this.page.getByRole('button', { name: 'Fit View' }).click();
    const source = this.box(from).getByLabel(options.output ? `Output: ${options.output}` : 'Output', { exact: true });
    const target = this.box(to).getByLabel(options.input ? `Input: ${options.input}` : 'Input', { exact: true });
    const [a, b] = [await centre(source), await centre(target)];
    await this.page.mouse.move(a.x, a.y);
    await this.page.mouse.down();
    await this.page.mouse.move(b.x, b.y, { steps: 12 });
    await this.page.mouse.up();
  }

  async openSettings(boxName: string): Promise<void> {
    // The title bar: clicking the body could land on a button inside it.
    await this.box(boxName).getByText(boxName, { exact: true }).first().click();
    await expect(this.settings).toBeVisible();
  }

  /**
   * Fill a text setting by its accessible name — exact, so "Fields" does not
   * also match "Keep input fields", and by role, so a required field's
   * decorative asterisk is not part of the name it is found by.
   */
  async setField(label: string, value: string): Promise<void> {
    await this.settings.getByRole('textbox', { name: label, exact: true }).fill(value);
  }

  async closePanel(): Promise<void> {
    await this.page.getByRole('complementary').getByRole('button', { name: 'Close' }).click();
  }

  // --- right-click menus -------------------------------------------------

  get menu(): Locator {
    return this.page.getByRole('menu');
  }

  menuItem(name: string | RegExp): Locator {
    return this.menu.getByRole('menuitem', { name });
  }

  /** Right-click empty canvas, `at` pixels from the canvas's top-left corner. */
  async rightClickCanvas(at: { x: number; y: number } = { x: 60, y: 60 }): Promise<void> {
    await this.pane.click({ button: 'right', position: at });
    await expect(this.menu).toBeVisible();
  }

  async rightClickBox(name: string): Promise<void> {
    await this.box(name).getByText(name, { exact: true }).first().click({ button: 'right' });
    await expect(this.menu).toBeVisible();
  }

  /**
   * Right-click a wire halfway along. Wires are thin SVG paths with no box of
   * their own to aim at, so this aims between the two dots the wire joins.
   */
  async rightClickWire(from: string, to: string): Promise<void> {
    const a = await centre(this.box(from).getByLabel('Output', { exact: true }));
    const b = await centre(this.box(to).getByLabel('Input', { exact: true }));
    await this.page.mouse.click((a.x + b.x) / 2, (a.y + b.y) / 2, { button: 'right' });
    await expect(this.menu).toBeVisible();
  }

  /** Which edge of its box a dot sits on: how a turned box is told apart. */
  async sideOf(boxName: string, dot: 'Input' | 'Output'): Promise<'top' | 'right' | 'bottom' | 'left'> {
    const box = (await this.box(boxName).boundingBox())!;
    const { x, y } = await centre(this.box(boxName).getByLabel(dot, { exact: true }));
    const gaps = {
      top: Math.abs(y - box.y),
      bottom: Math.abs(y - (box.y + box.height)),
      left: Math.abs(x - box.x),
      right: Math.abs(x - (box.x + box.width)),
    };
    return (Object.entries(gaps) as [keyof typeof gaps, number][]).sort((p, q) => p[1] - q[1])[0]![0];
  }

  async run(): Promise<void> {
    await this.runButton.click();
  }

  /** Wait until the last run is over and the button is ready again. */
  async waitForRunToFinish(): Promise<void> {
    await expect(this.runButton).toHaveAccessibleName('Run');
  }

  async expectSaved(): Promise<void> {
    await expect(this.page.getByText('Saved', { exact: true })).toBeVisible();
  }
}

async function centre(locator: Locator): Promise<{ x: number; y: number }> {
  const box = await locator.boundingBox();
  if (!box) throw new Error(`Not on screen: ${locator.toString()}`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
