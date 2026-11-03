/**
 * E2E: roles through the real pages (Issue #4117).
 *
 * What the component tests cannot show: that the worktree screen's real parents wire
 * the dialog, the roster and the split header together, and that `/more` shows the
 * settings at a phone's width with everything reachable by tapping.
 *
 * Written so that no default matters: the placement, the split count, which agents a
 * worktree shows and the activity pane's state are all set or read here, never
 * assumed. The role API is stubbed in the browser, and keeps its own state.
 */

import { test, expect, type Page, type Route } from '@playwright/test';
import { E2E_WORKTREE_A, setupSplitTest } from './fixtures/terminal-split-helpers';

const MARKETER = { id: '0011223344556677', name: 'マーケター', bodyVersion: 1, bodyFingerprint: 'a'.repeat(64), bodyBytes: 3, createdAt: 1, updatedAt: 1 };
const REVIEWER = { ...MARKETER, id: '8899aabbccddeeff', name: 'レビュー担当' };

interface Instance { id: string; cliTool: string; alias: string; order: number }

const TOOLS = ['claude', 'codex', 'command-code', 'opencode', 'opencode-v2', 'copilot', 'antigravity'];

function effective(cliToolId: string) {
  const base = { cliToolId, repositoryId: 'repo-1', repositoryIds: ['repo-1'] };
  if (cliToolId === 'claude') {
    return { ...base, kind: 'role', source: 'system', role: { id: MARKETER.id, name: MARKETER.name, bodyVersion: 1, bodyFingerprint: 'a'.repeat(64) } };
  }
  return { ...base, kind: 'none', source: 'fallback', reason: 'no-default' };
}

const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

/** Registered after `setupSplitTest`, so these win over its catch-all. */
async function stubRoles(page: Page): Promise<{ posts: Array<Record<string, unknown>>; refuseCreate: { value: boolean } }> {
  let roster: Instance[] = [
    { id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 },
    { id: 'codex', cliTool: 'codex', alias: 'Codex', order: 1 },
  ];
  let revision = 1;
  const posts: Array<Record<string, unknown>> = [];
  const refuseCreate = { value: false };
  const settings = () => ({
    success: true,
    rosterRevision: `rev-${revision}`,
    rosterSaved: true,
    instances: roster.map((inst) => ({
      instanceId: inst.id,
      cliToolId: inst.cliTool,
      alias: inst.alias,
      supported: TOOLS.includes(inst.cliTool),
      adapterEnabled: true,
      stored: { state: 'inherit' },
      application: {
        effectiveNext: { ...effective(inst.cliTool), injectionFingerprint: null },
        requested: null,
        launched: null,
        restartPending: 'unknown',
      },
    })),
    toolDefaults: TOOLS.map((cliToolId) => ({ cliToolId, adapterEnabled: true, effective: effective(cliToolId) })),
  });

  await page.route(
    (url) => url.pathname === `/api/worktrees/${E2E_WORKTREE_A}/instances/roles`,
    (route) => {
      const request = route.request();
      if (request.method() === 'GET') return json(route, 200, settings());
      const body = request.postDataJSON() as { instance: Instance };
      posts.push(body);
      if (refuseCreate.value) return json(route, 404, { success: false, error: 'not_found', message: 'gone' });
      roster = [...roster, { ...body.instance, order: roster.length }];
      revision += 1;
      return json(route, 201, { ...settings(), created: { instanceId: body.instance.id } });
    },
  );
  await page.route(
    (url) => url.pathname === '/api/roles',
    (route) => json(route, 200, { success: true, roles: [MARKETER, REVIEWER] }),
  );
  await page.route(
    (url) => url.pathname === '/api/settings/default-agents' && url.search.includes('installed'),
    (route) => json(route, 200, { installed: ['claude', 'codex', 'gemini'] }),
  );
  return { posts, refuseCreate };
}

