/**
 * E2E: the /sessions branch filter (Issue #4386). `/api/` is mocked in the
 * browser (same approach as sessions-composer-height-2598.spec.ts); no agent
 * process is involved.
 */
import { test, expect, type Page, type Route } from '@playwright/test';
import { mockStartPreview } from './fixtures/start-preview-helpers';

const row = (id: string, name: string, currentBranch: string) => ({
  id,
  name,
  path: `/tmp/${id}`,
  repositoryPath: '/tmp/e2e-4386-repo',
  repositoryName: 'e2e-repo',
  repositoryDisplayName: 'E2E Repo',
  selectedAgents: ['claude'],
  agentInstances: [{ id: 'claude', cliTool: 'claude', alias: 'claude', order: 0 }],
  cliToolId: 'claude',
  status: 'ready',
  sessionStatusByCli: { claude: { isRunning: false, isWaitingForResponse: false, isProcessing: false } },
  gitStatus: { currentBranch, initialBranch: currentBranch, isBranchMismatch: false, commitHash: 'e2e0000', isDirty: false },
});

const WORKTREES = [
  row('e2e-4386-a', 'feature/1-a', 'feature/1-a'),
  row('e2e-4386-b', 'main', 'main'),
  row('e2e-4386-c', 'renamed-wt', 'feature/3-c'),
];

/** A stopped instance: nothing on screen, nothing waiting. */
const IDLE_OUTPUT = {
  isRunning: false,
  cliToolId: 'claude',
  sessionStatus: 'idle',
  isGenerating: false,
  isPromptWaiting: false,
  content: '',
  fullOutput: '',
  realtimeSnippet: '',
  thinking: false,
};

const EMPTY_RELAYS = {
  owed: [],
  awaiting: [],
  open: [],
  counts: { pending: 0, delivered: 0, prompt: 0, expired: 0, cancelled: 0 },
};

const json = (route: Route, body: unknown) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

async function mockApi(page: Page) {
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const { pathname } = new URL(route.request().url());
      if (pathname.endsWith('/api/worktrees')) {
        return json(route, { worktrees: WORKTREES, repositories: [] });
      }
      // The tile view mounts a composer and a history pane per instance, which
      // read these. A bare `{}` breaks `/slash-commands` (useSlashCommands reads
      // `data.groups.flatMap`) and takes the whole page down to the error
      // boundary, so each is served in the shape the real route returns.
      const sub = pathname.match(/^\/api\/worktrees\/[^/]+(\/.*)$/)?.[1] ?? '';
      if (sub.startsWith('/slash-commands')) return json(route, { groups: [] });
      if (sub.startsWith('/messages')) return json(route, []);
      if (sub.startsWith('/current-output')) return json(route, IDLE_OUTPUT);
      if (pathname === '/api/relays') return json(route, EMPTY_RELAYS);
      if (pathname === '/api/sidebar/group-order') return json(route, { success: true, order: [] });
      return json(route, {});
    },
  );
  // The tile composer reads the start preview before a send (#4227); registered
  // after the catch-all so Playwright tries it first.
  await mockStartPreview(page);
}

test.use({ viewport: { width: 1440, height: 900 } });

test.describe('[#4386] sessions branch filter', () => {
  test.beforeEach(async ({ page }) => {
    await mockApi(page);
    await page.goto('/sessions');
    await expect(page.getByTestId('sessions-filter-button')).toBeVisible();
  });

  test('^feature/ keeps matching rows in list and tile', async ({ page }) => {
    await page.getByTestId('sessions-filter-button').click();
    await page.getByTestId('sessions-branch-filter').fill('^feature/');
    await page.keyboard.press('Escape');

    const list = page.getByTestId('sessions-list');
    await expect(list).toContainText('feature/1-a');
    await expect(list).toContainText('renamed-wt');
    await expect(list).not.toContainText('main');

    // The list/tile switch is a pair of aria-pressed toggle buttons
    // (SessionsViewModeSelector), not a radiogroup.
    const tileToggle = page.getByTestId('sessions-view-mode-tile');
    await tileToggle.click();
    await expect(tileToggle).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('session-tile-e2e-4386-a')).toBeVisible();
    await expect(page.getByTestId('session-tile-e2e-4386-c')).toBeVisible();
    await expect(page.getByTestId('session-tile-e2e-4386-b')).toHaveCount(0);
  });

  test('( shows an error and keeps every row', async ({ page }) => {
    await page.getByTestId('sessions-filter-button').click();
    await page.getByTestId('sessions-branch-filter').fill('(');
    await expect(page.getByTestId('sessions-branch-filter-error')).toBeVisible();
    await page.keyboard.press('Escape');
    const list = page.getByTestId('sessions-list');
    await expect(list).toContainText('feature/1-a');
    await expect(list).toContainText('main');
    await expect(list).toContainText('renamed-wt');
  });
});
