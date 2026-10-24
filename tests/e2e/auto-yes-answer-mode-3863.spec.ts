/**
 * E2E: choosing Auto-Yes's answer mode when turning it on, on a desktop and on
 * a phone (Issue #3863).
 *
 * The confirm dialog offers 「質問は推奨で回答（おまかせ）」 and
 * 「質問は自分で回答（慎重）」; the choice reaches `POST .../auto-yes` as
 * `answerMode` and the toggle labels the mode while ON. A change made from
 * another tab shows up on the next whole-worktree re-read.
 *
 * Written not to depend on any default: every test clicks the mode it wants
 * (even おまかせ), and reads the label by `data-answer-mode`, not by its
 * translated text, so the locale and the dialog's initial selection do not
 * matter. The worktree id is this spec's own, so parallel specs are untouched.
 *
 * No agent process is involved; `/api/` is mocked in the browser.
 */

import { test, expect, type Page, type Route } from '@playwright/test';

const WORKTREE_ID = 'e2e-auto-yes-answer-mode-3863';
const DESKTOP_VIEWPORT = { width: 1440, height: 900 } as const;
const PHONE_VIEWPORT = { width: 390, height: 730 } as const;

/** Mirror of `AUTO_YES_CONTRACT_REFRESH_MS` (useWorktreeDetailController), plus slack. */
const REREAD_WAIT_MS = 12_000 + 8_000;

type Mode = 'recommended' | 'careful';

interface FakeAutoYes {
  enabled: boolean;
  mode: Mode | null;
  posts: Array<Record<string, unknown>>;
}

function fulfillJson(route: Route, body: unknown): Promise<void> {
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
}

function buildWorktree(): Record<string, unknown> {
  return {
    id: WORKTREE_ID,
    name: `E2E ${WORKTREE_ID}`,
    path: `/tmp/${WORKTREE_ID}`,
    repositoryPath: `/tmp/${WORKTREE_ID}-repo`,
    repositoryName: 'e2e-repo',
    repositoryDisplayName: 'E2E Repo',
    description: 'E2E auto-yes answer mode worktree',
    selectedAgents: ['claude'],
    agentInstances: [{ id: 'claude', cliTool: 'claude', alias: 'claude', order: 0 }],
    cliToolId: 'claude',
    status: 'ready',
    sessionStatusByCli: {
      claude: { isRunning: true, isWaitingForResponse: false, isProcessing: false },
    },
    gitStatus: {
      currentBranch: 'main',
      initialBranch: 'main',
      isBranchMismatch: false,
      commitHash: 'e2e0000',
      isDirty: false,
    },
  };
}