test.describe('roles on the worktree screen (#4117)', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'PC split surface');

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await setupSplitTest(page);
  });

  test('the dialog names each tool\'s default, stays open on a refused save, and adds with the role', async ({ page }) => {
    const { posts, refuseCreate } = await stubRoles(page);
    await page.goto(`/worktrees/${E2E_WORKTREE_A}`);

    // The real parent wires the split header. Which agent a split opens on is not
    // assumed: whichever it is, the chip shows only for one with a role.
    const chip = page.getByTestId('split-role-status-0');
    await expect(page.getByTestId('cli-selector-0')).toBeVisible();
    if ((await page.getByTestId('cli-selector-0').textContent())?.includes('Claude')) {
      await expect(chip).toContainText(MARKETER.name);
    }

    await page.getByTestId('agent-add-button').click();
    const form = page.getByTestId('agent-add-form');
    await expect(form).toBeVisible();
    const tool = page.getByTestId('agent-add-tool');
    await expect(tool).toBeEnabled();

    await tool.selectOption('claude');
    await expect(page.getByTestId('agent-add-role-source')).toContainText(MARKETER.name);
    await tool.selectOption('codex');
    await expect(page.getByTestId('agent-add-role-source')).not.toContainText(MARKETER.name);
    await tool.selectOption('gemini');
    await expect(page.getByTestId('agent-add-role')).toBeDisabled();
    await expect(page.getByTestId('agent-add-role-unsupported')).toBeVisible();

    await tool.selectOption('claude');
    await page.getByTestId('agent-add-role').selectOption(REVIEWER.id);
    await page.getByTestId('agent-add-placement-roster-only').check();

    refuseCreate.value = true;
    await page.getByTestId('agent-add-submit').click();
    await expect(page.getByTestId('agent-add-error')).toBeVisible();
    await expect(form).toBeVisible();

    refuseCreate.value = false;
    await page.getByTestId('agent-add-submit').click();
    await expect(form).toBeHidden();
    const last = posts[posts.length - 1] as { role: unknown; expectedRosterRevision: string };
    expect(last.role).toEqual({ state: 'role', roleId: REVIEWER.id });
    expect(last.expectedRosterRevision).toBe('rev-1');
  });

  test('negative control: with no role API the "+" still adds, without a role', async ({ page }) => {
    await page.goto(`/worktrees/${E2E_WORKTREE_A}`);
    await page.getByTestId('agent-add-button').click();
    await expect(page.getByTestId('agent-add-tool')).toBeEnabled();
    await expect(page.getByTestId('agent-add-role-unavailable')).toBeVisible();
    await expect(page.getByTestId('agent-add-submit')).toBeEnabled();
  });
});

test.describe('roles in the settings on a phone (#4117)', () => {
  test('/more creates a role with a multi-line body, by tapping', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    let roles = [MARKETER];
    const created: Array<{ name: string; body: string }> = [];
    await page.route(
      (url) => url.pathname === '/api/roles',
      (route) => {
        if (route.request().method() === 'GET') return json(route, 200, { success: true, roles });
        const body = route.request().postDataJSON() as { name: string; body: string };
        created.push(body);
        const role = { ...MARKETER, id: 'aaaaaaaaaaaaaaaa', name: body.name };
        roles = [...roles, role];
        return json(route, 201, { success: true, role: { ...role, body: body.body } });
      },
    );
    await page.route(
      (url) => url.pathname === '/api/settings/agent-role-defaults',
      (route) => json(route, 200, { success: true, defaults: [{ cliToolId: 'claude', adapterEnabled: true, stored: { state: 'unset' } }] }),
    );

    await page.goto('/more');
    // `click` scrolls by itself and retries; a separate scroll fails if the first paint is replaced.
    await page.getByTestId('agent-role-new').click();
    await page.getByTestId('agent-role-create-name').fill('PM');
    await page.getByTestId('agent-role-create-body').fill('一行目\n二行目');
    await page.getByTestId('agent-role-create-submit').click();

    await expect(page.getByTestId('agent-role-row-aaaaaaaaaaaaaaaa')).toContainText('PM');
    expect(created).toEqual([{ name: 'PM', body: '一行目\n二行目' }]);
    await expect(page.getByTestId('agent-role-system-default-claude').locator('option', { hasText: 'PM' })).toHaveCount(1);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
