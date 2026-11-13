/**
 * E2E: the decision screen chosen repository → branch, at a PC's width (Issue #4355 PR2,
 * design `docs/design/mem-decisions-ux-4355.md` §3.1・§3.2・§7).
 *
 * What the component tests cannot show: the real route (`/repositories/:id/mem/decisions`)
 * wires the two selects and the panel, moving between repositories and branches keeps the
 * URL's shape (I4), and the count of the decisions awaiting approval goes down after the
 * approval made with this PR's steps. Nothing scrolls sideways.
 *
 * The decision API is stubbed per browser context (as `mem-ui-4227.spec.ts` does): one
 * store holds a branch with mem `on` and one decision (with a quote and a destination), so
 * nothing reaches the server's database, gh or a worktree. The server's own answers are
 * fixed in the unit tables (`tests/unit/lib/promote/decision-branches-4355.test.ts`). Two
 * repositories share the branch's name, so a branch list read for the other repository
 * would show (B also has a branch of its own). The branch select shows names only; the one
 * count awaiting approval is the panel's list's (5-2b, PM's disposal). `?item=` is not in PR2. No default layout or width is assumed beyond the viewport set here, and no header
 * tool is read.
 */

import { test, expect, type BrowserContext, type Page, type Route } from '@playwright/test';

const REPO_A = 'repo-e2e-4355-a';
const REPO_B = 'repo-e2e-4355-b';
const BRANCH = 'feat/e2e-4355';
const ITEM = 'dec-e2e-4355';
const WT = 'wt-e2e-4355';
/**
 * A client navigation (router.push) on the dev server fetches the route's RSC payload, which
 * took over the default 5 s under load (the URL stayed on the earlier repository); the wait
 * is longer, the assertion is the same.
 */
const NAVIGATION_TIMEOUT_MS = 30_000;

interface Store {
  /** The decision's state in repository A. */
  state: 'open' | 'recorded';
  writes: Array<{ url: string; mark: string | null }>;
}

const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

function decisionView(state: string) {
  return {
    id: ITEM,
    kind: 'decision',
    state,
    text: 'e2e: 方針を A にする',
    closeWhen: null,
    promoteTo: 'issue:#1',
    quote: '方針は A',
    quoteAt: '2026-11-13T00:00:00.000Z',
    evidence: [],
    closeNote: null,
    owner: { repositoryId: REPO_A, branch: BRANCH, worktreeId: WT, worktreeIncarnation: 'wi', instanceId: 'claude', cliToolId: 'claude', incarnation: 'ii', sessionGeneration: null },
    createdBy: 'agent',
    updatedBy: 'agent',
    version: state === 'open' ? 1 : 2,
    createdAt: '2026-11-13T00:00:00.000Z',
    updatedAt: '2026-11-13T00:00:00.000Z',
    closedAt: null,
    closeReason: null,
    stale: false,
    frozen: false,
  };
}

const countsOf = (store: Store) => ({ mode: 'on', approvable: true, open: store.state === 'open' ? 1 : 0, recorded: store.state === 'recorded' ? 1 : 0 });

async function stubDecisions(context: BrowserContext): Promise<Store> {
  const store: Store = { state: 'open', writes: [] };
  await context.route(
    (url) => url.pathname === '/api/repositories' || url.pathname.startsWith('/api/repositories/repo-e2e-4355-'),
    (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const method = request.method();
      if (url.pathname === '/api/repositories') {
        return json(route, 200, {
          success: true,
          repositories: [
            { id: REPO_A, name: 'repo-a', displayName: null, path: '/e2e/a', enabled: true, visible: true, worktreeCount: 1, duplicateOf: [] },
            { id: REPO_B, name: 'repo-b', displayName: null, path: '/e2e/b', enabled: true, visible: true, worktreeCount: 1, duplicateOf: [] },
          ],
        });
      }
      if (method !== 'GET') store.writes.push({ url: url.pathname, mark: request.headers()['x-commandmate-client'] ?? null });
      if (url.pathname === `/api/repositories/${REPO_B}/mem/decisions/branches`) {
        // Repository B has a branch of the same name with other counts, and one of its own (never shown for A).
        return json(route, 200, {
          ok: true,
          branches: [
            { branch: BRANCH, mode: 'on', approvable: true, open: 5, recorded: 0 },
            { branch: 'only/in-b', mode: 'on', approvable: true, open: 2, recorded: 0 },
          ],
        });
      }
      if (url.pathname === `/api/repositories/${REPO_A}/mem/decisions/branches`) {
        return json(route, 200, { ok: true, branches: [{ branch: BRANCH, ...countsOf(store) }] });
      }
      if (url.pathname === `/api/repositories/${REPO_A}/mem/decisions` && method === 'GET') {
        return json(route, 200, {
          ok: true,
          mode: 'on',
          branch: BRANCH,
          counts: countsOf(store),
          decisions: [{ item: decisionView(store.state), unreflected: store.state === 'recorded', operations: [] }],
          unresolved: [],
          worktrees: [{ id: WT, path: '/e2e/a', name: 'wt-a', branch: BRANCH }],
        });
      }
      if (request.headers()['x-commandmate-client'] !== 'screen') return json(route, 403, { ok: false, code: 'screen_only' });
      if (url.pathname.endsWith(`/${ITEM}/preview`)) {
        return json(route, 201, {
          ok: true,
          preview: {
            id: 'p-e2e',
            operationId: 'op-e2e',
            itemId: ITEM,
            itemVersion: 1,
            destination: { kind: 'issue_comment', ref: 'issue', host: 'github.com', owner: 'o', repo: 'r', number: 1 },
            baseFingerprint: 'b',
            body: '<!-- commandmate-promote:op=op-e2e -->\n方針を A にする',
            bodySha256: 's',
            effect: 'spec',
            quoteOrigin: 'human',
            invisibleReplaced: false,
            acknowledgedOperationIds: [],
            poster: { id: 1, login: 'e2e' },
            createdAt: '2026-11-13T00:00:00.000Z',
            expiresAt: '2026-11-13T00:30:00.000Z',
          },
        });
      }
      if (url.pathname.endsWith(`/${ITEM}/approve`)) {
        store.state = 'recorded';
        return json(route, 200, { ok: true, operation: { id: 'op-e2e', state: 'succeeded' }, item: decisionView('recorded') });
      }
      return json(route, 404, { ok: false, code: 'not_found' });
    }
  );
  return store;
}

