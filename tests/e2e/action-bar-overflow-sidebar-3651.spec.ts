/**
 * E2E: the second row's "…" panel stays in the body at 1024x768 with the
 * sidebar open (Issue #3651).
 *
 * What this proves that the component tests cannot: the real sidebar width and
 * the real panel width. The UAT capture (`T06-1024-overflow-open.png`) had the
 * panel wider than the room left of "…", drawn from x=8 over the sidebar.
 *
 * PC-only surface → self-skip outside chromium, mirroring the split specs.
 */

import { test, expect, type Locator, type Page } from '@playwright/test';
import { E2E_WORKTREE_A, setupSplitTest } from './fixtures/terminal-split-helpers';

type Box = { x: number; y: number; width: number; height: number };

async function box(locator: Locator): Promise<Box> {
  const b = await locator.boundingBox();
  expect(b).not.toBeNull();
  return b!;
}

/** Mirror of SIDEBAR_WIDTH_STORAGE_KEY (src/contexts/SidebarContext.tsx). */
const SIDEBAR_WIDTH_KEY = 'mcbd-sidebar-width';
/** Mirror of PC_DISPLAY_SIZE_STORAGE_KEY (as in worktree-header-one-row-3590.spec.ts). */
const PC_DISPLAY_SIZE_KEY = 'mcbd-pc-display-size';

/** A note written yesterday at 14:32 (local): its stamp shows the date. */
function yesterdayAt1432(): number {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  d.setHours(14, 32, 0, 0);
  return d.getTime();
}

/** The note the list serves for the lone split's session (asserted as drawn). */
const NOTE_TEXT = 'waiting on the review of the migration';

/**
 * Issue #3651: the lone split's session is running (End is drawn) and carries
 * a note from an earlier day. Registered AFTER `setupSplitTest`, so these
 * win; everything else falls back to its catch-all.
 *
 * Each body has the shape its route returns (read from the route, not guessed):
 * - `GET /api/worktrees` (src/app/api/worktrees/route.ts): `{ worktrees,
 *   repositories, ... }`, each row the worktree plus its status, `sessionNotes`,
 *   `autoYesByInstance` and `lastActivityByInstance`. The shared cache reads
 *   `data.worktrees` (src/hooks/useWorktreesCache.ts), and the note is read from
 *   that list (`useSessionNote`), so a bare array would leave no note to draw.
 * - `GET /api/worktrees/:id` (src/app/api/worktrees/[id]/route.ts): the worktree
 *   with `gitStatus` and the session status spread in; no `sessionNotes`.
 * - `GET /api/worktrees/:id/current-output` (…/current-output/route.ts): the
 *   `CurrentOutputPayload` plus `agentMode`. End is drawn from its `isRunning`.
 */
async function mockRunningSessionWithNote(page: Page): Promise<void> {
  const running = { isRunning: true, isWaitingForResponse: false, isProcessing: false };
  const worktree = {
    id: E2E_WORKTREE_A,
    name: `E2E ${E2E_WORKTREE_A}`,
    path: `/tmp/${E2E_WORKTREE_A}`,
    repositoryPath: `/tmp/${E2E_WORKTREE_A}-repo`,
    repositoryName: 'e2e-repo',
    repositoryDisplayName: 'E2E Repo',
    description: 'E2E split test worktree',
    selectedAgents: ['claude', 'codex', 'gemini', 'vibe-local', 'opencode', 'copilot'],
    cliToolId: 'claude',
    status: 'ready',
  };
  const sessionStatus = {
    sessionStatusByCli: { claude: running },
    sessionStatusByInstance: { claude: running },
    isSessionRunning: true,
    isWaitingForResponse: false,
    isProcessing: false,
  };
  const gitStatus = {
    currentBranch: 'main',
    initialBranch: 'main',
    isBranchMismatch: false,
    commitHash: 'e2e0000',
    isDirty: false,
  };
  const listRow = {
    ...worktree,
    ...sessionStatus,
    sessionNotes: { claude: { text: NOTE_TEXT, updatedAt: yesterdayAt1432() } },
    autoYesByInstance: {},
    lastActivityByInstance: {},
  };
  const detail = { ...worktree, gitStatus, ...sessionStatus };
  await page.route(
    (url) => url.pathname.startsWith('/api/worktrees'),
    async (route) => {
      const { pathname } = new URL(route.request().url());
      const json = (body: unknown) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      if (pathname === '/api/worktrees') return json({ worktrees: [listRow], repositories: [] });
      if (pathname === `/api/worktrees/${E2E_WORKTREE_A}`) return json(detail);
      if (pathname.startsWith(`/api/worktrees/${E2E_WORKTREE_A}/current-output`)) {
        return json({
          isRunning: true,
          cliToolId: 'claude',
          sessionName: `mcbd-claude-${E2E_WORKTREE_A}`,
          sessionStatus: 'ready',
          sessionStatusReason: 'input_prompt',
          content: '',
          fullOutput: '',
          realtimeSnippet: '',
          lineCount: 0,
          thinking: false,
          isPromptWaiting: false,
          isSelectionListActive: false,
          agentMode: 'unknown',
        });
      }
      return route.fallback();
    },
  );
}

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** Inside `outer` (sub-pixel slack), and painted on top at its centre. */
async function expectInsideAndReachable(page: Page, locator: Locator, outer: Box): Promise<Box> {
  const b = await box(locator);
  expect(b.x).toBeGreaterThanOrEqual(outer.x - 0.5);
  expect(b.x + b.width).toBeLessThanOrEqual(outer.x + outer.width + 0.5);
  expect(b.y).toBeGreaterThanOrEqual(outer.y - 0.5);
  expect(b.y + b.height).toBeLessThanOrEqual(outer.y + outer.height + 0.5);
  const hit = await locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return top !== null && (el === top || el.contains(top));
  });
  expect(hit).toBe(true);
  return b;
}

