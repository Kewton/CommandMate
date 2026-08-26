/**
 * E2E: the mobile opencode quick-keys strip is folded away by default (#2106).
 *
 * This spec exists because #2106's claim is a *pixel* claim and there is no
 * other place in the suite that can settle it. jsdom has no layout, so the unit
 * tests can prove the strip is absent from the DOM but not that its absence
 * gives the terminal its height back; and the Issue's own numbers were derived
 * from label widths on paper, not from a browser.
 *
 * ## What was measured, before the fix
 *
 * Same harness, same two viewports, against the pre-#2106 always-open strip:
 *
 *   | viewport | quick-keys strip | rows | TerminalDisplay |
 *   |----------|------------------|------|-----------------|
 *   | 390x730  | 378px            | 7    | **40px**        |
 *   | 360x640  | 378px            | 7    | **0px**         |
 *
 * The Issue estimated ~265px for the strip and ~140px left for the terminal.
 * The real strip is ~113px taller than the estimate and the real terminal is
 * ~100px shorter at 390x730 — and at 360x640 the terminal is not small, it is
 * gone. The user report ("the terminal is barely visible") was accurate and the
 * strip was the cause.
 *
 * No opencode process is involved: `/api/` is mocked in the browser, which is
 * enough because the strip's gate is two fields on `/current-output`.
 */

import { test, expect } from '@playwright/test';
import {
  E2E_OPENCODE_WORKTREE,
  PHONE_VIEWPORTS,
  mockOpencodeWorktreeApi,
  seedOpencodeActiveInstance,
  rectOf,
} from './fixtures/opencode-mobile-helpers';

/** Mirror of OPENCODE_QUICK_KEYS_OPEN_STORAGE_KEY (src/hooks/…Disclosure.ts). */
const DISCLOSURE_KEY = 'commandmate:mobile:opencodeQuickKeysOpen';

/** #1127's tap-target minimum, which the closed toggle has to keep meeting. */
const MIN_TAP_TARGET_PX = 44;

/** The seventeen keys #2046 measured, in the order the component declares them. */
const EXPECTED_KEY_IDS = [
  'agentNext', 'agentPrev', 'commands', 'variant',
  'agents', 'sessions', 'newSession', 'models', 'themes',
  'timeline', 'undo', 'redo', 'compact',
  'pageUp', 'pageDown', 'first', 'last',
];

async function openMobileTerminal(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(`/worktrees/${E2E_OPENCODE_WORKTREE}?pane=terminal`);
  await page.waitForSelector('[data-testid="mobile-terminal-region"]', { timeout: 30_000 });
}

/** Ids of the rendered key buttons, in DOM order. */
function renderedKeyIds(page: import('@playwright/test').Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid^="opencode-quick-key-"]'))
      .map(el => el.getAttribute('data-testid') ?? '')
      .filter(id => id !== 'opencode-quick-keys-toggle')
      .map(id => id.replace('opencode-quick-key-', ''))
  );
}

