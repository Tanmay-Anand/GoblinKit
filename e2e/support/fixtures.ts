import { test as base } from '@playwright/test';

import { CanvasPage } from '../pages/canvas-page.js';
import { WorkflowListPage } from '../pages/workflow-list-page.js';
import { GoblinApi } from './api.js';

/**
 * The fixtures every spec uses. Import `test` and `expect` from here, not
 * from @playwright/test, so each test gets:
 *
 *   api        arranges workflows over HTTP, and deletes them afterwards
 *   canvas     the canvas screen
 *   workflows  the workflow list
 */
export const test = base.extend<{ api: GoblinApi; canvas: CanvasPage; workflows: WorkflowListPage }>({
  api: async ({ request }, use) => {
    const api = new GoblinApi(request);
    await use(api);
    await api.cleanUp();
  },
  canvas: async ({ page }, use) => {
    await use(new CanvasPage(page));
  },
  workflows: async ({ page }, use) => {
    await use(new WorkflowListPage(page));
  },
});

export { expect } from '@playwright/test';
