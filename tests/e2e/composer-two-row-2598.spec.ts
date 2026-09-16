/**
 * E2E: the two-row PC composer and its height handle (Issue #2598).
 *
 * Every claim here is about layout, which jsdom does not have, so each one is
 * measured with `getBoundingClientRect()` in Chromium at the Issue's 1440x900
 * with the files panel open. `MessageInput-two-row-2598.test.tsx` pins the DOM
 * structure these numbers depend on.
 *
 * ## Phase 1: two rows
 *
 * #2592 added the mode button to a PC composer that kept every control on the
 * textarea's row, and only the textarea could shrink: in a 218px split pane it
 * was 0px wide. The toolbar now has a row of its own above [textarea][send], as
 * on the phone. That row costs height, and the pane's body pays it, so the
 * budget is measured against what the same fixture measured before the change
 * (develop 95f88a46, run 2026-09-17):
 *
 *   | layout / pane            | pane  | textarea | footer | body  |
 *   |--------------------------|-------|----------|--------|-------|
 *   | 1 split                  | 954px | 621px    | 80px   | 668px |
 *   | 3 splits, 218px (claude) | 218px | **0px**  | 100px  | 648px |
 *   | 3 splits, 455px (codex)  | 455px | **0px**  | 134px  | 614px |
 *   | 3 splits, 272px (copilot)| 272px | **0px**  | 100px  | 648px |
 *
 * (codex's pane carries its #2592 caution, and its frame shows the #1879
 * unsent-input bar, which is the 54px its footer has over the others. The
 * 100px footers are the meta row wrapping its hints onto a second line.)
 *
 * What the change measured is printed as `MEASURE-2598` and asserted below;
 * the numbers at the time of writing are in the table of
 * `COMPOSER_HINTS_MIN_CONTAINER_PX` (src/config/composer-layout.ts) and in
 * PRE_2598 / the assertions.
 *
 * ## Phase 2: the handle
 *
 * The handle is on the composer's top edge; up is taller. The textarea's
 * height comes out of the body above, which keeps
 * `COMPOSER_PANE_BODY_MIN_HEIGHT_PX`. A stored height is per worktree and per
 * split, survives a reload, and is only DRAWN smaller when the pane is shorter
 * (the #2421 grid): leaving the grid gives it back.
 *
 * No agent process is involved; `/api/` is mocked in the browser.
 */

import { test, expect, type Page } from '@playwright/test';
import { boxContains, boxesInSplit, type Box } from './fixtures/agent-mode-helpers';
import {
  COMPOSER_SPLITS,
  E2E_COMPOSER_OTHER_WORKTREE,
  E2E_COMPOSER_WORKTREE,
  OPENCODE_SPLIT,
  composerHeightKey,
  mockComposerApi,
  openComposerWorktree,
  seedComposerSplits,
} from './fixtures/composer-height-helpers';
import {
  COMPOSER_MIN_HEIGHT_PX,
  COMPOSER_PANE_BODY_MIN_HEIGHT_PX,
  composerHeightScopeForSplit,
} from '../../src/config/composer-height';
import { COMPOSER_HINTS_MIN_CONTAINER_PX } from '../../src/config/composer-layout';

const DESKTOP_VIEWPORT = { width: 1440, height: 900 } as const;

/** The Issue's acceptance bound on what the second row may cost the body. */
const MAX_BODY_LOSS_PX = 48;

/** The Issue's acceptance floor for the textarea in the ~220px pane. */
const MIN_NARROW_TEXTAREA_PX = 120;

/** One line of meta row (the Auto-Yes switch is its tallest item). */
const ONE_LINE_META_ROW_PX = 24;

/**
 * Sub-pixel slack on "the body keeps its floor". The bound is floored to whole
 * pixels, so the body can only come out at or above the floor; the slack is
 * for Chromium's 1/64px layout units.
 */
const FLOOR_SLACK_PX = 0.5;

/** Before #2598, with this fixture — see the module table. */
const PRE_2598 = {
  oneSplit: { widths: [1], bodies: [667.5] },
  threeSplits: { widths: [218, 455, 272], bodies: [647.5, 613.5, 647.5] },
} as const;

const SPLIT_0 = composerHeightScopeForSplit(0);

