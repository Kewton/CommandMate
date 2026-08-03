/**
 * E2E: Repositories screen — Scan toggle (Issue #1658)
 *
 * The jsdom component tests prove the wiring; this proves the thing works in a
 * browser. That distinction has bitten this repository before (a command
 * palette whose keyboard handling was entirely dead while every jsdom test was
 * green), and the parts most likely to differ here are exactly the ones jsdom
 * approximates: a portalled `Modal` with a focus trap and an exit animation, and
 * the real `next-intl` dictionary rather than a mock.
 *
 * The E2E server scans an empty, non-git root (playwright.config.ts), so it has
 * no repositories of its own — the repository API is stubbed in the browser.
 * Stubbing is confined to `/api/repositories*`; nothing is seeded into the
 * server's DB, so the destructive specs running in parallel are unaffected.
 */

import { test, expect, type Page } from '@playwright/test';

interface StubRepository {
  id: string;
  name: string;
  displayName: string | null;
  path: string;
  enabled: boolean;
  visible: boolean;
  worktreeCount: number;
}

/** Requests the page made, so a test can assert what was (not) sent. */
interface RecordedCalls {
  put: Array<{ id: string; body: Record<string, unknown> }>;
  restore: string[];
}

async function stubRepositories(page: Page): Promise<RecordedCalls> {
  const repositories: StubRepository[] = [
    {
      id: 'repo-keep',
      name: 'keeper',
      displayName: null,
      path: '/scan-roots/keeper',
      enabled: true,
      visible: true,
      worktreeCount: 3,
    },
    {
      id: 'repo-dropped',
      name: 'dropped',
      displayName: null,
      path: '/scan-roots/dropped',
      enabled: false,
      visible: true,
      worktreeCount: 1,
    },
  ];
  const calls: RecordedCalls = { put: [], restore: [] };

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
      return json({ success: true, repositories });
    }

    if (pathname === '/api/repositories/restore' && method === 'PUT') {
      const body = request.postDataJSON() as { repositoryPath: string };
      calls.restore.push(body.repositoryPath);
      const target = repositories.find((r) => r.path === body.repositoryPath);
      if (target) target.enabled = true;
      return json({
        success: true,
        worktreeCount: target?.worktreeCount ?? 0,
        message: 'restored',
      });
    }

    if (pathname.startsWith('/api/repositories/') && method === 'PUT') {
      const id = pathname.slice('/api/repositories/'.length);
      const body = request.postDataJSON() as Record<string, unknown>;
      calls.put.push({ id, body });
      const target = repositories.find((r) => r.id === id)!;
      if (typeof body.enabled === 'boolean') target.enabled = body.enabled;
      if (typeof body.visible === 'boolean') target.visible = body.visible;
      const { worktreeCount: _ignored, ...repository } = target;
      return json({ success: true, repository });
    }

    return route.continue();
  });

  return calls;
}

test.describe('Repositories screen — Scan toggle (Issue #1658)', () => {
  test('shows the scan state as a switch, separate from the visibility switch', async ({
    page,
  }) => {
    await stubRepositories(page);
    await page.goto('/repositories');

    const scan = page.getByTestId('scan-toggle-repo-keep');
    await expect(scan).toBeVisible();
    await expect(scan).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('scan-toggle-repo-dropped')).toHaveAttribute(
      'aria-checked',
      'false'
    );

    // Two switches on the same row, each naming its own concept.
    await expect(scan).toHaveAttribute('aria-label', /repository scans/i);
    await expect(page.getByTestId('visibility-toggle-repo-keep')).toHaveAttribute(
      'aria-label',
      /sidebar/i
    );
  });

  test('asks before excluding, and cancelling sends nothing', async ({ page }) => {
    const calls = await stubRepositories(page);
    await page.goto('/repositories');

    await page.getByTestId('scan-toggle-repo-keep').click();

    const dialog = page.getByTestId('confirm-dialog');
    await expect(dialog).toBeVisible();
    // The promises that separate this from the purging DELETE, rendered from
    // the real dictionary rather than a test mock.
    await expect(dialog).toContainText('keeper');
    await expect(dialog).toContainText('3 worktree(s)');
    await expect(dialog).toContainText(/Nothing is deleted/i);
    await expect(dialog).toContainText(/keeps running/i);
    await expect(dialog).toContainText(/Visibility toggle/i);

    await page.getByTestId('confirm-dialog-cancel').click();
    await expect(dialog).toBeHidden();

    expect(calls.put).toEqual([]);
    await expect(page.getByTestId('scan-toggle-repo-keep')).toHaveAttribute(
      'aria-checked',
      'true'
    );
  });

  test('confirming excludes the repository without changing its worktree count', async ({
    page,
  }) => {
    const calls = await stubRepositories(page);
    await page.goto('/repositories');

    const row = page.getByTestId('repository-row-repo-keep');
    await expect(row).toContainText('3');

    await page.getByTestId('scan-toggle-repo-keep').click();
    await page.getByTestId('confirm-dialog-confirm').click();

    await expect(page.getByTestId('scan-toggle-repo-keep')).toHaveAttribute(
      'aria-checked',
      'false'
    );
    expect(calls.put).toEqual([{ id: 'repo-keep', body: { enabled: false } }]);
    // Nothing was deleted, so the count the row shows is unchanged.
    await expect(row).toContainText('3');
    expect(calls.restore).toEqual([]);
  });

  test('re-includes a repository through restore, with no confirmation', async ({ page }) => {
    const calls = await stubRepositories(page);
    await page.goto('/repositories');

    await page.getByTestId('scan-toggle-repo-dropped').click();

    await expect(page.getByTestId('scan-toggle-repo-dropped')).toHaveAttribute(
      'aria-checked',
      'true'
    );
    expect(calls.restore).toEqual(['/scan-roots/dropped']);
    expect(calls.put).toEqual([]);
    await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);
  });

  test('lists only the excluded repositories under the Disabled filter', async ({ page }) => {
    await stubRepositories(page);
    await page.goto('/repositories');

    await expect(page.getByTestId('repository-filter-all')).toHaveText('All (2)');
    await expect(page.getByTestId('repository-filter-disabled')).toHaveText('Disabled (1)');

    await page.getByTestId('repository-filter-disabled').click();

    await expect(page.getByTestId('repository-row-repo-dropped')).toBeVisible();
    await expect(page.getByTestId('repository-row-repo-keep')).toHaveCount(0);

    await page.getByTestId('repository-filter-all').click();
    await expect(page.getByTestId('repository-row-repo-keep')).toBeVisible();
  });
});
