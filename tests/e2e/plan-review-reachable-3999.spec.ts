/**
 * E2E: Command Code's plan review is answerable from every surface (Issue #3999).
 *
 * On 2026-10-30 a Command Code session sat in its REVIEW screen for five hours
 * because nobody could press Approve: on a 412x892 phone the chat card's
 * controls were laid out below the bottom of the `overflow-hidden` chat
 * surface, the terminal surfaces (PC footer, the phone's docked pad,
 * `/sessions` tiles) drew no plan-review controls at all, and the composer
 * sent into a screen that refuses messages.
 *
 * The claims, each on every surface and width the Issue names:
 *
 *  1. Approve / Cancel / Submit review and the comment box are WHOLE on
 *     screen before anything is touched — `toBeInViewport({ ratio: 1 })`, which
 *     IntersectionObserver computes after clipping by every `overflow` ancestor,
 *     plus a hit test at the control's centre (nothing drawn over it).
 *  2. The controls stay whole with the approve confirmation open, with a long
 *     refusal shown, and with the comment box dragged tall.
 *  3. Approve asks first — `No` posts nothing, `Yes` posts
 *     `planReviewAction: 'approve'` — and Cancel / comment / Submit post their
 *     own actions to `/prompt-response`.
 *  4. The composer does not send into the review: Enter and the send button
 *     keep the draft, create no `/send`, and point at the controls. A send to
 *     another instance, and a send after the review ended, go through.
 *
 * No Command Code, tmux or server state: `/api/` is mocked in the browser and
 * the REVIEW screen is a committed live capture (see the fixture module).
 */

import { test, expect, type Locator, type Page } from '@playwright/test';
import {
  E2E_PLAN_REVIEW_WORKTREE,
  PLAN_REVIEW_TOOL,
  isHitTarget,
  mockPlanReviewApi,
  seedPlanReviewLayout,
  type PlanReviewMock,
  type Surface,
} from './fixtures/plan-review-3999-helpers';

const ID = E2E_PLAN_REVIEW_WORKTREE;

const PHONES = [
  { width: 412, height: 892, label: '412x892' },
  { width: 360, height: 640, label: '360x640' },
] as const;

const PC = { width: 1440, height: 900 } as const;
/** A PC window split three ways: each pane ~420px wide. */
const NARROW_PC = { width: 1280, height: 800 } as const;

/** The four controls the Issue requires on screen before anything is pressed. */
const PRIMARY_CONTROLS = [
  'plan-review-comment-input',
  'plan-review-submit',
  'plan-review-approve',
  'plan-review-cancel',
] as const;

/** The ones that must survive every stressed state (the comment box may scroll). */
const ACTION_BUTTONS = ['plan-review-submit', 'plan-review-approve', 'plan-review-cancel'] as const;

/** Long enough to wrap to many lines at a phone's width. */
const LONG_REFUSAL = Array.from(
  { length: 12 },
  (_, i) => `Line ${i + 1}: the plan review's focus is not on the plan; nothing was sent to the pane.`,
).join(' ');

async function expectWhole(page: Page, root: string, group: Locator, ids: readonly string[]): Promise<void> {
  for (const id of ids) {
    await expect(group.getByTestId(id), `${id} is wholly on screen`).toBeInViewport({ ratio: 1 });
    expect(await isHitTarget(page, id, root), `${id} is the topmost element at its centre`).toBe(true);
  }
}

async function lastAction(mock: PlanReviewMock): Promise<unknown> {
  return mock.promptResponses.at(-1)?.planReviewAction;
}

/**
 * Claims 1–3 on the one group of controls under `root`.
 */