test.use({ viewport: { ...DESKTOP_VIEWPORT } });

test.beforeEach(({ browserName }) => {
  // PC-only split UI (the same self-skip the other split specs use).
  test.skip(browserName !== 'chromium', 'PC-only split UI (chromium only)');
});

async function open(
  page: Page,
  widths: readonly number[],
  options: { id?: string; autoYesEnabled?: boolean } = {},
): Promise<void> {
  await seedComposerSplits(page, widths);
  await mockComposerApi(page, { autoYesEnabled: options.autoYesEnabled });
  await openComposerWorktree(page, widths.length, options.id);
}

/** The Auto-Yes half of one pane's meta row: how wide its content is, and how wide it is drawn. */
function autoYesFit(page: Page, splitIndex: number): Promise<{ content: number; drawn: number }> {
  return page.evaluate(idx => {
    const pane = document.querySelector(`[data-testid="terminal-split-pane-${idx}"]`);
    const el = pane?.querySelector('[data-testid="composer-auto-yes"]') as HTMLElement | null;
    return { content: el?.scrollWidth ?? -1, drawn: el?.clientWidth ?? -1 };
  }, splitIndex);
}

function heightOf(page: Page, splitIndex: number, testId: string): Promise<number> {
  return page.evaluate(
    ({ idx, id }) => {
      const pane = document.querySelector(`[data-testid="terminal-split-pane-${idx}"]`);
      const el = pane?.querySelector(`[data-testid="${id}"]`);
      return el ? el.getBoundingClientRect().height : -1;
    },
    { idx: splitIndex, id: testId },
  );
}

const bodyHeight = (page: Page, i: number) => heightOf(page, i, `split-body-${i}`);
const textareaHeight = (page: Page, i: number) => heightOf(page, i, 'message-input-textarea');

/**
 * The painted box of the Auto-Yes switch in one pane: its rect clipped by every
 * ancestor that clips (the meta row's Auto-Yes half is `overflow-x-auto`), or
 * null when nothing of it is painted.
 */
function paintedAutoYesSwitch(page: Page, splitIndex: number): Promise<Box | null> {
  return page.evaluate(idx => {
    const pane = document.querySelector(`[data-testid="terminal-split-pane-${idx}"]`);
    const el = pane?.querySelector('[data-testid="composer-meta-row"] [role="switch"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    let clip = { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    for (let a = el.parentElement; a && a !== pane; a = a.parentElement) {
      if (getComputedStyle(a).overflowX === 'visible') continue;
      const c = a.getBoundingClientRect();
      clip = {
        left: Math.max(clip.left, c.left),
        right: Math.min(clip.right, c.right),
        top: Math.max(clip.top, c.top),
        bottom: Math.min(clip.bottom, c.bottom),
      };
    }
    if (clip.right <= clip.left || clip.bottom <= clip.top) return null;
    return { ...clip, width: clip.right - clip.left, height: clip.bottom - clip.top };
  }, splitIndex);
}

/** Drag split `splitIndex`'s handle vertically by `dy` (negative = up). */
async function dragHandle(page: Page, splitIndex: number, dy: number): Promise<void> {
  const handle = page
    .getByTestId(`terminal-split-pane-${splitIndex}`)
    .getByRole('separator', { name: /message box|入力欄/ });
  const box = await handle.boundingBox();
  expect(box, 'handle box').not.toBeNull();
  const x = box!.x + box!.width / 2;
  const y = box!.y + box!.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + dy, { steps: 8 });
  await page.mouse.up();
}

function handleIn(page: Page, splitIndex: number) {
  return page
    .getByTestId(`terminal-split-pane-${splitIndex}`)
    .getByRole('separator', { name: /message box|入力欄/ });
}

