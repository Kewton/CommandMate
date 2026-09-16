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
 *
 * ## Issue #2597: a PC split pane narrower than the control
 *
 * Three splits on a 1440px screen left a 218px pane, and in it the mode button
 * (104px, `Mode shift+tab`) was drawn 52px past its own 52px wrapper, on top of
 * the interrupt button. Two causes, two claims, both about layout — so both are
 * measured here rather than in jsdom:
 *
 * 4. **Nothing in the row overlaps.** In every pane, the button stays inside
 *    `agent-mode-control`, and the button, the chip and the caution keep clear
 *    of the interrupt button and of each other. The chip and the caution are
 *    compared by their PAINTED boxes (clipped by `overflow-hidden`), because
 *    what they give up is clipped rather than moved.
 * 5. **`shift+tab` follows the pane, not the viewport.** One viewport, panes of
 *    different widths: the wide pane prints the notation and the narrow one
 *    does not. claude is the narrow pane in one layout and the wide one in the
 *    other, so the same tool shows both answers on the same screen size.
 *
 * Measured before the fix (1440x900, panes 473/236/236): wrapper 52px, button
 * 104px, notation printed in all three panes. Dropping only `min-w-0` from the
 * wrapper was measured too, and is worse: in the 218px pane the send button
 * ends 236px past the composer's right edge.
 */

import { test, expect, type Page } from '@playwright/test';
import {
  AGENT_MODE_SPLITS,
  DESKTOP_VIEWPORT,
  E2E_AGENT_MODE_SPLIT_WORKTREE,
  E2E_AGENT_MODE_WORKTREE,
  PHONE_VIEWPORTS,
  WIDEST_PORTRAIT_PHONE,
  boxContains,
  boxesInSplit,
  boxesIntersect,
  mockAgentModeApi,
  mockAgentModeSplitApi,
  rectOf,
  seedActiveInstance,
  seedAgentModeSplits,
  type Box,
  type SpecialKeyLog,
} from './fixtures/agent-mode-helpers';

/** #2106's floor for the mobile terminal region, which this Issue must not move. */
const MIN_TERMINAL_HEIGHT_PX = 250;

/** #1127's tap-target minimum. */
const MIN_TAP_TARGET_PX = 44;

/**
 * Mirror of `AGENT_MODE_NOTATION_MIN_CONTAINER_PX` (AgentModeControl.tsx): the
 * composer-row width at which `shift+tab` is printed. Mirrored rather than
 * imported because that module is a client component.
 */
