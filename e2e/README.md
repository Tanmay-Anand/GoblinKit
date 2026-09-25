# End-to-end tests

The real canvas in a real browser, against the real local server. Nothing is
mocked: if these pass, a person can build and run a workflow.

```bash
pnpm test:e2e            # headless, in parallel
pnpm test:e2e:ui         # Playwright UI mode: watch, step through, pick locators
pnpm test:e2e:report     # open the last HTML report (traces, screenshots, video)
```

The suite starts its own API (port 8788) and web server (port 5174) over a
throwaway workspace in `e2e/.workspace/`, so it never touches your workflows
and runs fine next to `pnpm dev`. It drives the installed Google Chrome; on a
machine without it, run `pnpm exec playwright install chrome`.

## Layout

| Path | What it is |
|---|---|
| `support/fixtures.ts` | `test` and `expect` for every spec, with the `api`, `canvas` and `workflows` fixtures |
| `support/api.ts` | Arranges state over HTTP, and deletes what each test created |
| `pages/` | Page objects: the canvas and the workflow list, in the words a person would use |
| `*.spec.ts` | One file per area: building and running, watching a run, problems, editing, the list |

## Conventions

- **Import from `./support/fixtures.js`,** never straight from `@playwright/test`.
- **Arrange through the API, act through the UI.** A test about the Runs panel
  should not also rebuild a workflow by clicking; only the test whose subject
  is building does that. It keeps tests fast, and one broken button fails one
  test instead of twenty.
- **Every test owns its data.** It creates its own workflows, and the `api`
  fixture deletes them afterwards, so tests can run in any order and in
  parallel. Never rely on the seeded example.
- **Locate by role and accessible name** — `getByRole('group', { name: 'Set' })`
  for a box, `getByRole('button', { name: 'Run' })` — before labels or text,
  and CSS only where the page gives nothing better. A box you cannot find by
  name is a box a screen-reader user cannot find either: fix the app.
- **Assert with web-first expectations** (`await expect(locator).toHaveText(…)`),
  which wait and retry. No `waitForTimeout`, no manual polling of the page; for
  server state, `expect.poll`.
- **Assert a wire with `toBeAttached`,** not `toBeVisible`: a straight vertical
  wire's SVG group is zero pixels wide, which Playwright counts as hidden.
- **Name tests for behaviour** a person would notice ("a wire that would loop
  forever is refused"), and use `test.step` to narrate a long journey.

Before pushing a change to the canvas, run the suite repeated to catch flakes:

```bash
pnpm exec playwright test --repeat-each=5
```