test.describe('Issue #2106: the mobile quick-keys strip starts folded', () => {
  test.beforeEach(async ({ page }) => {
    // Clear the persisted preference exactly ONCE per test, on the first
    // document load. `addInitScript` runs before app JS on EVERY document, so an
    // unguarded clear would also wipe the preference the reload test is trying
    // to observe surviving a reload (the same guard `clearSplitStorage` uses).
    await page.addInitScript(
      ({ key, guard }) => {
        try {
          if (sessionStorage.getItem(guard)) return;
          sessionStorage.setItem(guard, '1');
          localStorage.removeItem(key);
        } catch {
          /* storage unavailable - non-fatal */
        }
      },
      { key: DISCLOSURE_KEY, guard: '__e2e_2106_cleared__' },
    );
    await seedOpencodeActiveInstance(page);
    await mockOpencodeWorktreeApi(page);
  });

  for (const vp of PHONE_VIEWPORTS) {
    test(`gives the terminal its height back at ${vp.label}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await openMobileTerminal(page);

      // --- closed (the new default) ---------------------------------------
      const toggle = page.getByTestId('opencode-quick-keys-toggle');
      await expect(toggle).toBeVisible();
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await expect(page.getByTestId('opencode-quick-keys')).toHaveCount(0);

      const closedTerminal = await rectOf(page, 'mobile-terminal-region');
      const closedSlot = await rectOf(page, 'mobile-quick-keys-slot');
      const toggleRect = await rectOf(page, 'opencode-quick-keys-toggle');

      // --- open (one tap, exactly what #2046 needed to stay reachable) -----
      await toggle.click();
      await expect(page.getByTestId('opencode-quick-keys')).toBeVisible();
      const openTerminal = await rectOf(page, 'mobile-terminal-region');
      const openSlot = await rectOf(page, 'mobile-quick-keys-slot');

      // eslint-disable-next-line no-console -- the measurement is the deliverable
      console.log(`MEASURE-2106 ${vp.label} ` + JSON.stringify({
        closedTerminal: closedTerminal?.height,
        openTerminal: openTerminal?.height,
        closedSlot: closedSlot?.height,
        openSlot: openSlot?.height,
        recovered: (closedTerminal?.height ?? 0) - (openTerminal?.height ?? 0),
      }));

      // The whole point: closing the strip hands its pixels to the terminal.
      expect(closedTerminal!.height).toBeGreaterThan(openTerminal!.height);
      const recovered = closedTerminal!.height - openTerminal!.height;
      const surrendered = openSlot!.height - closedSlot!.height;
      // The terminal can never gain more than the slot gives up — they are the
      // two children of one flex column competing for the same leftover space.
      expect(recovered).toBeLessThanOrEqual(surrendered + 1);
      if (openTerminal!.height > 0) {
        // When the open layout still fits, the exchange is exact.
        expect(Math.abs(recovered - surrendered)).toBeLessThanOrEqual(1);
      } else {
        // …and when it does not fit, the terminal is driven to ZERO and the
        // strip overflows the pane it shares. That is the 360x640 case, and it
        // is why the recovered height is smaller than what the slot gave up.
        expect(surrendered).toBeGreaterThan(recovered);
      }
      // Pre-#2106 this was 40px at 390x730 and 0px at 360x640. Anything in that
      // range is "the terminal is not usable", which is the bug.
      expect(closedTerminal!.height).toBeGreaterThan(250);

      // The closed footprint is one row and it is still tappable.
      expect(toggleRect!.height).toBeGreaterThanOrEqual(MIN_TAP_TARGET_PX);
      expect(closedSlot!.height).toBeLessThan(MIN_TAP_TARGET_PX * 2);
    });
  }

  test('opening reveals the same seventeen keys in the same order', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 730 });
    await openMobileTerminal(page);

    expect(await renderedKeyIds(page)).toEqual([]);
    await page.getByTestId('opencode-quick-keys-toggle').click();
    expect(await renderedKeyIds(page)).toEqual(EXPECTED_KEY_IDS);
  });

  test('sends the leader chord from a key revealed by the disclosure', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 730 });
    await openMobileTerminal(page);
    await page.getByTestId('opencode-quick-keys-toggle').click();

    const [request] = await Promise.all([
      page.waitForRequest(req => req.url().includes('/special-keys') && req.method() === 'POST'),
      page.getByTestId('opencode-quick-key-agents').click(),
    ]);
    expect(JSON.parse(request.postData() ?? '{}')).toMatchObject({
      cliToolId: 'opencode',
      keys: ['C-x', 'a'],
    });
  });

  test('remembers the open state across a reload', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 730 });
    await openMobileTerminal(page);
    await page.getByTestId('opencode-quick-keys-toggle').click();
    await expect(page.getByTestId('opencode-quick-keys')).toBeVisible();

    await page.reload();
    await page.waitForSelector('[data-testid="opencode-quick-keys-toggle"]', { timeout: 30_000 });
    await expect(page.getByTestId('opencode-quick-keys')).toBeVisible();
    await expect(page.getByTestId('opencode-quick-keys-toggle')).toHaveAttribute(
      'aria-expanded',
      'true'
    );

    // …and the closed state too, so the preference is a preference and not a
    // one-way latch.
    await page.getByTestId('opencode-quick-keys-toggle').click();
    await page.reload();
    await page.waitForSelector('[data-testid="opencode-quick-keys-toggle"]', { timeout: 30_000 });
    await expect(page.getByTestId('opencode-quick-keys')).toHaveCount(0);
  });
});

test.describe('Issue #2106 acceptance: other tools are untouched', () => {
  for (const cliTool of ['claude', 'codex', 'copilot']) {
    test(`${cliTool} renders neither the strip nor the toggle`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 730 });
      await seedOpencodeActiveInstance(page, E2E_OPENCODE_WORKTREE, cliTool);
      await mockOpencodeWorktreeApi(page, E2E_OPENCODE_WORKTREE, cliTool);
      await openMobileTerminal(page);

      await expect(page.getByTestId('opencode-quick-keys-toggle')).toHaveCount(0);
      await expect(page.getByTestId('opencode-quick-keys')).toHaveCount(0);
      // The slot is still there (it is gated on isRunning, not on the tool), and
      // it is empty — which is exactly what it was before #2106.
      const slot = await rectOf(page, 'mobile-quick-keys-slot');
      expect(slot!.height).toBeLessThanOrEqual(4);
    });
  }
});