/** No sideways scroll on the page (design §7). */
async function expectNoSidewaysScroll(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
}

test.describe('decision screen: repository → branch (PC)', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('chooses the repository then the branch, approves with this PR’s steps, and the awaiting count goes down', async ({ context, page }) => {
    const store = await stubDecisions(context);
    await page.goto(`/repositories/${REPO_B}/mem/decisions`);

    const repositorySelect = page.getByTestId('decision-repository-select');
    await expect(repositorySelect).toHaveValue(REPO_B);
    // Both repositories listed: the page is hydrated and has read /api/repositories (the server's
    // HTML already shows the chosen one, and a choice made before hydration is lost).
    await expect(repositorySelect.locator('option')).toHaveCount(2);
    await expectNoSidewaysScroll(page);

    // 1. The repository: the branch is not carried over.
    await repositorySelect.selectOption(REPO_A);
    await expect(page).toHaveURL(new RegExp(`/repositories/${REPO_A}/mem/decisions$`), { timeout: NAVIGATION_TIMEOUT_MS });
    const branchSelect = page.getByTestId('decision-branch-select');
    const option = branchSelect.locator(`option[value="${BRANCH}"]`);
    // Repository A's branches only (B's own branch is not there); the row is the name only.
    await expect(option).toHaveText(BRANCH);
    await expect(branchSelect.locator('option[value="only/in-b"]')).toHaveCount(0);
    await expectNoSidewaysScroll(page);

    // 2. The branch (I4: the URL keeps `?branch=`).
    await branchSelect.selectOption(BRANCH);
    await expect(page).toHaveURL(new RegExp(`/repositories/${REPO_A}/mem/decisions\\?branch=${encodeURIComponent(BRANCH)}$`), { timeout: NAVIGATION_TIMEOUT_MS });
    const counts = page.getByTestId('decision-counts');
    await expect(counts).toHaveAttribute('data-open', '1');
    await expectNoSidewaysScroll(page);

    // 3. This PR's steps: open the item, check the quote, make the diff, approve.
    await page.getByTestId(`decision-select-${ITEM}`).click();
    await page.getByTestId(`decision-quote-confirmed-${ITEM}`).check();
    await page.getByTestId(`decision-make-preview-${ITEM}`).click();
    await expect(page.getByTestId(`decision-preview-${ITEM}`)).toBeVisible();
    await expectNoSidewaysScroll(page);
    await page.getByTestId(`decision-approve-${ITEM}`).click();

    // 4. The count goes down in the one count line (the select keeps the name only); the recorded one is folded.
    await expect(counts).toHaveAttribute('data-open', '0');
    await expect(counts).toHaveAttribute('data-recorded', '1');
    await expect(option).toHaveText(BRANCH);
    await expect(page.getByTestId('decision-fold-recorded')).not.toHaveAttribute('open', /.*/);
    await expectNoSidewaysScroll(page);

    expect(store.writes.map((write) => [write.url.split('/').pop(), write.mark])).toEqual([
      ['preview', 'screen'],
      ['approve', 'screen'],
    ]);
  });

  test('an old link (`?branch=`) opens with the repository and the branch chosen', async ({ context, page }) => {
    await stubDecisions(context);
    await page.goto(`/repositories/${REPO_A}/mem/decisions?branch=${encodeURIComponent(BRANCH)}`);
    await expect(page.getByTestId('decision-repository-select')).toHaveValue(REPO_A);
    await expect(page.getByTestId('decision-branch-select')).toHaveValue(BRANCH);
    await expect(page.getByTestId('decision-counts')).toHaveAttribute('data-open', '1');
    await expectNoSidewaysScroll(page);
  });
});
