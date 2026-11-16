/**
 * E2E: the /sessions role filter (Issue #4389). `/api/` is mocked in the browser
 * (same approach as sessions-filter-4386.spec.ts); no agent process is involved.
 *
 * Choose a role → only worktrees with an instance of that role stay → a tile's
 * instance switch offers only the matching instances → a list row opens the
 * worktree with `?instance=` of the first match.
 */
import { test, expect, type Page, type Route } from '@playwright/test';
import { mockStartPreview } from './fixtures/start-preview-helpers';

const idle = { isRunning: false, isWaitingForResponse: false, isProcessing: false };

const row = (id: string, name: string) => ({
  id,
  name,
  path: `/tmp/${id}`,
  repositoryPath: '/tmp/e2e-4389-repo',
  repositoryName: 'e2e-repo',
  repositoryDisplayName: 'E2E Repo',
  selectedAgents: ['claude', 'codex'],
  agentInstances: [
    { id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 },
    { id: 'codex', cliTool: 'codex', alias: 'Codex', order: 1 },
    { id: 'codex-2', cliTool: 'codex', alias: 'Codex 2', order: 2 },
  ],
  cliToolId: 'claude',
  status: 'ready',
  sessionStatusByCli: { claude: idle, codex: idle },
  sessionStatusByInstance: { claude: idle, codex: idle, 'codex-2': idle },
  gitStatus: { currentBranch: name, initialBranch: name, isBranchMismatch: false, commitHash: 'e2e0000', isDirty: false },
});

const WORKTREES = [
  row('e2e-4389-a', 'feature/1-a'),
  row('e2e-4389-b', 'feature/2-b'),
  row('e2e-4389-c', 'feature/3-c'),
];

const role = (roleId: string, roleName: string) => ({ kind: 'role', roleId, roleName, basis: 'launched' });

const ROLES = {
  success: true,
  roles: [
    { id: 'review', name: 'Reviewer', bodyVersion: 1, bodyFingerprint: 'x', bodyBytes: 1, createdAt: 0, updatedAt: 0 },
    { id: 'impl', name: 'Implementer', bodyVersion: 1, bodyFingerprint: 'y', bodyBytes: 1, createdAt: 0, updatedAt: 0 },
  ],
};

const SESSION_ROLES = {
  success: true,
  roleByWorktree: {
    'e2e-4389-a': { claude: role('impl', 'Implementer'), codex: role('review', 'Reviewer'), 'codex-2': role('review', 'Reviewer') },
    'e2e-4389-b': { claude: role('impl', 'Implementer'), codex: { kind: 'none' }, 'codex-2': { kind: 'ambiguous' } },
    'e2e-4389-c': { claude: { kind: 'none' }, codex: role('review', 'Reviewer'), 'codex-2': { kind: 'none' } },
  },
};

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
      if (pathname === '/api/roles') return json(route, ROLES);
      if (pathname === '/api/sessions/roles') return json(route, SESSION_ROLES);
      if (pathname === '/api/relays') return json(route, EMPTY_RELAYS);
      if (pathname === '/api/sidebar/group-order') return json(route, { success: true, order: [] });
      // The worktree screen: the detail answer carries the roster (same shape as
      // composer-height-helpers.ts), so `?instance=` can be applied to it.
      const detail = pathname.match(/^\/api\/worktrees\/([^/]+)(\/.*)?$/);
      if (detail) {
        const id = decodeURIComponent(detail[1]);
        const sub = detail[2] ?? '';
        if (sub === '') return json(route, WORKTREES.find((w) => w.id === id) ?? WORKTREES[0]);
        if (sub.startsWith('/slash-commands')) return json(route, { groups: [] });
        if (sub.startsWith('/messages')) return json(route, []);
        if (sub.startsWith('/current-output')) return json(route, IDLE_OUTPUT);
        if (sub.startsWith('/special-keys')) return json(route, { success: true });
        if (sub.startsWith('/memos')) return json(route, []);
        if (sub.startsWith('/execution-logs')) return json(route, []);
        if (sub.startsWith('/schedules')) return json(route, []);
        if (sub.startsWith('/tree')) return json(route, { items: [] });
        if (sub.startsWith('/tasks')) return json(route, { tasks: [] });
        if (sub.startsWith('/verify/runs')) return json(route, { runs: [] });
        if (sub.startsWith('/verify/config')) return json(route, { exists: false, gates: [] });
        return json(route, {});
      }
      if (pathname.includes('/repositories')) return json(route, []);
      if (pathname.includes('/tools')) return json(route, []);
      return json(route, {});
    },
  );
  await mockStartPreview(page);
}

test.use({ viewport: { width: 1440, height: 900 } });

test.describe('[#4389] sessions role filter', () => {
  test.beforeEach(async ({ page }) => {
    await mockApi(page);
    await page.goto('/sessions');
    await expect(page.getByTestId('sessions-filter-button')).toBeVisible();
  });

  test('a role keeps matching worktrees, narrows the tile switch, and the row opens the instance', async ({ page }) => {
    // Unfiltered: plain links, every row.
    await expect(page.getByTestId('session-item-e2e-4389-b')).toHaveAttribute('href', '/worktrees/e2e-4389-b');

    await page.getByTestId('sessions-filter-button').click();
    await page.getByTestId('sessions-role-filter-role-review').check();
    await page.keyboard.press('Escape');

    await expect(page.getByTestId('sessions-filter-count')).toHaveText('1');
    await expect(page.getByTestId('session-item-e2e-4389-a')).toBeVisible();
    await expect(page.getByTestId('session-item-e2e-4389-c')).toBeVisible();
    await expect(page.getByTestId('session-item-e2e-4389-b')).toHaveCount(0);
    await expect(page.getByTestId('session-roles-e2e-4389-a')).toContainText('Codex: Reviewer');
    await expect(page.getByTestId('session-item-e2e-4389-a')).toHaveAttribute(
      'href',
      '/worktrees/e2e-4389-a?instance=codex',
    );
    await expect(page.getByTestId('session-item-e2e-4389-c')).toHaveAttribute(
      'href',
      '/worktrees/e2e-4389-c?instance=codex',
    );

    const tileToggle = page.getByTestId('sessions-view-mode-tile');
    await tileToggle.click();
    await expect(tileToggle).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('session-tile-e2e-4389-b')).toHaveCount(0);
    const switchA = page.getByTestId('session-tile-instance-e2e-4389-a');
    await expect(switchA).toHaveValue('codex');
    await expect(switchA.locator('option')).toHaveText(['Codex', 'Codex 2']);
    // A single match: no switch.
    await expect(page.getByTestId('session-tile-e2e-4389-c')).toBeVisible();
    await expect(page.getByTestId('session-tile-instance-e2e-4389-c')).toHaveCount(0);

    await page.getByTestId('sessions-view-mode-list').click();
    await page.getByTestId('session-item-e2e-4389-a').click();
    await page.waitForURL((url) => url.pathname === '/worktrees/e2e-4389-a');
    // The worktree screen shows the first matching instance (codex), not its
    // first instance (claude): the header's current-session pill is codex's.
    const current = page.locator('[data-session-current]');
    await expect(current).toHaveAttribute('data-testid', 'desktop-agent-status-codex', { timeout: 30_000 });
    await expect(current).toHaveAttribute('aria-pressed', 'true');
    // `?instance=` was consumed by the screen.
    await expect.poll(() => new URL(page.url()).searchParams.get('instance')).toBeNull();
  });
});