const NOTATION_MIN_ROW_PX = 400;

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

  test('prints codex\u2019s caution on a 360px phone without pushing the row off screen', async ({ page }) => {
    // #2592 UAT F3: the caution used to live only in `title`, which a touch
    // screen never shows. It is printed now — and the action row it joins is the
    // narrowest place on this screen, so the check is also that nothing, the
    // interrupt button least of all, was pushed past the right edge.
    const narrow = PHONE_VIEWPORTS[1];
    await page.setViewportSize({ width: narrow.width, height: narrow.height });
    await seedActiveInstance(page, 'codex');
    await mockAgentModeApi(page, { cliTool: 'codex', frame: 'codex-plan', agentMode: 'plan' });
    await openMobile(page);

    const note = page.locator('[data-testid="agent-mode-note"]');
    await expect(note).toBeVisible();
    const noteBox = await note.boundingBox();
    expect(noteBox).not.toBeNull();
    expect(noteBox!.width).toBeGreaterThan(0);
    expect(noteBox!.x + noteBox!.width).toBeLessThanOrEqual(narrow.width);

    const interrupt = await page.locator('[data-testid="interrupt-button"]').boundingBox();
    expect(interrupt).not.toBeNull();
    expect(interrupt!.x + interrupt!.width).toBeLessThanOrEqual(narrow.width);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('keeps the key notation off the widest portrait phone too (#2597)', async ({ page }) => {
    // The notation used to be hidden below the `sm` VIEWPORT; it now answers to
    // the composer row. Every portrait phone must still land on the hidden side,
    // and the widest one is the closest to the line.
    await page.setViewportSize({ ...WIDEST_PORTRAIT_PHONE });
    await seedActiveInstance(page, 'codex');
    await mockAgentModeApi(page, { cliTool: 'codex', frame: 'codex-plan', agentMode: 'plan' });
    await openMobile(page);

    await expect(page.locator('[data-testid="agent-mode-note"]')).toBeVisible();
    await expect(page.locator('[data-testid="agent-mode-key-notation"]')).toBeHidden();
    const row = await rectOf(page, 'composer-input-row');
    expect(row).not.toBeNull();
    expect(row!.width).toBeLessThan(NOTATION_MIN_ROW_PX);
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


/**
 * Three PC split layouts on one 1440x900 screen (files panel open, which
 * leaves the splits 945px). The width shares are pixel values on purpose, so
 * the panes come out at the Issue's own 218px and 455px.
 *
 * `rowFits` is whether the composer row can hold its fixed controls at all.
 * Before #2598 the PC composer was one row: attach, mode button, interrupt,
 * send and the gaps between them needed 194px, and a 218px pane has 174px, so
 * the send button ended 20px past the row with the textarea at 0px — what this
 * Issue guaranteed there was only that nothing was drawn on top of anything
 * else. #2598 moved the controls to a toolbar row of their own, leaving the
 * send button beside the textarea, and every pane below now fits (measured:
 * `sendPastRow` 0 in all nine panes). The flag is kept so a future layout that
 * cannot fit a pane says so here rather than by loosening the check.
 */
const SPLIT_LAYOUTS = [
  {
    name: 'claude narrow, codex wide',
    widths: [218, 455, 272],
    panes: [
      { min: 200, max: 230, notation: false, rowFits: true },
      { min: 440, max: 470, notation: true, rowFits: true },
      { min: 255, max: 290, notation: false, rowFits: true },
    ],
  },
  {
    name: 'claude wide, codex narrow',
    widths: [455, 218, 272],
    panes: [
      { min: 440, max: 470, notation: true, rowFits: true },
      { min: 200, max: 230, notation: false, rowFits: true },
      { min: 255, max: 290, notation: false, rowFits: true },
    ],
  },
  {
    // Before the fix, even an even three-way split drew codex's caution over
    // the interrupt button.
    name: 'three equal panes',
    widths: [1, 1, 1],
    panes: [
      { min: 300, max: 330, notation: false, rowFits: true },
      { min: 300, max: 330, notation: false, rowFits: true },
      { min: 300, max: 330, notation: false, rowFits: true },
    ],
  },
] as const;

const PANE_IDS = [
  'composer-input-row',
  'agent-mode-control',
  'agent-mode-cycle-button',
  'agent-mode-chip',
  'agent-mode-note',
  'interrupt-button',
  'send-message-button',
] as const;

async function openSplits(page: Page, widths: readonly number[]): Promise<void> {
  await seedAgentModeSplits(page, widths);
  await mockAgentModeSplitApi(page);
  await page.goto(`/worktrees/${E2E_AGENT_MODE_SPLIT_WORKTREE}`);
  await expect(page.getByTestId('terminal-split-container')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-testid^="terminal-split-pane-"]')).toHaveCount(
    AGENT_MODE_SPLITS.length,
  );
  // Every pane has read its own frame: all three chips, and codex's caution.
  await expect(page.locator('[data-testid="agent-mode-chip"]')).toHaveCount(AGENT_MODE_SPLITS.length);
  await expect(page.locator('[data-testid="agent-mode-note"]')).toHaveCount(1);
}

function paneBox(page: Page, splitIndex: number): Promise<Box | null> {
  return page.evaluate(idx => {
    const el = document.querySelector(`[data-testid="terminal-split-pane-${idx}"]`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
  }, splitIndex);
}

test.describe('[#2597] desktop split panes', () => {
  test.use({ viewport: { ...DESKTOP_VIEWPORT } });

  test.beforeEach(({ browserName }) => {
    // PC-only split UI (the same self-skip the other split specs use).
    test.skip(browserName !== 'chromium', 'PC-only split UI (chromium only)');
  });

  for (const layout of SPLIT_LAYOUTS) {
    test(`nothing in the composer row overlaps: ${layout.name}`, async ({ page }) => {
      await openSplits(page, layout.widths);

      for (const [index, expected] of layout.panes.entries()) {
        const tool = AGENT_MODE_SPLITS[index].cliTool;
        const label = `${layout.name} / pane ${index} (${tool})`;
        const pane = await paneBox(page, index);
        const b = await boxesInSplit(page, index, PANE_IDS);

        expect(pane, label).not.toBeNull();
        expect(pane!.width, `${label}: pane width`).toBeGreaterThanOrEqual(expected.min);
        expect(pane!.width, `${label}: pane width`).toBeLessThanOrEqual(expected.max);

        const control = b['agent-mode-control']!.box;
        const button = b['agent-mode-cycle-button']!.box;
        const interrupt = b['interrupt-button']!.box;
        const row = b['composer-input-row']!.box;
        const send = b['send-message-button']!.box;

        // eslint-disable-next-line no-console -- the measurement is the deliverable
        console.log(`MEASURE-2597 ${label} ` + JSON.stringify({
          pane: pane!.width,
          row: row.width,
          sendPastRow: send.right - row.right,
          control: control.width,
          button: button.width,
          chip: b['agent-mode-chip']?.visible?.width ?? 0,
          note: b['agent-mode-note']?.visible?.width ?? null,
        }));

        // The button never leaves its own box, and never reaches the interrupt.
        expect(boxContains(control, button), `${label}: button inside control`).toBe(true);
        expect(boxesIntersect(button, interrupt), `${label}: button vs interrupt`).toBe(false);
        expect(boxesIntersect(control, interrupt), `${label}: control vs interrupt`).toBe(false);

        // The captions give way by being clipped, so what they PAINT has to stay
        // inside the control, clear of the button, the interrupt and each other.
        const painted = (['agent-mode-chip', 'agent-mode-note'] as const)
          .map(id => ({ id, box: b[id]?.visible ?? null }))
          .filter((c): c is { id: typeof c.id; box: Box } => c.box !== null);
        for (const caption of painted) {
          const what = `${label}: ${caption.id}`;
          expect(boxContains(control, caption.box), `${what} inside control`).toBe(true);
          expect(boxesIntersect(caption.box, button), `${what} vs button`).toBe(false);
          expect(boxesIntersect(caption.box, interrupt), `${what} vs interrupt`).toBe(false);
        }
        if (painted.length === 2) {
          expect(boxesIntersect(painted[0].box, painted[1].box), `${label}: chip vs note`).toBe(false);
        }

        // The send button is not drawn over either, wherever it ends up.
        expect(boxesIntersect(send, button), `${label}: send vs button`).toBe(false);
        expect(boxesIntersect(send, interrupt), `${label}: send vs interrupt`).toBe(false);
        for (const caption of painted) {
          expect(boxesIntersect(send, caption.box), `${label}: send vs ${caption.id}`).toBe(false);
        }

        // Not fixed by pushing the problem along. Where the row has room for its
        // controls, the send button stays inside it; where it has not, the
        // overshoot is bounded by the part of the mode button the row could not
        // give back — one tap target, not the whole control. Dropping only
        // `min-w-0` failed both on the one-row composer: the send button left
        // the 272px and 315px rows, and ended 236px past the 218px one. Since
        // #2598's two-row composer every layout here takes the first branch.
        if (expected.rowFits) {
          expect(boxContains(row, send), `${label}: send inside row`).toBe(true);
        } else {
          expect(send.right - row.right, `${label}: send overshoot`).toBeLessThanOrEqual(send.width);
        }
      }
    });
  }

  test('prints shift+tab by pane width, not by viewport width', async ({ page }) => {
    // Same 1440px viewport throughout — under the old `sm:` rule every pane
    // below printed the notation.
    // One tab per layout: the seed is guarded per tab (sessionStorage), so a
    // new tab is what lets the second layout replace the first.
    for (const layout of SPLIT_LAYOUTS.slice(0, 2)) {
      const fresh = await page.context().newPage();
      await openSplits(fresh, layout.widths);

      for (const [index, expected] of layout.panes.entries()) {
        const tool = AGENT_MODE_SPLITS[index].cliTool;
        const label = `${layout.name} / pane ${index} (${tool})`;
        const pane = fresh.getByTestId(`terminal-split-pane-${index}`);
        const notation = pane.getByTestId('agent-mode-key-notation');
        const button = pane.getByTestId('agent-mode-cycle-button');
        const row = (await boxesInSplit(fresh, index, ['composer-input-row']))['composer-input-row']!.box;

        if (expected.notation) {
          await expect(notation, label).toBeVisible();
          expect(row.width, `${label}: row width`).toBeGreaterThanOrEqual(NOTATION_MIN_ROW_PX);
        } else {
          await expect(notation, label).toBeHidden();
          expect(row.width, `${label}: row width`).toBeLessThan(NOTATION_MIN_ROW_PX);
        }
        // Hidden from the eye only: the accessible name still carries the key.
        await expect(button, label).toHaveAttribute('aria-label', /\(shift\+tab\)/);
      }
      await fresh.close();
    }
  });
});