test.describe('[#2598] two rows on a PC', () => {
  for (const [name, layout] of Object.entries(PRE_2598)) {
    test(`toolbar over the textarea, within the height budget: ${name}`, async ({ page }) => {
      await open(page, layout.widths);

      for (const [index, before] of layout.bodies.entries()) {
        const label = `${name} / pane ${index}`;
        const b = await boxesInSplit(page, index, [
          'composer-input-row',
          'composer-toolbar',
          'composer-textarea-row',
          'message-input-textarea',
          'send-message-button',
          'attach-image-button',
          'agent-mode-cycle-button',
          'interrupt-button',
          'composer-meta-row',
          'composer-hints',
        ]);
        const pane = (await boxesInSplit(page, index, [`split-body-${index}`]))[`split-body-${index}`]!.box;
        const body = await bodyHeight(page, index);
        const row = b['composer-input-row']!.box;
        const toolbar = b['composer-toolbar']!.box;
        const textarea = b['message-input-textarea']!.box;
        const meta = b['composer-meta-row']!.box;
        const hintsShown = (b['composer-hints']?.box.width ?? 0) > 0;

        // eslint-disable-next-line no-console -- the measurement is the deliverable
        console.log(`MEASURE-2598 ${label} ` + JSON.stringify({
          pane: pane.width,
          row: row.width,
          textarea: textarea.width,
          toolbar: toolbar.height,
          meta: meta.height,
          hints: b['composer-hints']?.box.width ?? null,
          body,
          bodyBefore: before,
          footer: await heightOf(page, index, `split-footer-${index}`),
        }));

        // The toolbar is a row of its own, entirely above the textarea, and
        // holds the attach, mode and interrupt buttons.
        expect(toolbar.bottom, `${label}: toolbar above textarea`).toBeLessThanOrEqual(textarea.top + 0.5);
        for (const id of ['attach-image-button', 'agent-mode-cycle-button', 'interrupt-button'] as const) {
          expect(boxContains(toolbar, b[id]!.box), `${label}: ${id} in toolbar`).toBe(true);
        }
        // The textarea's row holds the send button, inside the composer.
        expect(boxContains(b['composer-textarea-row']!.box, b['send-message-button']!.box)).toBe(true);
        expect(boxContains(row, b['send-message-button']!.box), `${label}: send inside row`).toBe(true);

        // The second row cost the body no more than the Issue allows.
        expect(before - body, `${label}: body loss`).toBeLessThanOrEqual(MAX_BODY_LOSS_PX);

        // The meta row is one line, and the hints are drawn exactly where the
        // row is at least the threshold wide.
        expect(meta.height, `${label}: meta row one line`).toBeLessThanOrEqual(ONE_LINE_META_ROW_PX);
        expect(hintsShown, `${label}: hints shown`).toBe(row.width >= COMPOSER_HINTS_MIN_CONTAINER_PX);

        // The Auto-Yes switch is painted, inside the meta row.
        const autoYes = await paintedAutoYesSwitch(page, index);
        expect(autoYes, `${label}: Auto-Yes painted`).not.toBeNull();
        expect(autoYes!.width, `${label}: Auto-Yes fully painted`).toBeGreaterThanOrEqual(30);
        expect(boxContains(meta, autoYes!), `${label}: Auto-Yes inside meta row`).toBe(true);
      }
    });
  }

  test('prints the hints where the row has room for them and the Auto-Yes toggle, with Auto-Yes on', async ({ page }) => {
    // Auto-Yes on is the toggle at its widest (tool name and countdown). Two
    // equal splits are the narrowest pane on this screen that keeps the hints.
    for (const widths of [[1, 1], PRE_2598.threeSplits.widths, [1, 1, 1, 1]] as const) {
      const fresh = await page.context().newPage();
      await open(fresh, widths, { autoYesEnabled: true });
      await expect(fresh.getByText(/\d:\d\d:\d\d/).first()).toBeVisible();
      for (let index = 0; index < widths.length; index += 1) {
        const tool = COMPOSER_SPLITS[index].cliTool;
        const label = `${widths.length} splits / pane ${index} (${tool})`;
        const b = await boxesInSplit(fresh, index, ['composer-meta-row', 'composer-hints']);
        const meta = b['composer-meta-row']!.box;
        const hintsShown = (b['composer-hints']?.box.width ?? 0) > 0;
        const fit = await autoYesFit(fresh, index);
        // eslint-disable-next-line no-console -- the measurement is the deliverable
        console.log(`MEASURE-2598 auto-yes-on ${label} ` + JSON.stringify({ row: meta.width, hintsShown, ...fit }));

        expect(meta.height, `${label}: meta row one line`).toBeLessThanOrEqual(ONE_LINE_META_ROW_PX);
        expect(hintsShown, `${label}: hints`).toBe(meta.width >= COMPOSER_HINTS_MIN_CONTAINER_PX);
        if (widths.length === 2) expect(hintsShown, `${label}: two splits keep the hints`).toBe(true);
        // The switch is always drawn whole.
        const autoYes = await paintedAutoYesSwitch(fresh, index);
        expect(autoYes?.width ?? 0, `${label}: Auto-Yes switch`).toBeGreaterThanOrEqual(30);
        // Where the hints are drawn they leave the toggle its full width — for
        // every tool but antigravity, whose name is the longest and whose
        // countdown may scroll by a few pixels (COMPOSER_HINTS_MIN_CONTAINER_PX).
        if (hintsShown && tool !== 'antigravity') {
          expect(fit.content, `${label}: Auto-Yes not clipped`).toBeLessThanOrEqual(fit.drawn + 1);
        }
      }
      await fresh.close();
    }
  });

  test('keeps the interrupt button on screen when opencode fills a ~220px toolbar', async ({ page }) => {
    await seedComposerSplits(page, PRE_2598.threeSplits.widths, [
      OPENCODE_SPLIT.cliTool,
      COMPOSER_SPLITS[1].cliTool,
      COMPOSER_SPLITS[2].cliTool,
    ]);
    await mockComposerApi(page);
    // opencode draws no mode chip: two panes have one.
    await openComposerWorktree(page, 2);
    const pane = page.getByTestId('terminal-split-pane-0');
    await expect(pane.getByTestId('opencode-session-controls')).toBeVisible();

    const b = await boxesInSplit(page, 0, [
      'composer-toolbar',
      'composer-toolbar-start',
      'interrupt-button',
      'message-input-textarea',
    ]);
    const paneBox = (await pane.boundingBox())!;
    const interrupt = b['interrupt-button']!;
    // eslint-disable-next-line no-console -- the measurement is the deliverable
    console.log('MEASURE-2598 opencode-218 ' + JSON.stringify({
      pane: paneBox.width,
      toolbar: b['composer-toolbar']!.box.width,
      startScroll: await page.evaluate(() => {
        const el = document.querySelector(
          '[data-testid="terminal-split-pane-0"] [data-testid="composer-toolbar-start"]',
        ) as HTMLElement;
        return { content: el.scrollWidth, drawn: el.clientWidth };
      }),
      textarea: b['message-input-textarea']!.box.width,
    }));
    expect(paneBox.width).toBeLessThanOrEqual(230);
    // Wholly painted, inside the toolbar and the pane.
    expect(interrupt.visible, 'interrupt painted').not.toBeNull();
    expect(interrupt.visible!.width).toBeCloseTo(interrupt.box.width, 0);
    expect(boxContains(b['composer-toolbar']!.box, interrupt.box)).toBe(true);
    expect(interrupt.box.right).toBeLessThanOrEqual(paneBox.x + paneBox.width);
    expect(b['message-input-textarea']!.box.width).toBeGreaterThanOrEqual(MIN_NARROW_TEXTAREA_PX);
  });

  test('gives the ~220px pane a usable textarea', async ({ page }) => {
    await open(page, PRE_2598.threeSplits.widths);
    const b = await boxesInSplit(page, 0, ['message-input-textarea']);
    const pane = await page.getByTestId('terminal-split-pane-0').boundingBox();
    expect(pane!.width).toBeGreaterThanOrEqual(200);
    expect(pane!.width).toBeLessThanOrEqual(230);
    expect(b['message-input-textarea']!.box.width).toBeGreaterThanOrEqual(MIN_NARROW_TEXTAREA_PX);

    // …and it takes typing (a 0px textarea did not).
    const textarea = page.getByTestId('terminal-split-pane-0').getByTestId('message-input-textarea');
    await textarea.click();
    await textarea.pressSequentially('typed');
    await expect(textarea).toHaveValue('typed');
  });
});

