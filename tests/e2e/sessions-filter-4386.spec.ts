import { test, expect } from '@playwright/test';

// Issue #4386: ^feature/ leaves only feature branches in both list and tile.
test('branch filter ^feature/ applies to list and tile', async ({ page }) => {
  await page.goto('/sessions');
  await page.getByTestId('sessions-filter-button').click();
  await page.getByTestId('sessions-branch-filter').fill('^feature/');
  await page.keyboard.press('Escape');
  const list = page.getByTestId('sessions-list');
  await expect(list).not.toContainText(/^main$/m);
  await page.getByRole('radio', { name: /タイル|Tile/ }).click();
  await expect(page.getByTestId('sessions-filter-count')).toHaveText('1');
});
