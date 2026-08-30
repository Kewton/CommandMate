/**
 * E2E: the PC opencode quick-keys strip can be folded away (#2131).
 *
 * ## Why this spec exists at all
 *
 * #2106 folded the strip on the phone and wrote into `OpencodeQuickKeys` that PC
 * did not need the same treatment "because a split pane has the width and
 * nothing there is being squeezed". That sentence was never measured. #2131
 * measured it and it is false:
 *
 *   | PC configuration      | quick keys        | TerminalDisplay |
 *   |-----------------------|-------------------|-----------------|
 *   | claude, 1 split       | none              | 670px           |
 *   | opencode, 1 split     | 206px             | 456px  (-32%)   |
 *   | opencode, 3 splits    | 578px / 11 rows   | **64px** (-90%) |
 *
 * The same failure mode as #2106, one screen over: the footer block is
 * `flex-shrink-0` and `TerminalDisplay` is the only `flex-1 min-h-0` sibling, so
 * the strip's height comes out of the terminal and out of nothing else.
 *
 * jsdom cannot settle this — it has no layout, so a unit test can prove the
 * strip left the DOM but not that its absence gave the terminal its height back
 * — and #2106's own history shows a paper estimate is not good enough either
 * (its ~265px guess was 113px short of the browser's 378px). So the numbers here
 * come from `getBoundingClientRect()` in a real browser, and this file is the
 * regression guard #2106 did not have: remove `collapsible` from
 * `TerminalSplitPaneContent` and every test below fails on a missing toggle.
 *
 * ## The control is inside the frame
 *
 * Split 0 runs opencode; splits 1 and 2 run claude and codex, which render no
 * strip at all (`OpencodeQuickKeys` returns null for every other tool). Same
 * viewport, same pane geometry, same poll payload — the only difference is the
 * strip, exactly as the Issue reported it.
 *
 * ## What this spec measured (1920x1080, three splits, run 2026-08-30)
 *
 *   | state                        | strip | footer | TerminalDisplay |
 *   |------------------------------|-------|--------|-----------------|
 *   | open (the PC default)        | 344px | 432px  | 497px           |
 *   | closed (one click)           |  44px | 132px  | 797px           |
 *   | control split (claude)       |  none |  80px  | 849px           |
 *
 * Closing hands the terminal exactly the 300px the footer gives up, and leaves
 * it within one toggle row of a split that never had a strip. The open row is
 * already better than the Issue's 64px because the same change drops the key
 * notation on a narrow pane: putting `inline` back in place of the container
 * query and re-running this file gives 494px of strip and 347px of terminal.
 *
 * No opencode process is involved: `/api/` is mocked in the browser, which is
 * enough because the strip's gate is two fields on `/current-output`.
 */

import { test, expect, type Page } from '@playwright/test';
import {
  DESKTOP_SPLIT_TOOLS,
  E2E_DESKTOP_OPENCODE_WORKTREE,
  mockDesktopOpencodeApi,
  rectInSplit,
  seedDesktopOpencodeSplits,
} from './fixtures/opencode-desktop-helpers';

/** Mirrors of the two disclosure keys (src/hooks/useOpencodeQuickKeysDisclosure.ts). */
const DESKTOP_KEY = 'commandmate:desktop:opencodeQuickKeysOpen';
const MOBILE_KEY = 'commandmate:mobile:opencodeQuickKeysOpen';

/** The pane the Issue measured, and the two that are its in-frame control. */
const OPENCODE_SPLIT = 0;
const CONTROL_SPLIT = 1;

/**
 * What the Issue measured for the 3-split opencode pane, in px. Any terminal
 * height near this is "the terminal is not usable", which is the bug.
 */
const BROKEN_TERMINAL_PX = 64;

/** The seventeen keys #2046 measured, in the order the component declares them. */
const EXPECTED_KEY_IDS = [
  'agentNext', 'agentPrev', 'commands', 'variant',
  'agents', 'sessions', 'newSession', 'models', 'themes',
  'timeline', 'undo', 'redo', 'compact',
  'pageUp', 'pageDown', 'first', 'last',
];

test.use({ viewport: { width: 1920, height: 1080 } });

/** Scope a testid to one split pane — the strip's testids carry no split index. */
function inSplit(page: Page, splitIndex: number, testId: string) {
  return page
    .getByTestId(`terminal-split-pane-${splitIndex}`)
    .getByTestId(testId);
}

async function openDesktopWorktree(page: Page): Promise<void> {
  await page.goto(`/worktrees/${E2E_DESKTOP_OPENCODE_WORKTREE}`);
  await expect(page.getByTestId('terminal-split-container')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-testid^="terminal-split-pane-"]')).toHaveCount(
    DESKTOP_SPLIT_TOOLS.length,
  );
}

