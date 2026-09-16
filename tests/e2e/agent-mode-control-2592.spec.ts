/**
 * E2E: the permission-mode control, on a phone and on a desktop (Issue #2592).
 *
 * Two claims that only a real browser can settle, and one that only a real
 * browser makes convincing.
 *
 * 1. **It costs the terminal nothing.** The control is placed in the composer's
 *    existing action row rather than in a strip of its own, and the reason is a
 *    pixel budget: #2106 keeps `TerminalDisplay` above 250px at 360x640, and
 *    #2131 measured the opencode strip against that floor. jsdom has no layout,
 *    so the unit suite can prove the button is in the DOM but not that its
 *    presence leaves the terminal where it was. The tests below measure the same
 *    `mobile-terminal-region` rect #2106 measures, at the same two viewports,
 *    with a claude session (which DOES draw the control) rather than an opencode
 *    one (which does not).
 *
 * 2. **The chip reads the real frame.** The fixture serves this Issue's
 *    checked-in captures, ANSI and all, so what the browser renders is derived
 *    from the same bytes the unit suite asserts on.
 *
 * 3. **A dialog disables it, and nothing is sent.** The fixture records every
 *    `/special-keys` POST, so "disabled" is checked as "no key left the browser"
 *    rather than as an attribute.
 *
 * No agent process is involved; `/api/` is mocked in the browser.
 */

import { test, expect } from '@playwright/test';
import {
  DESKTOP_VIEWPORT,
  E2E_AGENT_MODE_WORKTREE,
  PHONE_VIEWPORTS,
  mockAgentModeApi,
  rectOf,
  seedActiveInstance,
  type SpecialKeyLog,
} from './fixtures/agent-mode-helpers';

/** #2106's floor for the mobile terminal region, which this Issue must not move. */
const MIN_TERMINAL_HEIGHT_PX = 250;

/** #1127's tap-target minimum. */
const MIN_TAP_TARGET_PX = 44;

async function openMobile(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(`/worktrees/${E2E_AGENT_MODE_WORKTREE}?pane=terminal`);
  await page.waitForSelector('[data-testid="mobile-terminal-region"]', { timeout: 30_000 });
}

async function openDesktop(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(`/worktrees/${E2E_AGENT_MODE_WORKTREE}`);
  await page.waitForSelector('[data-testid="agent-mode-control"]', { timeout: 30_000 });
}

test.describe('[#2592] phone', () => {
  for (const viewport of PHONE_VIEWPORTS) {
    test(`draws the control and leaves the terminal above #2106's floor at ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await seedActiveInstance(page, 'claude');
      await mockAgentModeApi(page, { cliTool: 'claude', frame: 'claude-plan', agentMode: 'plan' });
      await openMobile(page);

      const control = page.locator('[data-testid="agent-mode-control"]');
      await expect(control).toBeVisible();

      const terminal = await rectOf(page, 'mobile-terminal-region');
      expect(terminal).not.toBeNull();
      expect(terminal!.height).toBeGreaterThan(MIN_TERMINAL_HEIGHT_PX);
    });
  }

  test('meets the tap-target minimum', async ({ page }) => {
    const [viewport] = PHONE_VIEWPORTS;
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await seedActiveInstance(page, 'claude');
    await mockAgentModeApi(page, { cliTool: 'claude', frame: 'claude-plan', agentMode: 'plan' });
    await openMobile(page);

    const box = await page.locator('[data-testid="agent-mode-cycle-button"]').boundingBox();
    expect(box).not.toBeNull();
    // Width, not height: the button sits in a row whose siblings already set the
    // 44px line height, and a pill that is 44px tall in a 36px row would be the
    // thing that moves the composer.
    expect(box!.width).toBeGreaterThanOrEqual(MIN_TAP_TARGET_PX);
  });

  test('shows the mode the served frame is in', async ({ page }) => {
    const [viewport] = PHONE_VIEWPORTS;
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await seedActiveInstance(page, 'claude');
    await mockAgentModeApi(page, {
      cliTool: 'claude',
      frame: 'claude-accept-edits',
      agentMode: 'accept-edits',
    });
    await openMobile(page);

    await expect(page.locator('[data-testid="agent-mode-chip"]')).toHaveText('accept edits');
  });
});

test.describe('[#2592] desktop', () => {
  test.use({ viewport: { ...DESKTOP_VIEWPORT } });

  test('sends BTab once, for the pane it is mounted on', async ({ page }) => {
    await seedActiveInstance(page, 'claude');
    const sent: SpecialKeyLog = await mockAgentModeApi(page, {
      cliTool: 'claude',
      frame: 'claude-plan',
      agentMode: 'plan',
    });
    await openDesktop(page);

    await expect(page.locator('[data-testid="agent-mode-chip"]').first()).toHaveText('plan');
    await page.locator('[data-testid="agent-mode-cycle-button"]').first().click();

    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toMatchObject({ cliToolId: 'claude', keys: ['BTab'] });
  });

  test('is disabled while a selection list is on screen, and sends nothing', async ({ page }) => {
    // The frame this stands in for is a permission dialog, where claude binds
    // `shift+tab` to "Yes, allow all edits during this session". A button that
    // was merely styled as disabled would still grant it.
    await seedActiveInstance(page, 'claude');
    const sent: SpecialKeyLog = await mockAgentModeApi(page, {
      cliTool: 'claude',
      frame: 'claude-plan',
      agentMode: 'plan',
      isSelectionListActive: true,
    });
    await openDesktop(page);

    const button = page.locator('[data-testid="agent-mode-cycle-button"]').first();
    await expect(button).toBeDisabled();
    await button.click({ force: true });

    await page.waitForTimeout(300);
    expect(sent).toHaveLength(0);
  });

  test('draws nothing for a tool with no mode cycle', async ({ page }) => {
    await seedActiveInstance(page, 'opencode');
    await mockAgentModeApi(page, {
      cliTool: 'opencode',
      frame: 'claude-plan',
      agentMode: 'unknown',
    });
    await page.goto(`/worktrees/${E2E_AGENT_MODE_WORKTREE}`);
    await page.waitForSelector('[data-testid="message-input-textarea"]', { timeout: 30_000 });

    await expect(page.locator('[data-testid="agent-mode-control"]')).toHaveCount(0);
  });
});