test.describe('Second row "…" panel beside the sidebar (Issue #3651)', () => {
  test.beforeEach(async ({ page: _page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'PC-only second row (chromium only)');
  });

  test('starts right of the sidebar at 1024x768 and stays inside the viewport', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await setupSplitTest(page, [E2E_WORKTREE_A]);
    await page.goto(`/worktrees/${E2E_WORKTREE_A}`);

    const sidebar = page.getByTestId('sidebar-container');
    await expect(sidebar).toBeVisible();
    const overflow = page.getByTestId('split-action-bar-items-overflow');
    await expect(overflow).toBeVisible();

    await overflow.click();
    const panel = page.getByTestId('split-action-bar-items-panel');
    await expect(panel).toBeVisible();
    // Off the button, so its own hover tooltip does not sit over the panel.
    await page.mouse.move(900, 600);

    const sidebarBox = await box(sidebar);
    const overflowBox = await box(overflow);
    const panelBox = await box(panel);
    // Positive control: right-aligned with "…", the panel would start left of
    // the body (the case the viewport-only clamp drew from x=8).
    expect(overflowBox.x + overflowBox.width - panelBox.width).toBeLessThan(
      sidebarBox.x + sidebarBox.width
    );
    expect(panelBox.x).toBeGreaterThanOrEqual(sidebarBox.x + sidebarBox.width);
    expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(1024);

    // Nothing of the sidebar is under the panel's left edge.
    const leftTop = await panel.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + 10, r.top + r.height / 2);
      return top !== null && (el === top || el.contains(top));
    });
    expect(leftTop).toBe(true);
  });

  test('fits every folded control in the panel at 768px with a 480px sidebar', async ({ page }) => {
    await page.addInitScript((key) => {
      try {
        localStorage.setItem(key, '480');
      } catch {
        /* storage unavailable - non-fatal */
      }
    }, SIDEBAR_WIDTH_KEY);
    await page.setViewportSize({ width: 768, height: 768 });
    await setupSplitTest(page, [E2E_WORKTREE_A]);
    await page.goto(`/worktrees/${E2E_WORKTREE_A}`);

    const sidebar = page.getByTestId('sidebar-container');
    await expect(sidebar).toBeVisible();
    await expect.poll(async () => Math.round((await box(sidebar)).width)).toBe(480);
    const overflow = page.getByTestId('split-action-bar-items-overflow');
    await expect(overflow).toBeVisible();

    await overflow.click();
    const panel = page.getByTestId('split-action-bar-items-panel');
    await expect(panel).toBeVisible();
    await page.mouse.move(700, 700);

    const sidebarBox = await box(sidebar);
    const panelBox = await box(panel);
    // In the body: right of the sidebar, inside the viewport, capped near 272px.
    expect(panelBox.x).toBeGreaterThanOrEqual(sidebarBox.x + sidebarBox.width);
    expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(768);
    expect(panelBox.width).toBeLessThanOrEqual(768 - 480 - 16 + 0.5);

    // Every folded control: inside the panel's box, on top, and apart.
    const ids = [
      'verification-status-chip',
      'verification-chip-reason-toggle',
      'cli-selector-0',
      'surface-mode-terminal-0',
      'surface-mode-chat-0',
    ];
    const boxes: Box[] = [];
    for (const id of ids) {
      boxes.push(await expectInsideAndReachable(page, panel.getByTestId(id), panelBox));
    }
    // The chip and the session controls do not overlap each other (ⓘ is the chip's own part).
    const apart = [boxes[0], boxes[2], boxes[3], boxes[4]];
    for (let i = 0; i < apart.length; i += 1) {
      for (let j = i + 1; j < apart.length; j += 1) {
        expect(overlaps(apart[i], apart[j])).toBe(false);
      }
    }
    // Nothing in the panel draws past its box (wrapped, not overrun).
    const overrun = await panel.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overrun).toBeLessThanOrEqual(0);
  });

  test('keeps the panel on one row where it fits (negative control)', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await setupSplitTest(page, [E2E_WORKTREE_A]);
    await page.goto(`/worktrees/${E2E_WORKTREE_A}`);
    const overflow = page.getByTestId('split-action-bar-items-overflow');
    await expect(overflow).toBeVisible();
    await overflow.click();
    const panel = page.getByTestId('split-action-bar-items-panel');
    await expect(panel).toBeVisible();
    await page.mouse.move(900, 600);

    const chip = await box(panel.getByTestId('verification-status-chip'));
    const selector = await box(panel.getByTestId('cli-selector-0'));
    // Same row: their vertical centres line up.
    expect(Math.abs(chip.y + chip.height / 2 - (selector.y + selector.height / 2))).toBeLessThan(4);
  });

  for (const size of ['medium', 'large'] as const) {
    test(`wraps a running session with an older note inside the panel (768px, 480px sidebar, ${size})`, async ({
      page,
    }) => {
      await page.addInitScript(
        ({ widthKey, sizeKey, size: value }) => {
          try {
            localStorage.setItem(widthKey, '480');
            localStorage.setItem(sizeKey, JSON.stringify(value));
          } catch {
            /* storage unavailable - non-fatal */
          }
        },
        { widthKey: SIDEBAR_WIDTH_KEY, sizeKey: PC_DISPLAY_SIZE_KEY, size },
      );
      await page.setViewportSize({ width: 768, height: 768 });
      await setupSplitTest(page, [E2E_WORKTREE_A]);
      await mockRunningSessionWithNote(page);
      await page.goto(`/worktrees/${E2E_WORKTREE_A}`);
      await expect(page.locator('html')).toHaveAttribute('data-pc-size', size);

      const overflow = page.getByTestId('split-action-bar-items-overflow');
      await expect(overflow).toBeVisible();
      await overflow.click();
      const panel = page.getByTestId('split-action-bar-items-panel');
      await expect(panel).toBeVisible();
      await page.mouse.move(700, 700);

      // Positive control: the conditions of the path — a running session (End
      // is drawn) and a note from an earlier day (its stamp carries the date).
      await expect(panel.getByTestId('terminal-end-session-button-0')).toBeVisible();
      // The note comes from the list (`data.worktrees`): if that mock lost its
      // shape, there would be no note here and this fails first.
      await expect(panel.getByTestId('split-session-note-0')).toContainText(NOTE_TEXT);
      await expect(panel.getByTestId('split-session-note-time-0')).toBeVisible();
      await expect(panel.getByTestId('split-session-note-time-0')).toHaveText(/\d+\/\d+ \d{2}:\d{2}/);

      const sidebarBox = await box(page.getByTestId('sidebar-container'));
      const panelBox = await box(panel);
      expect(panelBox.x).toBeGreaterThanOrEqual(sidebarBox.x + sidebarBox.width);
      expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(768);

      // Every control of the session row: inside the panel's box, on top, apart.
      const ids = [
        'cli-selector-0',
        'surface-mode-terminal-0',
        'surface-mode-chat-0',
        'split-session-note-0',
        'terminal-end-session-button-0',
      ];
      const boxes: Box[] = [];
      for (const id of ids) {
        boxes.push(await expectInsideAndReachable(page, panel.getByTestId(id), panelBox));
      }
      for (let i = 0; i < boxes.length; i += 1) {
        for (let j = i + 1; j < boxes.length; j += 1) {
          expect(overlaps(boxes[i], boxes[j])).toBe(false);
        }
      }
      // The note's time is drawn inside the note, not cut off by the row.
      const note = boxes[3];
      const stamp = await box(panel.getByTestId('split-session-note-time-0'));
      expect(stamp.x).toBeGreaterThanOrEqual(note.x - 0.5);
      expect(stamp.x + stamp.width).toBeLessThanOrEqual(note.x + note.width + 0.5);
      // The row wrapped rather than overran: nothing draws past it or the panel.
      const row = panel.getByTestId('split-bar-session-0');
      expect(await row.evaluate((el) => getComputedStyle(el).flexWrap)).toBe('wrap');
      expect(await row.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
      expect(await panel.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
    });
  }

  test('keeps the session row one line on the bar where it fits (negative control)', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await setupSplitTest(page, [E2E_WORKTREE_A]);
    await mockRunningSessionWithNote(page);
    await page.goto(`/worktrees/${E2E_WORKTREE_A}`);
    const row = page.getByTestId('split-bar-session-0');
    await expect(row).toBeVisible();
    await expect(page.getByTestId('split-action-bar-items-overflow')).toHaveCount(0);
    // Same conditions as the folded case: the note and End are on the bar.
    await expect(page.getByTestId('split-session-note-0')).toContainText(NOTE_TEXT);
    await expect(page.getByTestId('split-session-note-time-0')).toHaveText(/\d+\/\d+ \d{2}:\d{2}/);
    await expect(page.getByTestId('terminal-end-session-button-0')).toBeVisible();
    expect(await row.evaluate((el) => getComputedStyle(el).flexWrap)).toBe('nowrap');
  });
});