async function exerciseControls(page: Page, root: string, mock: PlanReviewMock): Promise<void> {
  const group = page.locator(root).getByTestId('plan-review-controls');
  await expect(group).toHaveCount(1, { timeout: 30_000 });

  // 1. Before anything is pressed.
  await expectWhole(page, root, group, PRIMARY_CONTROLS);

  // 3a. Approve asks first; No posts nothing.
  await group.getByTestId('plan-review-approve').click();
  const confirm = group.getByTestId('plan-review-approve-confirm');
  await expect(confirm).toBeVisible();
  // 2a. With the confirmation open.
  await expectWhole(page, root, group, [
    'plan-review-approve-confirm-yes',
    'plan-review-approve-confirm-no',
    'plan-review-submit',
    'plan-review-cancel',
  ]);
  await group.getByTestId('plan-review-approve-confirm-no').click();
  await expect(confirm).toHaveCount(0);
  expect(mock.promptResponses).toHaveLength(0);

  // 3b. Yes posts the approve.
  await group.getByTestId('plan-review-approve').click();
  await group.getByTestId('plan-review-approve-confirm-yes').click();
  await expect.poll(() => lastAction(mock)).toBe('approve');
  expect(mock.promptResponses).toHaveLength(1);
  expect(mock.promptResponses[0]).toMatchObject({ planReviewAction: 'approve', cliTool: PLAN_REVIEW_TOOL });
  expect(mock.promptResponses[0]).not.toHaveProperty('answer');

  // 3c. Cancel posts at once.
  await group.getByTestId('plan-review-cancel').click();
  await expect.poll(() => lastAction(mock)).toBe('cancel');

  // 3d. A comment, then the review.
  await group.getByTestId('plan-review-comment-input').fill('Add a test for lo > hi');
  await group.getByTestId('plan-review-comment').click();
  await expect.poll(() => lastAction(mock)).toBe('comment');
  expect(mock.promptResponses.at(-1)).toMatchObject({ answer: 'Add a test for lo > hi' });
  await group.getByTestId('plan-review-submit').click();
  await expect.poll(() => lastAction(mock)).toBe('submit');
  expect(mock.promptResponses).toHaveLength(4);

  // 2b. A long refusal.
  mock.setRefusal(LONG_REFUSAL);
  await group.getByTestId('plan-review-cancel').click();
  await expect(group.getByTestId('plan-review-error')).toBeVisible();
  await expectWhole(page, root, group, ACTION_BUTTONS);
  mock.setRefusal(null);

  // 2c. The comment box dragged tall (what `resize-y` lets anyone do).
  await group.getByTestId('plan-review-comment-input').evaluate(el => {
    (el as HTMLElement).style.height = '480px';
  });
  await expectWhole(page, root, group, ACTION_BUTTONS);
}

async function openPhone(page: Page, pane: 'terminal' | 'history'): Promise<void> {
  // `?instance=` rather than the stored active instance, so the test does not
  // depend on what an earlier run left in storage. The query is applied once
  // the roster is there (useWorktreeDetailController). Before Issue #4013 the
  // phone also corrected a stored id against the default seed and lost it.
  await page.goto(`/worktrees/${ID}?pane=terminal&instance=${PLAN_REVIEW_TOOL}`);
  await page.getByTestId('mobile-composer-wrapper').waitFor({ state: 'visible', timeout: 30_000 });
  // The tab is chosen by tapping it: the query is consumed with the instance.
  if (pane !== 'terminal') await page.getByTestId(`mobile-tab-${pane}`).click();
}

async function openPc(page: Page): Promise<void> {
  await page.goto(`/worktrees/${ID}`);
  await page.getByTestId('terminal-split-container').waitFor({ state: 'visible', timeout: 30_000 });
}

async function openTiles(page: Page): Promise<void> {
  await page.goto('/sessions');
  await page.getByTestId(`session-tile-composer-${ID}`).waitFor({ state: 'visible', timeout: 30_000 });
}

test.describe('[#3999] plan review controls are reachable', () => {
  test.beforeEach(({ browserName }) => {
    test.skip(browserName !== 'chromium', 'layout is measured in chromium');
  });

  for (const vp of PHONES) {
    test(`phone chat card at ${vp.label}`, async ({ page }) => {
      await page.setViewportSize(vp);
      await seedPlanReviewLayout(page, { surface: 'chat' });
      const mock = await mockPlanReviewApi(page);
      await openPhone(page, 'terminal');
      await exerciseControls(page, '[data-testid="chat-surface"]', mock);
    });

    test(`phone docked pad (terminal tab) at ${vp.label}`, async ({ page }) => {
      await page.setViewportSize(vp);
      await seedPlanReviewLayout(page, { surface: 'terminal' });
      const mock = await mockPlanReviewApi(page);
      await openPhone(page, 'terminal');
      await exerciseControls(page, '[data-testid="mobile-selection-dock"]', mock);
    });

    test(`phone docked pad (History tab) at ${vp.label}`, async ({ page }) => {
      await page.setViewportSize(vp);
      await seedPlanReviewLayout(page, { surface: 'chat' });
      const mock = await mockPlanReviewApi(page);
      await openPhone(page, 'history');
      await exerciseControls(page, '[data-testid="mobile-selection-dock"]', mock);
    });
  }

  const PC_LAYOUTS = [
    { label: 'PC 1440x900, one pane', viewport: PC, splits: 1 },
    { label: 'narrow PC 1280x800, three panes', viewport: NARROW_PC, splits: 3 },
    { label: 'PC 1440x900, 2x2 grid', viewport: PC, splits: 4 },
  ] as const;
  const SURFACES: readonly Surface[] = ['chat', 'terminal'];

  for (const layout of PC_LAYOUTS) {
    for (const surface of SURFACES) {
      test(`${layout.label}, ${surface} surface`, async ({ page }) => {
        await page.setViewportSize(layout.viewport);
        await seedPlanReviewLayout(page, { splits: layout.splits, surface });
        const mock = await mockPlanReviewApi(page);
        await openPc(page);
        await expect(page.locator('[data-testid^="terminal-split-pane-"]')).toHaveCount(layout.splits);
        await exerciseControls(page, '[data-testid="terminal-split-pane-0"]', mock);
      });
    }
  }

  for (const surface of SURFACES) {
    test(`/sessions tile, ${surface} surface`, async ({ page }) => {
      await page.setViewportSize(PC);
      await seedPlanReviewLayout(page, { surface });
      const mock = await mockPlanReviewApi(page, { listResponse: true });
      await openTiles(page);
      await exerciseControls(page, `[data-testid="session-tile-${ID}"]`, mock);
    });
  }
});