test.describe('[#2598] the height handle', () => {
  test('pulling up grows the textarea by what the body gives up; arrow keys too', async ({ page }) => {
    await open(page, PRE_2598.oneSplit.widths);
    await expect(handleIn(page, 0)).toBeVisible();

    const t0 = await textareaHeight(page, 0);
    const b0 = await bodyHeight(page, 0);
    expect(t0).toBe(COMPOSER_MIN_HEIGHT_PX);

    await dragHandle(page, 0, -120);
    await expect.poll(() => textareaHeight(page, 0)).toBeGreaterThan(t0 + 100);
    const t1 = await textareaHeight(page, 0);
    const b1 = await bodyHeight(page, 0);
    // eslint-disable-next-line no-console -- the measurement is the deliverable
    console.log('MEASURE-2598 drag ' + JSON.stringify({ t0, b0, t1, b1 }));
    expect(Math.abs((t1 - t0) - (b0 - b1)), 'textarea gain = body loss').toBeLessThanOrEqual(1);
    expect(await page.evaluate(k => localStorage.getItem(k), composerHeightKey(E2E_COMPOSER_WORKTREE, SPLIT_0)))
      .toBe(String(Math.round(t1)));

    const handle = handleIn(page, 0);
    await handle.focus();
    await page.keyboard.press('ArrowUp');
    await expect.poll(() => textareaHeight(page, 0)).toBe(t1 + 10);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect.poll(() => textareaHeight(page, 0)).toBe(t1 - 10);
    expect(await bodyHeight(page, 0)).toBeCloseTo(b1 + 10, 0);

    // Pulling down (the other way) shrinks it back to the floor.
    await dragHandle(page, 0, 400);
    await expect.poll(() => textareaHeight(page, 0)).toBe(COMPOSER_MIN_HEIGHT_PX);
  });

  test('keeps the height across a reload, for this split and this worktree only', async ({ page }) => {
    await open(page, [1, 1]);
    await dragHandle(page, 0, -100);
    await expect.poll(() => textareaHeight(page, 0)).toBeGreaterThan(100);
    const stored = await textareaHeight(page, 0);

    await page.reload();
    await openComposerWorktree(page, 2);
    await expect.poll(() => textareaHeight(page, 0)).toBe(stored);
    // The other split is untouched.
    expect(await textareaHeight(page, 1)).toBe(COMPOSER_MIN_HEIGHT_PX);
    expect(await page.evaluate(k => localStorage.getItem(k), composerHeightKey(E2E_COMPOSER_WORKTREE, 'split:1')))
      .toBeNull();

    // Another worktree with the same layout is untouched.
    await openComposerWorktree(page, 2, E2E_COMPOSER_OTHER_WORKTREE);
    expect(await textareaHeight(page, 0)).toBe(COMPOSER_MIN_HEIGHT_PX);
    expect(
      await page.evaluate(k => localStorage.getItem(k), composerHeightKey(E2E_COMPOSER_OTHER_WORKTREE, SPLIT_0)),
    ).toBeNull();
  });

  test('stops where the body reaches its floor', async ({ page }) => {
    await open(page, PRE_2598.oneSplit.widths);
    await dragHandle(page, 0, -2000);
    await expect.poll(() => bodyHeight(page, 0)).toBeLessThan(COMPOSER_PANE_BODY_MIN_HEIGHT_PX + 1);
    const body = await bodyHeight(page, 0);
    const textarea = await textareaHeight(page, 0);
    // eslint-disable-next-line no-console -- the measurement is the deliverable
    console.log('MEASURE-2598 ceiling ' + JSON.stringify({ body, textarea }));
    expect(body).toBeGreaterThanOrEqual(COMPOSER_PANE_BODY_MIN_HEIGHT_PX - FLOOR_SLACK_PX);
    // The send button is still on screen, inside the pane.
    const pane = (await page.getByTestId('terminal-split-pane-0').boundingBox())!;
    const send = (await page.getByTestId('terminal-split-pane-0').getByTestId('send-message-button').boundingBox())!;
    expect(send.y + send.height).toBeLessThanOrEqual(pane.y + pane.height);
  });

  test('is drawn smaller in the 2x2 grid and comes back when the grid is left', async ({ page }) => {
    await open(page, PRE_2598.oneSplit.widths);
    await dragHandle(page, 0, -300);
    await expect.poll(() => textareaHeight(page, 0)).toBeGreaterThan(300);
    const stored = await textareaHeight(page, 0);
    const key = composerHeightKey(E2E_COMPOSER_WORKTREE, SPLIT_0);

    const add = page.getByTestId('add-terminal-split');
    for (let n = 2; n <= 4; n += 1) {
      await add.click();
      await expect(page.locator('[data-testid^="terminal-split-pane-"]')).toHaveCount(n);
    }
    // The grid halves the pane: the textarea is bounded, the body keeps its
    // floor (or, if the pane cannot even give that, the textarea is one line).
    await expect.poll(() => textareaHeight(page, 0)).toBeLessThan(stored);
    const gridTextarea = await textareaHeight(page, 0);
    const gridBody = await bodyHeight(page, 0);
    // eslint-disable-next-line no-console -- the measurement is the deliverable
    console.log('MEASURE-2598 grid ' + JSON.stringify({ stored, gridTextarea, gridBody }));
    if (gridTextarea > COMPOSER_MIN_HEIGHT_PX) {
      expect(gridBody).toBeGreaterThanOrEqual(COMPOSER_PANE_BODY_MIN_HEIGHT_PX - FLOOR_SLACK_PX);
    }
    // Only the drawing was bounded.
    expect(await page.evaluate(k => localStorage.getItem(k), key)).toBe(String(stored));

    const remove = page.getByTestId('remove-terminal-split');
    for (let n = 3; n >= 1; n -= 1) {
      await remove.click();
      await expect(page.locator('[data-testid^="terminal-split-pane-"]')).toHaveCount(n);
    }
    await expect.poll(() => textareaHeight(page, 0)).toBe(stored);
  });

  test('is drawn smaller in a shorter window and comes back', async ({ page }) => {
    await open(page, PRE_2598.oneSplit.widths);
    await dragHandle(page, 0, -400);
    await expect.poll(() => textareaHeight(page, 0)).toBeGreaterThan(400);
    const stored = await textareaHeight(page, 0);

    await page.setViewportSize({ width: DESKTOP_VIEWPORT.width, height: 600 });
    await expect.poll(() => textareaHeight(page, 0)).toBeLessThan(stored);
    expect(await bodyHeight(page, 0)).toBeGreaterThanOrEqual(COMPOSER_PANE_BODY_MIN_HEIGHT_PX - FLOOR_SLACK_PX);

    await page.setViewportSize({ ...DESKTOP_VIEWPORT });
    await expect.poll(() => textareaHeight(page, 0)).toBe(stored);
  });

  test('a double-click returns to auto-grow and forgets the height', async ({ page }) => {
    await open(page, PRE_2598.oneSplit.widths);
    const key = composerHeightKey(E2E_COMPOSER_WORKTREE, SPLIT_0);
    await dragHandle(page, 0, -150);
    await expect.poll(() => page.evaluate(k => localStorage.getItem(k), key)).not.toBeNull();

    await handleIn(page, 0).dblclick();
    await expect.poll(() => textareaHeight(page, 0)).toBe(COMPOSER_MIN_HEIGHT_PX);
    expect(await page.evaluate(k => localStorage.getItem(k), key)).toBeNull();

    // Auto-grow is back: a few lines grow the textarea, and it stops at 160.
    const textarea = page.getByTestId('terminal-split-pane-0').getByTestId('message-input-textarea');
    await textarea.fill('1\n2\n3');
    await expect.poll(() => textareaHeight(page, 0)).toBeGreaterThan(COMPOSER_MIN_HEIGHT_PX);
    await textarea.fill(Array.from({ length: 30 }, (_, i) => String(i)).join('\n'));
    await expect.poll(() => textareaHeight(page, 0)).toBe(160);
  });

  test('keeps the fixed height after a send, and keeps the caret while dragging', async ({ page }) => {
    await open(page, PRE_2598.oneSplit.widths);
    const textarea = page.getByTestId('terminal-split-pane-0').getByTestId('message-input-textarea');
    await textarea.click();
    await textarea.pressSequentially('draft');
    await dragHandle(page, 0, -80);
    await expect.poll(() => textareaHeight(page, 0)).toBeGreaterThan(100);
    const fixed = await textareaHeight(page, 0);
    // The drag took no focus and selected nothing; the draft is intact.
    await expect(textarea).toBeFocused();
    await expect(textarea).toHaveValue('draft');
    expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('');

    await page.keyboard.press('Enter');
    await expect(textarea).toHaveValue('');
    expect(await textareaHeight(page, 0)).toBe(fixed);
  });
});