async function mockApi(page: Page, state: FakeAutoYes): Promise<void> {
  const worktree = buildWorktree();
  const expiresAt = (): number | null => (state.enabled ? Date.now() + 3_600_000 : null);

  await page.route(
    url => url.pathname.startsWith('/api/'),
    async route => {
      const request = route.request();
      const { pathname } = new URL(request.url());

      if (pathname === '/api/worktrees' || pathname.endsWith('/api/worktrees')) {
        return fulfillJson(route, [worktree]);
      }

      const detailMatch = pathname.match(/\/api\/worktrees\/([^/]+)(\/.*)?$/);
      if (detailMatch) {
        const sub = detailMatch[2] ?? '';
        if (sub === '') return fulfillJson(route, worktree);
        if (sub.startsWith('/auto-yes')) {
          if (request.method() === 'POST') {
            const body = JSON.parse(request.postData() ?? '{}') as Record<string, unknown>;
            state.posts.push(body);
            state.enabled = body.enabled === true;
            state.mode = state.enabled ? ((body.answerMode as Mode | undefined) ?? 'recommended') : null;
            return fulfillJson(route, {
              enabled: state.enabled,
              expiresAt: expiresAt(),
              ...(state.enabled ? { answerMode: state.mode } : {}),
            });
          }
          return fulfillJson(route, {
            enabled: state.enabled,
            expiresAt: expiresAt(),
            agents: { claude: { enabled: state.enabled, expiresAt: expiresAt() } },
            instances: { claude: { enabled: state.enabled, expiresAt: expiresAt() } },
            answerModeByInstance: state.enabled && state.mode ? { claude: state.mode } : {},
          });
        }
        if (sub.startsWith('/current-output')) {
          return fulfillJson(route, {
            isRunning: true,
            cliToolId: 'claude',
            sessionStatus: 'ready',
            isGenerating: false,
            isPromptWaiting: false,
            content: '> ',
            fullOutput: '> ',
            realtimeSnippet: '> ',
            thinking: false,
            isSelectionListActive: false,
            isPagerActive: false,
            isDismissablePanelActive: false,
            isUnclassifiedActive: false,
            autoYes: { enabled: state.enabled, expiresAt: expiresAt() },
            ...(state.enabled && state.mode ? { autoYesAnswerMode: state.mode } : {}),
          });
        }
        if (sub.startsWith('/messages')) return fulfillJson(route, []);
        if (sub.startsWith('/memos')) return fulfillJson(route, []);
        if (sub.startsWith('/execution-logs')) return fulfillJson(route, []);
        if (sub.startsWith('/schedules')) return fulfillJson(route, []);
        if (sub.startsWith('/tree')) return fulfillJson(route, { items: [] });
        if (sub.startsWith('/tasks')) return fulfillJson(route, { tasks: [] });
        if (sub.startsWith('/verify/runs')) return fulfillJson(route, { runs: [] });
        if (sub.startsWith('/verify/config')) return fulfillJson(route, { exists: false, gates: [] });
        if (sub.startsWith('/slash-commands')) return fulfillJson(route, { groups: [] });
        return fulfillJson(route, {});
      }

      if (pathname.includes('/repositories')) return fulfillJson(route, []);
      if (pathname.includes('/tools')) return fulfillJson(route, []);
      return fulfillJson(route, {});
    },
  );
}

/** The Auto Yes switch (its accessible name is "Auto Yes モード" / "Auto Yes mode"). */
function autoYesSwitch(page: Page) {
  return page.getByRole('switch', { name: /Auto Yes/ }).first();
}

async function turnOnWith(page: Page, mode: Mode): Promise<void> {
  const toggle = autoYesSwitch(page);
  await expect(toggle).toBeVisible({ timeout: 30_000 });
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await toggle.click();

  const option = page.getByTestId(`auto-yes-answer-mode-${mode}`);
  await expect(option).toBeVisible();
  await expect(page.getByTestId('auto-yes-answer-mode-permission-note')).toBeVisible();
  await option.click();
  await expect(option).toHaveAttribute('aria-checked', 'true');
  await page.getByTestId('confirm-button').click();
}

for (const [label, viewport, query] of [
  ['desktop', DESKTOP_VIEWPORT, ''],
  ['phone', PHONE_VIEWPORT, '?pane=terminal'],
] as const) {
  test.describe(`[#3863] ${label}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    for (const mode of ['careful', 'recommended'] as const) {
      test(`turning Auto Yes on in ${mode} posts it and labels the toggle`, async ({ page }) => {
        const state: FakeAutoYes = { enabled: false, mode: null, posts: [] };
        await mockApi(page, state);
        await page.goto(`/worktrees/${WORKTREE_ID}${query}`);

        await turnOnWith(page, mode);

        await expect.poll(() => state.posts.at(-1)?.answerMode).toBe(mode);
        expect(state.posts.at(-1)).toMatchObject({ enabled: true, instanceId: 'claude' });
        const badge = page.getByTestId('auto-yes-answer-mode').first();
        await expect(badge).toBeVisible();
        await expect(badge).toHaveAttribute('data-answer-mode', mode);
        await expect(autoYesSwitch(page)).toHaveAttribute('aria-checked', 'true');
      });
    }

    test('another tab’s change of mode shows up on the next re-read', async ({ page }) => {
      const state: FakeAutoYes = { enabled: true, mode: 'careful', posts: [] };
      await mockApi(page, state);
      await page.goto(`/worktrees/${WORKTREE_ID}${query}`);

      const badge = page.getByTestId('auto-yes-answer-mode').first();
      await expect(badge).toHaveAttribute('data-answer-mode', 'careful', { timeout: 30_000 });

      state.mode = 'recommended';
      await expect(badge).toHaveAttribute('data-answer-mode', 'recommended', { timeout: REREAD_WAIT_MS });
    });
  });
}