/** Ids of the key buttons rendered inside one split, in DOM order. */
function renderedKeyIds(page: Page, splitIndex: number): Promise<string[]> {
  return page.evaluate(idx => {
    const pane = document.querySelector(`[data-testid="terminal-split-pane-${idx}"]`);
    return Array.from(pane?.querySelectorAll('[data-testid^="opencode-quick-key-"]') ?? [])
      .map(el => el.getAttribute('data-testid') ?? '')
      .filter(id => id !== 'opencode-quick-keys-toggle')
      .map(id => id.replace('opencode-quick-key-', ''));
  }, splitIndex);
}

test.describe('Issue #2131: the PC quick-keys strip folds away', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    // PC-only split UI (the same self-skip the other split specs use).
    test.skip(testInfo.project.name !== 'chromium', 'PC-only split UI (chromium only)');
    await seedDesktopOpencodeSplits(page, [DESKTOP_KEY, MOBILE_KEY]);
    await mockDesktopOpencodeApi(page);
  });

  test('gives the 3-split terminal its height back when closed', async ({ page }) => {
    await openDesktopWorktree(page);

    const toggle = inSplit(page, OPENCODE_SPLIT, 'opencode-quick-keys-toggle');
    await expect(toggle).toBeVisible();

    // --- open (the PC default, and what #2131 measured as the bug) ----------
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(inSplit(page, OPENCODE_SPLIT, 'opencode-quick-keys')).toBeVisible();

    const openTerminal = await rectInSplit(page, OPENCODE_SPLIT, `split-terminal-slot-${OPENCODE_SPLIT}`);
    const openFooter = await rectInSplit(page, OPENCODE_SPLIT, `split-footer-${OPENCODE_SPLIT}`);
    const openStrip = await rectInSplit(page, OPENCODE_SPLIT, 'opencode-quick-keys-disclosure');

    // The in-frame control: same viewport, same pane, no strip.
    const controlTerminal = await rectInSplit(page, CONTROL_SPLIT, `split-terminal-slot-${CONTROL_SPLIT}`);
    const controlFooter = await rectInSplit(page, CONTROL_SPLIT, `split-footer-${CONTROL_SPLIT}`);
    await expect(inSplit(page, CONTROL_SPLIT, 'opencode-quick-keys-toggle')).toHaveCount(0);

    // --- closed (one click, which is the whole fix) ------------------------
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(inSplit(page, OPENCODE_SPLIT, 'opencode-quick-keys')).toHaveCount(0);

    const closedTerminal = await rectInSplit(page, OPENCODE_SPLIT, `split-terminal-slot-${OPENCODE_SPLIT}`);
    const closedFooter = await rectInSplit(page, OPENCODE_SPLIT, `split-footer-${OPENCODE_SPLIT}`);
    const closedStrip = await rectInSplit(page, OPENCODE_SPLIT, 'opencode-quick-keys-disclosure');

    // eslint-disable-next-line no-console -- the measurement is the deliverable
    console.log('MEASURE-2131 3-split ' + JSON.stringify({
      openTerminal: openTerminal?.height,
      closedTerminal: closedTerminal?.height,
      controlTerminal: controlTerminal?.height,
      openStrip: openStrip?.height,
      closedStrip: closedStrip?.height,
      openFooter: openFooter?.height,
      closedFooter: closedFooter?.height,
      controlFooter: controlFooter?.height,
      stripWidth: openStrip?.width,
      recovered: (closedTerminal?.height ?? 0) - (openTerminal?.height ?? 0),
    }));

    // 1. Closing hands the strip's pixels to the terminal, and to nothing else.
    expect(closedTerminal!.height).toBeGreaterThan(openTerminal!.height);
    const recovered = closedTerminal!.height - openTerminal!.height;
    const surrendered = openFooter!.height - closedFooter!.height;
    expect(Math.abs(recovered - surrendered)).toBeLessThanOrEqual(2);

    // 2. The closed footprint is one toggle row, not seventeen buttons.
    expect(closedStrip!.height).toBeLessThan(openStrip!.height);
    expect(closedStrip!.height).toBeLessThanOrEqual(48);

    // 3. The Issue's number: 64px of terminal at three splits. Closed, the pane
    //    is within one toggle row of the control split that never had a strip.
    expect(closedTerminal!.height).toBeGreaterThan(BROKEN_TERMINAL_PX * 4);
    expect(closedTerminal!.height).toBeGreaterThan(controlTerminal!.height - 80);
    expect(closedTerminal!.height).toBeLessThanOrEqual(controlTerminal!.height + 2);
  });

  test('drops the key notation on a narrow pane and prints it on a wide one', async ({ page }) => {
    await openDesktopWorktree(page);

    // Three splits on a 1920px desktop: the strip is under the container-query
    // width, so the `ctrl+x a` suffix is not painted and the buttons wrap into
    // fewer rows. `compact` on the phone deletes the suffix; here it is hidden,
    // so the accessible name still carries it.
    const agents = inSplit(page, OPENCODE_SPLIT, 'opencode-quick-key-agents');
    await expect(agents).toBeVisible();
    const suffix = agents.locator('span');
    await expect(suffix).toBeHidden();
    await expect(agents).toHaveAttribute('aria-label', /ctrl\+x a/);

    const narrowStrip = await rectInSplit(page, OPENCODE_SPLIT, 'opencode-quick-keys');

    // Collapse to a single split: the same strip, several times wider.
    const removeBtn = page.getByTestId('remove-terminal-split');
    await removeBtn.click();
    await removeBtn.click();
    await expect(page.locator('[data-testid^="terminal-split-pane-"]')).toHaveCount(1);
    await expect(inSplit(page, OPENCODE_SPLIT, 'opencode-quick-keys')).toBeVisible();

    const wideStrip = await rectInSplit(page, OPENCODE_SPLIT, 'opencode-quick-keys');
    await expect(inSplit(page, OPENCODE_SPLIT, 'opencode-quick-key-agents').locator('span'))
      .toBeVisible();

    // eslint-disable-next-line no-console -- the measurement is the deliverable
    console.log('MEASURE-2131 notation ' + JSON.stringify({
      narrowWidth: narrowStrip?.width,
      narrowHeight: narrowStrip?.height,
      wideWidth: wideStrip?.width,
      wideHeight: wideStrip?.height,
    }));

    expect(wideStrip!.width).toBeGreaterThan(narrowStrip!.width);
    // One split fits the strip in far fewer wrapped rows than three do.
    expect(wideStrip!.height).toBeLessThan(narrowStrip!.height);
  });

  test('reveals the same seventeen keys, and sends the leader chord', async ({ page }) => {
    await openDesktopWorktree(page);

    expect(await renderedKeyIds(page, OPENCODE_SPLIT)).toEqual(EXPECTED_KEY_IDS);

    const [request] = await Promise.all([
      page.waitForRequest(req => req.url().includes('/special-keys') && req.method() === 'POST'),
      inSplit(page, OPENCODE_SPLIT, 'opencode-quick-key-agents').click(),
    ]);
    expect(JSON.parse(request.postData() ?? '{}')).toMatchObject({
      cliToolId: 'opencode',
      keys: ['C-x', 'a'],
    });

    // Folded, the keys are gone from the DOM rather than merely hidden — that is
    // what makes the pixels available to the terminal.
    await inSplit(page, OPENCODE_SPLIT, 'opencode-quick-keys-toggle').click();
    expect(await renderedKeyIds(page, OPENCODE_SPLIT)).toEqual([]);
  });

  test('remembers the fold across a reload, under a key of its own', async ({ page }) => {
    await openDesktopWorktree(page);
    await inSplit(page, OPENCODE_SPLIT, 'opencode-quick-keys-toggle').click();
    await expect(inSplit(page, OPENCODE_SPLIT, 'opencode-quick-keys')).toHaveCount(0);

    // The phone's preference must not have been touched — sharing one key would
    // mean folding the strip here folds it on the phone too.
    expect(await page.evaluate(k => localStorage.getItem(k), DESKTOP_KEY)).toBe('false');
    expect(await page.evaluate(k => localStorage.getItem(k), MOBILE_KEY)).toBeNull();

    await page.reload();
    await openDesktopWorktree(page);
    await expect(inSplit(page, OPENCODE_SPLIT, 'opencode-quick-keys-toggle')).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await expect(inSplit(page, OPENCODE_SPLIT, 'opencode-quick-keys')).toHaveCount(0);

    // …and the open state too, so the preference is a preference and not a
    // one-way latch.
    await inSplit(page, OPENCODE_SPLIT, 'opencode-quick-keys-toggle').click();
    await page.reload();
    await openDesktopWorktree(page);
    await expect(inSplit(page, OPENCODE_SPLIT, 'opencode-quick-keys')).toBeVisible();
  });
});

test.describe('Issue #2131 acceptance: other tools are untouched', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'PC-only split UI (chromium only)');
    await seedDesktopOpencodeSplits(page, [DESKTOP_KEY, MOBILE_KEY]);
    await mockDesktopOpencodeApi(page);
  });

  test('claude and codex splits render neither the strip nor the toggle', async ({ page }) => {
    await openDesktopWorktree(page);

    for (let splitIndex = 1; splitIndex < DESKTOP_SPLIT_TOOLS.length; splitIndex += 1) {
      await expect(inSplit(page, splitIndex, 'opencode-quick-keys-toggle')).toHaveCount(0);
      await expect(inSplit(page, splitIndex, 'opencode-quick-keys')).toHaveCount(0);
      await expect(inSplit(page, splitIndex, 'opencode-quick-keys-disclosure')).toHaveCount(0);
    }
  });
});
