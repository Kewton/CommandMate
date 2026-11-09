/**
 * E2E: the mem items screen through the real page (Issue #4227, design
 * `mem-ui-4227.md` §7.5, G-PR1), at a PC's and a phone's width.
 *
 * What the component tests cannot show: the real route (`/repositories/:id/mem`)
 * wires the panel, the browser sends the writes with the screen's mark, and two pages
 * open on one item see each other's change (a conflict on save, an "updated" mark on
 * the next read). The mem API is stubbed per browser context, so both pages share one
 * store with versions; the server's own refusals are fixed in the unit tables
 * (`tests/unit/lib/mem/screen-write-entrances-4227.test.ts`). No default is assumed:
 * the mode, the worktree and the roster are set here.
 */

import { test, expect, type BrowserContext, type Page, type Route } from '@playwright/test';

const REPO = 'repo-e2e-4227';
const BRANCH = 'feat/mem-ui';
const WT = 'wt-e2e-4227';
const SCREEN = `/repositories/${REPO}/mem?branch=${encodeURIComponent(BRANCH)}&worktree=${WT}`;

interface Item {
  id: string;
  kind: string;
  state: string;
  text: string;
  version: number;
  updatedBy: string;
}

interface Store {
  mode: 'on' | 'derived' | 'off';
  items: Item[];
  writes: Array<{ method: string; url: string; mark: string | null; body: Record<string, unknown> }>;
}

const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

function view(item: Item, frozen: boolean) {
  return {
    ...item,
    closeWhen: null,
    owner: {
      repositoryId: REPO,
      branch: BRANCH,
      worktreeId: WT,
      worktreeIncarnation: 'wi',
      instanceId: 'claude',
      cliToolId: 'claude',
      incarnation: 'ii',
      sessionGeneration: null,
    },
    createdBy: 'agent',
    createdAt: '2026-11-09T00:00:00.000Z',
    updatedAt: '2026-11-09T00:00:00.000Z',
    closedAt: null,
    closeReason: null,
    stale: false,
    frozen,
  };
}

/** One store for every page of the context: two pages on one item share it. */
async function stubMem(context: BrowserContext, names: { worktree: string; branch: string } = { worktree: 'wt', branch: BRANCH }): Promise<Store> {
  const store: Store = {
    mode: 'on',
    items: [
      { id: 'note-1', kind: 'note', state: 'open', text: 'first note', version: 1, updatedBy: 'agent' },
      { id: 'dec-1', kind: 'decision', state: 'recorded', text: 'recorded decision', version: 2, updatedBy: 'human' },
    ],
    writes: [],
  };
  await context.route(
    (url) =>
      (url.pathname === '/api/worktrees' && url.searchParams.get('includeStatus') === 'false') ||
      url.pathname.startsWith(`/api/repositories/${REPO}/mem`) || url.pathname.startsWith(`/api/worktrees/${WT}/mem`),
    (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const method = request.method();
      const body = (method === 'GET' ? {} : (request.postDataJSON() ?? {})) as Record<string, unknown>;
      if (method !== 'GET') store.writes.push({ method, url: url.pathname, mark: request.headers()['x-commandmate-client'] ?? null, body });
      if (url.pathname === '/api/worktrees') {
        return json(route, 200, {
          repositories: [{ id: REPO, path: '/e2e/repo', name: 'repo' }],
          worktrees: [{ id: WT, name: names.worktree, repositoryPath: '/e2e/repo', branch: names.branch, agentInstances: [{ id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 }] }],
        });
      }
      if (url.pathname.endsWith('/mem/mode')) {
        return json(route, 200, { ok: true, mode: store.mode, source: { level: 'rule', repositoryId: REPO, branch: null, rulePosition: 0, pattern: 'feat/*' } });
      }
      if (url.pathname.endsWith('/mem/notices')) return json(route, 200, { ok: true, notices: [] });
      if (method === 'GET' && (url.pathname === `/api/worktrees/${WT}/mem` || url.pathname === `/api/repositories/${REPO}/mem`)) {
        if (store.mode === 'off') return json(route, 409, { ok: false, code: 'disabled', mode: 'off' });
        const open = store.items.filter((item) => item.state !== 'closed');
        return json(route, 200, { ok: true, mode: store.mode, branch: BRANCH, items: open.map((item) => view(item, store.mode === 'derived')), now: [], warnings: [] });
      }
      if (request.headers()['x-commandmate-client'] !== 'screen') return json(route, 403, { ok: false, code: 'screen_only' });
      if (store.mode !== 'on') return json(route, 409, { ok: false, code: 'disabled', mode: store.mode });
      if (method === 'POST' && url.pathname === `/api/worktrees/${WT}/mem/screen/items`) {
        const added: Item = { id: `added-${store.items.length}`, kind: String(body.kind), state: 'open', text: String(body.text), version: 1, updatedBy: 'human' };
        store.items.push(added);
        return json(route, 201, { ok: true, item: view(added, false), replayed: false, warnings: [] });
      }
      const match = /\/mem\/screen\/items\/([^/]+)(\/close)?$/.exec(url.pathname);
      const target = match ? store.items.find((item) => item.id === match[1]) : undefined;
      if (!target) return json(route, 404, { ok: false, code: 'item_not_found' });
      if (target.version !== body.ifVersion) {
        return json(route, 409, { ok: false, code: 'version_conflict', currentVersion: target.version, item: view(target, false) });
      }
      if (match![2]) {
        if (target.state === 'recorded' && body.confirmUnreflected !== true) return json(route, 409, { ok: false, code: 'confirmation_required' });
        target.state = 'closed';
      } else if (body.text !== undefined) {
        // As the store: a field the screen did not send is kept.
        target.text = String(body.text);
      }
      target.version += 1;
      target.updatedBy = 'human';
      return json(route, method === 'PATCH' ? 200 : 201, { ok: true, item: view(target, false) });
    },
  );
  return store;
}