test.describe('[#3999] the composer does not send into a plan review', () => {
  test.beforeEach(({ browserName }) => {
    test.skip(browserName !== 'chromium', 'layout is measured in chromium');
  });

  async function expectBlocked(page: Page, composer: Locator, mock: PlanReviewMock, text: string): Promise<void> {
    await expect(composer.getByTestId('composer-plan-review-notice')).toBeVisible();
    expect(mock.sends).toHaveLength(0);
    await expect(composer.getByTestId('message-input-textarea')).toHaveValue(text);
  }

  test('PC: Enter and the send button are stopped; another pane and a finished review are not', async ({ page }) => {
    await page.setViewportSize(PC);
    await seedPlanReviewLayout(page, { splits: 2, surface: 'terminal' });
    const mock = await mockPlanReviewApi(page);
    await openPc(page);
    const pane0 = page.getByTestId('terminal-split-pane-0');
    const pane1 = page.getByTestId('terminal-split-pane-1');
    const composer0 = pane0.getByTestId('message-input-container');
    await expect(composer0.getByTestId('composer-plan-review-notice')).toBeVisible({ timeout: 30_000 });

    const textarea0 = composer0.getByTestId('message-input-textarea');
    await textarea0.fill('please also handle NaN');
    await textarea0.press('Enter');
    await expectBlocked(page, composer0, mock, 'please also handle NaN');
    await composer0.getByTestId('send-message-button').click();
    await expectBlocked(page, composer0, mock, 'please also handle NaN');

    // The way to the controls.
    await composer0.getByTestId('composer-plan-review-goto').click();
    await expect(pane0.getByTestId('plan-review-approve')).toBeInViewport({ ratio: 1 });

    // Another instance is not stopped.
    const composer1 = pane1.getByTestId('message-input-container');
    await expect(composer1.getByTestId('composer-plan-review-notice')).toHaveCount(0);
    await composer1.getByTestId('message-input-textarea').fill('hello claude');
    await composer1.getByTestId('message-input-textarea').press('Enter');
    await expect.poll(() => mock.sends.length).toBe(1);
    expect(mock.sends[0]).toMatchObject({ cliToolId: 'claude', content: 'hello claude' });

    // The review ends: the draft is still there and now goes out.
    mock.setPlanReview(false);
    await expect(composer0.getByTestId('composer-plan-review-notice')).toHaveCount(0, { timeout: 15_000 });
    await expect(textarea0).toHaveValue('please also handle NaN');
    await textarea0.press('Enter');
    await expect.poll(() => mock.sends.length).toBe(2);
    expect(mock.sends[1]).toMatchObject({ cliToolId: PLAN_REVIEW_TOOL, content: 'please also handle NaN' });
  });

  test('phone: the send button is stopped and points at the controls', async ({ page }) => {
    await page.setViewportSize(PHONES[0]);
    await seedPlanReviewLayout(page, { surface: 'chat' });
    const mock = await mockPlanReviewApi(page);
    await openPhone(page, 'terminal');
    const composer = page.getByTestId('mobile-composer-wrapper');
    await expect(composer.getByTestId('composer-plan-review-notice')).toBeVisible({ timeout: 30_000 });
    await composer.getByTestId('message-input-textarea').fill('looks good but add tests');
    await composer.getByTestId('send-message-button').click();
    await expectBlocked(page, composer, mock, 'looks good but add tests');
    await composer.getByTestId('composer-plan-review-goto').click();
    await expect(page.getByTestId('plan-review-approve')).toBeInViewport({ ratio: 1 });
  });

  test('/sessions tile: the send button is stopped', async ({ page }) => {
    await page.setViewportSize(PC);
    await seedPlanReviewLayout(page, { surface: 'terminal' });
    const mock = await mockPlanReviewApi(page, { listResponse: true });
    await openTiles(page);
    const composer = page.getByTestId(`session-tile-composer-${ID}`);
    await expect(composer.getByTestId('composer-plan-review-notice')).toBeVisible({ timeout: 30_000 });
    await composer.getByTestId('message-input-textarea').fill('tile draft');
    await composer.getByTestId('send-message-button').click();
    await expectBlocked(page, composer, mock, 'tile draft');
  });
});
