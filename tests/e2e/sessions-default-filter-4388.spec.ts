/**
 * E2E: the /sessions default filter (Issue #4388). `/api/` is mocked in the browser
 * (same approach as sessions-filter-4389.spec.ts); the saved default lives in this
 * spec's memory and is served by the mocked `GET/PUT /api/settings/sessions-filter`,
 * so it is shared across pages (PC and phone) like the server-wide setting.
 *
 * - Save the default on PC → reopen /sessions (PC and phone) → it is applied.
 * - Change the condition, go to another screen and back → the default again.
 * - A role of the default was deleted → notice, the rest still filters.
 * - Every role of the default was deleted (nothing else set) → notice, 0 sessions, not all.
 */
import { test, expect, type Page, type Route } from '@playwright/test';
import { mockStartPreview } from './fixtures/start-preview-helpers';

const idle = { isRunning: false, isWaitingForResponse: false, isProcessing: false };

const row = (id: string, name: string) => ({
  id,
  name,
  path: `/tmp/${id}`,
  repositoryPath: '/tmp/e2e-4388-repo',
  repositoryName: 'e2e-repo',
  repositoryDisplayName: 'E2E Repo',
  selectedAgents: ['claude', 'codex'],
  agentInstances: [
    { id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 },
    { id: 'codex', cliTool: 'codex', alias: 'Codex', order: 1 },
  ],
  cliToolId: 'claude',
  status: 'ready',
  sessionStatusByCli: { claude: idle, codex: idle },
  sessionStatusByInstance: { claude: idle, codex: idle },
  gitStatus: { currentBranch: name, initialBranch: name, isBranchMismatch: false, commitHash: 'e2e0000', isDirty: false },
});

const WORKTREES = [
  row('e2e-4388-a', 'feature/1-a'),
  row('e2e-4388-b', 'feature/2-b'),
  row('e2e-4388-c', 'main'),
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
    'e2e-4388-a': { claude: role('review', 'Reviewer'), codex: { kind: 'none' } },
    'e2e-4388-b': { claude: role('impl', 'Implementer'), codex: { kind: 'none' } },
    'e2e-4388-c': { claude: role('review', 'Reviewer'), codex: { kind: 'none' } },
  },
};

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

interface Condition {
  branchPattern: string;
  roleIds: string[];
  includeNoRole: boolean;
  includeAmbiguous: boolean;
}
const EMPTY: Condition = { branchPattern: '', roleIds: [], includeNoRole: false, includeAmbiguous: false };