/** Another writer (an agent through A's API) changes the item while a page is open. */
function agentWrites(store: Store, id: string, text: string): void {
  const item = store.items.find((entry) => entry.id === id)!;
  item.text = text;
  item.version += 1;
  item.updatedBy = 'agent';
}

async function open(page: Page): Promise<void> {
  await page.goto(SCREEN);
  await expect(page.getByTestId('mem-item-note-1')).toBeVisible();
  await expect(page.getByTestId('mem-items-add')).toBeVisible();
}

for (const viewport of [
  { name: 'PC', size: { width: 1440, height: 900 } },
  { name: 'phone', size: { width: 390, height: 844 } },
]) {
  test.describe(`mem items screen (${viewport.name})`, () => {
    test.use({ viewport: viewport.size });

    test('lists, adds, edits and closes, every write with the screen mark', async ({ context, page }) => {
      const store = await stubMem(context);
      await open(page);
      await expect(page.getByTestId('mem-item-unreflected-dec-1')).toBeVisible();

      await page.getByTestId('mem-items-add-text').fill('a person’s note');
      await page.getByTestId('mem-items-add-submit').click();
      await expect(page.getByText('a person’s note')).toBeVisible();

      await page.getByTestId('mem-item-edit-note-1').click();
      await page.getByTestId('mem-item-edit-text-note-1').fill('edited by a person');
      await page.getByTestId('mem-item-save-note-1').click();
      await expect(page.getByTestId('mem-item-text-note-1')).toHaveText('edited by a person');

      await page.getByTestId('mem-item-close-dec-1').click();
      await page.getByTestId('mem-item-close-step1-dec-1').click();
      await page.getByTestId('mem-item-close-confirm-dec-1').click();
      await expect(page.getByTestId('mem-item-dec-1')).toHaveCount(0);

      expect(store.writes.map((write) => [write.method, write.mark])).toEqual([
        ['POST', 'screen'],
        ['PATCH', 'screen'],
        ['POST', 'screen'],
      ]);
      expect(store.writes[0].body).toMatchObject({ instanceId: 'claude', expectBranch: BRANCH });
      expect(store.writes[1].body).toMatchObject({ ifVersion: 1 });
      expect(store.writes[2].body).toMatchObject({ ifVersion: 2, confirmUnreflected: true });
      // The panel does not scroll sideways at this width.
      const panel = page.getByTestId('mem-items-panel');
      expect(await panel.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    });

    test('two pages on one item: the second save is a conflict with three values, and saving on top is the person’s press', async ({ context, page }) => {
      const store = await stubMem(context);
      const other = await context.newPage();
      await open(page);
      await open(other);

      await page.getByTestId('mem-item-edit-note-1').click();
      await page.getByTestId('mem-item-edit-text-note-1').fill('from page one');
      await other.getByTestId('mem-item-edit-note-1').click();
      await other.getByTestId('mem-item-edit-text-note-1').fill('from page two');

      await page.getByTestId('mem-item-save-note-1').click();
      await expect(page.getByTestId('mem-item-text-note-1')).toHaveText('from page one');
      await other.getByTestId('mem-item-save-note-1').click();

      await expect(other.getByTestId('mem-item-conflict-note-1')).toBeVisible();
      await expect(other.getByTestId('mem-conflict-draft')).toHaveText('from page two');
      await expect(other.getByTestId('mem-conflict-read')).toHaveText('first note');
      await expect(other.getByTestId('mem-conflict-current')).toHaveText('from page one');
      expect(store.items.find((item) => item.id === 'note-1')!.text).toBe('from page one');

      await other.getByTestId('mem-item-rebase-note-1').click();
      await expect(other.getByTestId('mem-item-text-note-1')).toHaveText('from page two');
      expect(store.writes.filter((write) => write.method === 'PATCH').map((write) => write.body.ifVersion)).toEqual([1, 1, 2]);
    });

    test('a stale page: an agent’s update shows as “updated” on the next read', async ({ context, page }) => {
      const store = await stubMem(context);
      await open(page);
      agentWrites(store, 'note-1', 'the agent changed it');
      // The screen reads again when it gets the focus back (and every 30 seconds).
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect(page.getByTestId('mem-item-changed-note-1')).toBeVisible();
      await expect(page.getByTestId('mem-item-text-note-1')).toHaveText('the agent changed it');
    });

    test('long names (a real worktree and branch) do not make the page scroll sideways (P3-3)', async ({ context, page }) => {
      const branch = 'feature/4227-worktree-with-a-long-descriptive-branch-name-for-the-mem-items-screen';
      await stubMem(context, { worktree: 'commandmate-issue-4227-worktree-with-a-long-directory-name', branch });
      await page.goto(`/repositories/${REPO}/mem?branch=${encodeURIComponent(branch)}&worktree=${WT}`);
      await expect(page.getByTestId('mem-item-note-1')).toBeVisible();
      await expect(page.getByTestId('mem-items-worktree')).toBeVisible();
      // The whole page, not only the panel: the heading carries the branch name.
      const widths = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
      expect(widths.scroll).toBeLessThanOrEqual(widths.inner);
      for (const id of ['mem-items-worktree', 'mem-items-panel']) {
        const box = await page.getByTestId(id).boundingBox();
        expect(box).not.toBeNull();
        expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.size.width);
      }
    });

    test('the mode: derived freezes the writes, off lists nothing', async ({ context, page }) => {
      const store = await stubMem(context);
      store.mode = 'derived';
      await page.goto(SCREEN);
      await expect(page.getByTestId('mem-item-note-1')).toBeVisible();
      await expect(page.getByTestId('mem-items-add')).toHaveCount(0);
      await expect(page.getByTestId('mem-item-edit-note-1')).toHaveCount(0);

      store.mode = 'off';
      await page.reload();
      await expect(page.getByTestId('mem-items-mode')).toBeVisible();
      await expect(page.getByTestId('mem-items-list')).toHaveCount(0);
      expect(store.writes).toEqual([]);
    });
  });
}
