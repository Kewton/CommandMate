/**
 * E2E: Repositories screen — duplicate scan roots (Issue #1662)
 *
 * The jsdom suites prove the wiring; this proves it in a browser, for the two
 * pieces jsdom approximates worst and that this feature leans on: a portalled
 * `Modal` with a focus trap (the "add anyway?" confirmation) and real DOM focus
 * management (the badge handing focus to the Scan toggle). Both are exactly the
 * kind of thing that has shipped dead behind green jsdom tests here before.
 *
 * The E2E server scans an empty, non-git root (playwright.config.ts), so it has
 * no repositories of its own — `/api/repositories*` is stubbed in the browser.
 * Nothing is seeded into the server's DB, so destructive specs running in
 * parallel are unaffected.
 */

import { test, expect, type Page } from '@playwright/test';

const MAIN_PATH = '/scan-roots/CommandAgent';
const DEVELOP_PATH = '/scan-roots/CommandAgent-develop';
const SOLO_PATH = '/scan-roots/Solo';

interface StubRepository {
  id: string;
  name: string;
  displayName: string | null;
  path: string;
  enabled: boolean;
  visible: boolean;
  worktreeCount: number;
  /**
   * Stand-in for `git rev-parse --git-common-dir`: rows sharing it are the same
   * repository. `duplicateOf` is DERIVED from it per request rather than stored,
   * because that is what `GET /api/repositories` does — it recomputes over the
   * ENABLED rows every time. A stub that returned a frozen `duplicateOf` would
   * report a duplicate that the user had just excluded, and the spec would be
   * testing the stub's memory instead of the product.
   */
  commonDir: string;
}

interface RecordedCalls {
  put: Array<{ id: string; body: Record<string, unknown> }>;
  scan: string[];
  validatePath: string[];
}

/**
 * Two scan roots that are the same git repository (the #1659 shape) plus one
 * ordinary repository that must stay unflagged.
 */
async function stubRepositories(page: Page): Promise<RecordedCalls> {
  const repositories: StubRepository[] = [
    {
      id: 'repo-main',
      name: 'CommandAgent',
      displayName: null,
      path: MAIN_PATH,
      enabled: true,
      visible: true,
      worktreeCount: 5,
      commonDir: '/git/CommandAgent/.git',
    },
    {
      id: 'repo-develop',
      name: 'CommandAgent-develop',
      displayName: null,
      path: DEVELOP_PATH,
      enabled: true,
      visible: true,
      worktreeCount: 5,
      commonDir: '/git/CommandAgent/.git',
    },
    {
      id: 'repo-solo',
      name: 'Solo',
      displayName: null,
      path: SOLO_PATH,
      enabled: true,
      visible: true,
      worktreeCount: 1,
      commonDir: '/git/Solo/.git',
    },
  ];
  const calls: RecordedCalls = { put: [], scan: [], validatePath: [] };

  /** Mirrors the route: group the ENABLED rows by common dir, name the others. */
  const listPayload = () =>
    repositories.map(({ commonDir, ...row }) => ({
      ...row,
      duplicateOf: repositories
        .filter(
          (other) =>
            other.enabled && row.enabled && other.commonDir === commonDir && other.path !== row.path
        )
        .map((other) => other.path),
    }));

  await page.route('**/api/repositories**', async (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    const method = request.method();
    const json = (body: unknown) =>
      route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

    if (pathname === '/api/repositories' && method === 'GET') {
      return json({ success: true, repositories: listPayload() });
    }

    if (pathname === '/api/repositories/validate-path' && method === 'POST') {
      const body = request.postDataJSON() as { repositoryPath: string };
      calls.validatePath.push(body.repositoryPath);
      // Anything under the CommandAgent repository duplicates both roots.
      const duplicates = body.repositoryPath.startsWith('/scan-roots/CommandAgent')
        ? [MAIN_PATH]
        : [];
      return json({
        valid: true,
        resolvedPath: body.repositoryPath,
        roots: ['/scan-roots'],
        allowedRootsLabel: '/scan-roots',
        isGitRepo: true,
        worktreeCount: 5,
        duplicateScanRoots: duplicates,
      });
    }

    if (pathname === '/api/repositories/scan' && method === 'POST') {
      const body = request.postDataJSON() as { repositoryPath: string };
      calls.scan.push(body.repositoryPath);
      return json({
        success: true,
        message: 'Successfully scanned and added 5 worktree(s)',
        worktreeCount: 5,
        repositoryPath: body.repositoryPath,
        repositoryName: 'CommandAgent-feature',
      });
    }

    if (pathname.startsWith('/api/repositories/') && method === 'PUT') {
      const id = pathname.slice('/api/repositories/'.length);
      const body = request.postDataJSON() as Record<string, unknown>;
      calls.put.push({ id, body });
      const target = repositories.find((r) => r.id === id)!;
      if (typeof body.enabled === 'boolean') target.enabled = body.enabled;
      if (typeof body.visible === 'boolean') target.visible = body.visible;
      const { worktreeCount: _count, commonDir: _commonDir, ...repository } = target;
      return json({ success: true, repository });
    }

    return route.continue();
  });

  // The Add form fetches the allowed roots when it opens.
  await page.route('**/api/fs/browse**', (route) =>
    route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: null,
        parent: null,
        roots: ['/scan-roots'],
        recentPaths: [],
        entries: [],
        truncated: false,
      }),
    })
  );

  return calls;
}

