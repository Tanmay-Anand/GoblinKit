import { expect, type Locator, type Page } from '@playwright/test';

/** The Credentials screen: saved sign-in details, by name. */
export class CredentialsPage {
  readonly heading: Locator;
  readonly list: Locator;
  readonly form: Locator;

  constructor(readonly page: Page) {
    this.heading = page.getByRole('heading', { name: 'Credentials', level: 1 });
    this.list = page.getByRole('list', { name: 'Saved credentials' });
    this.form = page.getByRole('form');
  }

  async open(): Promise<void> {
    await this.page.goto('/#/credentials');
    await expect(this.heading).toBeVisible();
  }

  row(name: string): Locator {
    return this.list.getByRole('listitem').filter({ hasText: name });
  }

  /** Fill in "Add a credential" as a person would: kind, name, then each value by its label. */
  async add(kind: string, name: string, values: Record<string, string>): Promise<void> {
    await this.page.getByRole('button', { name: 'Add a credential' }).click();
    await this.form.getByLabel('Kind').selectOption({ label: kind });
    await this.form.getByLabel('Name', { exact: true }).fill(name);
    // By label, anchored: a secret field is a password input, which has no
    // textbox role, and a required one's label ends in an asterisk.
    for (const [label, value] of Object.entries(values)) await this.form.getByLabel(new RegExp(`^${escape(label)}\\*?$`)).fill(value);
    await this.form.getByRole('button', { name: 'Save credential' }).click();
    await expect(this.row(name)).toBeVisible();
  }
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
