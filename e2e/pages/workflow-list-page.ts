import { expect, type Locator, type Page } from '@playwright/test';

/** Where the app opens: the list of workflows. */
export class WorkflowListPage {
  readonly heading: Locator;
  readonly newWorkflowButton: Locator;

  constructor(readonly page: Page) {
    this.heading = page.getByRole('heading', { name: 'Workflows', level: 1 });
    this.newWorkflowButton = page.getByRole('button', { name: 'New workflow' });
  }

  async open(): Promise<void> {
    await this.page.goto('/');
    await expect(this.heading).toBeVisible();
  }

  row(name: string): Locator {
    return this.page.getByRole('listitem').filter({ has: this.page.getByRole('button', { name, exact: true }) });
  }

  async openWorkflow(name: string): Promise<void> {
    await this.page.getByRole('button', { name, exact: true }).click();
  }
}