test.describe('Repositories screen — duplicate scan roots (Issue #1662)', () => {
  test('flags both roots of a duplicate pair and leaves ordinary rows clean', async ({
    page,
  }) => {
    await stubRepositories(page);
    await page.goto('/repositories');

    const badge = page.getByTestId('duplicate-scan-root-repo-main');
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText('Duplicate scan root');
    // Rendered from the real dictionary: it names the other root and the remedy.
    await expect(badge).toHaveAttribute('aria-label', new RegExp(DEVELOP_PATH));
    await expect(badge).toHaveAttribute('aria-label', /Scan toggle/i);

    await expect(page.getByTestId('duplicate-scan-root-repo-develop')).toBeVisible();
    // The false-positive guard, in a real browser.
    await expect(page.getByTestId('duplicate-scan-root-repo-solo')).toHaveCount(0);
  });

  test('the flag hands focus to that row’s Scan toggle', async ({ page }) => {
    const calls = await stubRepositories(page);
    await page.goto('/repositories');

    await page.getByTestId('duplicate-scan-root-repo-develop').click();

    await expect(page.getByTestId('scan-toggle-repo-develop')).toBeFocused();
    // Focusing is not pressing: nothing was changed by looking at the warning.
    await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);
    expect(calls.put).toEqual([]);

    // …and the focused control is operable straight from the keyboard, which is
    // the whole point of moving focus rather than just scrolling.
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('confirm-dialog')).toBeVisible();
  });

  test('excluding one root retires the warning on both rows', async ({ page }) => {
    const calls = await stubRepositories(page);
    await page.goto('/repositories');

    await page.getByTestId('duplicate-scan-root-repo-main').click();
    await page.keyboard.press('Enter');
    await page.getByTestId('confirm-dialog-confirm').click();

    await expect(page.getByTestId('scan-toggle-repo-main')).toHaveAttribute(
      'aria-checked',
      'false'
    );
    expect(calls.put).toEqual([{ id: 'repo-main', body: { enabled: false } }]);

    await expect(page.getByTestId('duplicate-scan-root-repo-main')).toHaveCount(0);
    await expect(page.getByTestId('duplicate-scan-root-repo-develop')).toHaveCount(0);
    // Non-destructive: the row and its worktree count are still there.
    await expect(page.getByTestId('repository-row-repo-main')).toContainText('5');
  });

  test('warns while typing a path that duplicates an existing scan root', async ({ page }) => {
    await stubRepositories(page);
    await page.goto('/repositories');

    await page.getByTestId('add-repository-button').click();
    await page.getByTestId('repository-path-input').fill('/scan-roots/CommandAgent-feature');

    const warning = page.getByTestId('duplicate-scan-root-warning');
    await expect(warning).toBeVisible();
    await expect(warning).toContainText(MAIN_PATH);
    // A warning, not a rejection — the form stays submittable.
    await expect(page.getByTestId('repository-scan-submit')).toBeEnabled();
  });

  test('does not warn while typing a path that is its own repository', async ({ page }) => {
    await stubRepositories(page);
    await page.goto('/repositories');

    await page.getByTestId('add-repository-button').click();
    await page.getByTestId('repository-path-input').fill('/scan-roots/Unrelated');

    await expect(page.getByText(/Git repository detected/)).toBeVisible();
    await expect(page.getByTestId('duplicate-scan-root-warning')).toHaveCount(0);
  });

  test('asks before adding a duplicate, and backing out registers nothing', async ({ page }) => {
    const calls = await stubRepositories(page);
    await page.goto('/repositories');

    await page.getByTestId('add-repository-button').click();
    await page.getByTestId('repository-path-input').fill('/scan-roots/CommandAgent-feature');
    await expect(page.getByTestId('duplicate-scan-root-warning')).toBeVisible();

    await page.getByTestId('repository-scan-submit').click();

    const dialog = page.getByTestId('confirm-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(MAIN_PATH);
    await expect(dialog).toContainText('/scan-roots/CommandAgent-feature');
    expect(calls.scan).toEqual([]);

    await page.getByTestId('confirm-dialog-cancel').click();
    await expect(dialog).toBeHidden();
    expect(calls.scan).toEqual([]);
    // The typed path survives, so retrying is one click.
    await expect(page.getByTestId('repository-path-input')).toHaveValue(
      '/scan-roots/CommandAgent-feature'
    );
  });

  test('registers the duplicate when the user confirms — it warns, it does not block', async ({
    page,
  }) => {
    const calls = await stubRepositories(page);
    await page.goto('/repositories');

    await page.getByTestId('add-repository-button').click();
    await page.getByTestId('repository-path-input').fill('/scan-roots/CommandAgent-feature');
    await expect(page.getByTestId('duplicate-scan-root-warning')).toBeVisible();

    await page.getByTestId('repository-scan-submit').click();
    await page.getByTestId('confirm-dialog-confirm').click();

    await expect
      .poll(() => calls.scan)
      .toEqual(['/scan-roots/CommandAgent-feature']);
  });

  test('adds a non-duplicate straight away, with no dialog', async ({ page }) => {
    const calls = await stubRepositories(page);
    await page.goto('/repositories');

    await page.getByTestId('add-repository-button').click();
    await page.getByTestId('repository-path-input').fill('/scan-roots/Unrelated');
    await expect(page.getByText(/Git repository detected/)).toBeVisible();

    await page.getByTestId('repository-scan-submit').click();

    await expect.poll(() => calls.scan).toEqual(['/scan-roots/Unrelated']);
    await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);
  });
});