/** The server-wide saved default (null = nothing saved). */
interface Store {
  saved: Condition | null;
  puts: Condition[];
}

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function mockApi(page: Page, store: Store) {
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const request = route.request();
      const { pathname } = new URL(request.url());
      if (pathname === '/api/settings/sessions-filter') {
        if (request.method() === 'PUT') {
          const body = request.postDataJSON() as Condition;
          store.puts.push(body);
          store.saved = body;
        }
        return json(route, { success: true, filter: store.saved ?? EMPTY, configured: store.saved !== null });
      }
      if (pathname.endsWith('/api/worktrees')) {
        return json(route, { worktrees: WORKTREES, repositories: [] });
      }
      if (pathname === '/api/roles') return json(route, ROLES);
      if (pathname === '/api/sessions/roles') return json(route, SESSION_ROLES);
      if (pathname === '/api/relays') return json(route, EMPTY_RELAYS);
      if (pathname === '/api/sidebar/group-order') return json(route, { success: true, order: [] });
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

const item = (page: Page, id: string) => page.getByTestId(`session-item-${id}`);

async function openSessions(page: Page) {
  await page.goto('/sessions');
  await expect(page.getByTestId('sessions-filter-button')).toBeVisible();
  await expect(item(page, 'e2e-4388-a')).toBeVisible();
}

test.use({ viewport: { width: 1440, height: 900 } });

test.describe('[#4388] sessions default filter', () => {
  test('saved on PC, applied when /sessions is opened again (PC and phone)', async ({ page, browser }) => {
    const store: Store = { saved: null, puts: [] };
    await mockApi(page, store);
    await openSessions(page);
    await expect(item(page, 'e2e-4388-c')).toBeVisible();

    await page.getByTestId('sessions-filter-button').click();
    await page.getByTestId('sessions-branch-filter').fill('^feature/');
    await page.getByTestId('sessions-role-filter-role-review').check();
    await expect(page.getByTestId('sessions-filter-differs')).toHaveCount(1);
    await page.getByTestId('sessions-default-filter-save').click();
    await expect(page.getByTestId('sessions-default-filter-saved')).toBeVisible();
    expect(store.puts).toEqual([{ branchPattern: '^feature/', roleIds: ['review'], includeNoRole: false, includeAmbiguous: false }]);
    await expect(page.getByTestId('sessions-filter-differs')).toHaveCount(0);
    await page.keyboard.press('Escape');

    // Reopen on PC.
    await page.reload();
    await expect(page.getByTestId('sessions-filter-count')).toHaveText('2');
    await expect(item(page, 'e2e-4388-a')).toBeVisible();
    await expect(item(page, 'e2e-4388-b')).toHaveCount(0);
    await expect(item(page, 'e2e-4388-c')).toHaveCount(0);
    await expect(page.getByTestId('sessions-filter-differs')).toHaveCount(0);

    // Open on a phone: the same server-wide default applies.
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    try {
      const mobilePage = await phone.newPage();
      await mockApi(mobilePage, store);
      await mobilePage.goto('/sessions');
      await expect(mobilePage.getByTestId('sessions-filter-count')).toHaveText('2');
      await expect(item(mobilePage, 'e2e-4388-a')).toBeVisible();
      await expect(item(mobilePage, 'e2e-4388-c')).toHaveCount(0);
      await mobilePage.getByTestId('sessions-filter-button').click();
      const sheet = mobilePage.getByTestId('sessions-filter-sheet');
      await expect(sheet.getByTestId('sessions-branch-filter')).toHaveValue('^feature/');
      await expect(sheet.getByTestId('sessions-default-filter-save')).toBeVisible();
      await expect(sheet.getByTestId('sessions-default-filter-reset')).toBeEnabled();
    } finally {
      await phone.close();
    }
  });

  test('a change is not kept: another screen and back shows the default again', async ({ page }) => {
    const store: Store = { saved: { ...EMPTY, branchPattern: '^feature/' }, puts: [] };
    await mockApi(page, store);
    await page.goto('/sessions');
    await expect(item(page, 'e2e-4388-a')).toBeVisible();
    await expect(item(page, 'e2e-4388-c')).toHaveCount(0);

    await page.getByTestId('sessions-filter-button').click();
    await page.getByTestId('sessions-branch-filter').fill('2-b');
    await page.keyboard.press('Escape');
    await expect(item(page, 'e2e-4388-a')).toHaveCount(0);
    await expect(page.getByTestId('sessions-filter-differs')).toHaveCount(1);

    await item(page, 'e2e-4388-b').click();
    await page.waitForURL((url) => url.pathname === '/worktrees/e2e-4388-b');
    await page.goBack();
    await page.waitForURL((url) => url.pathname === '/sessions');

    await expect(item(page, 'e2e-4388-a')).toBeVisible();
    await expect(item(page, 'e2e-4388-b')).toBeVisible();
    await expect(item(page, 'e2e-4388-c')).toHaveCount(0);
    await expect(page.getByTestId('sessions-filter-differs')).toHaveCount(0);
    expect(store.puts).toEqual([]);
  });

  test('a deleted role in the default: a notice, and the rest still filters', async ({ page }) => {
    const store: Store = { saved: { ...EMPTY, branchPattern: '^feature/', roleIds: ['gone', 'review'] }, puts: [] };
    await mockApi(page, store);
    await page.goto('/sessions');
    await expect(page.getByTestId('sessions-default-filter-dropped-roles')).toBeVisible();
    await expect(item(page, 'e2e-4388-a')).toBeVisible();
    await expect(item(page, 'e2e-4388-b')).toHaveCount(0);
    await expect(item(page, 'e2e-4388-c')).toHaveCount(0);
    await expect(page.getByTestId('sessions-filter-differs')).toHaveCount(0);
  });

  test('every role of the default deleted: a notice, and the list stays narrowed (0 sessions, not all)', async ({ page }) => {
    const store: Store = { saved: { ...EMPTY, roleIds: ['gone'] }, puts: [] };
    await mockApi(page, store);
    await page.goto('/sessions');
    await expect(page.getByTestId('sessions-default-filter-dropped-roles')).toBeVisible();
    await expect(page.getByTestId('sessions-filter-count')).toHaveText('1');
    await expect(item(page, 'e2e-4388-a')).toHaveCount(0);
    await expect(item(page, 'e2e-4388-b')).toHaveCount(0);
    await expect(item(page, 'e2e-4388-c')).toHaveCount(0);
    await expect(page.getByTestId('sessions-filter-differs')).toHaveCount(0);

    // Clear widens on purpose (and is a difference from the default); nothing is saved.
    await page.getByTestId('sessions-filter-button').click();
    await page.getByTestId('sessions-filter-clear').click();
    await page.keyboard.press('Escape');
    await expect(item(page, 'e2e-4388-a')).toBeVisible();
    await expect(item(page, 'e2e-4388-c')).toBeVisible();
    await expect(page.getByTestId('sessions-filter-differs')).toHaveCount(1);
    expect(store.puts).toEqual([]);
  });
});
