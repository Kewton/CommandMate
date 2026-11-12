/**
 * E2E: the PWA update prompt no longer covers what is under it (Issue #4103),
 * and a roster row's held count is readable at PC width.
 *
 * These are all claims about pixels and hit-testing, which jsdom does not do.
 *
 * Getting the prompt on screen. `ServiceWorkerRegistrar` registers nothing
 * outside production (`shouldRegisterServiceWorker`), and this suite runs against
 * `npm run dev`, so mocking `navigator.serviceWorker` alone leaves the component
 * sitting behind that guard. Two things together put the REAL component through
 * its REAL update path, with no test seam in the product:
 *
 *   1. `addInitScript` replaces `navigator.serviceWorker` with one whose
 *      registration has a worker waiting while a controller is present.
 *   2. `page.route` rewrites the guard in the dev bundle as it is served.
 *      {@link armUpdatePrompt} fails the test if the bundle no longer contains
 *      the guard, rather than letting a renamed function read as "no prompt".
 *
 * No agent process is involved; `/api/` is mocked in the browser.
 */

import { test, expect, type Locator, type Page, type Route } from '@playwright/test';
import { EXIT_ANIMATION_DURATION_MS } from '@/config/ui-feedback-config';
import { Z_INDEX } from '@/config/z-index';
import { getTerminalSplitsStorageKey } from '@/config/terminal-split-config';
import { mockStartPreview } from './fixtures/start-preview-helpers';

const WORKTREE_ID = 'e2e-pwa-update-toast-4103';
const PC_VIEWPORT = { width: 1280, height: 800 } as const;
const PHONE_VIEWPORT = { width: 390, height: 844 } as const;
/** Mirror of LAST_SEEN_APP_VERSION_STORAGE_KEY: older than any release, so the dialog opens. */
const LAST_SEEN_KEY = 'commandmate.lastSeenAppVersion';

/** The guard's body as served by the dev bundle, quoted or escaped either way. */
const REGISTER_GUARD = /nodeEnv\s*===\s*(\\*["'])production\1/g;

function fulfillJson(route: Route, body: unknown): Promise<void> {
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
}

const WORKTREE = {
  id: WORKTREE_ID,
  name: `E2E ${WORKTREE_ID}`,
  path: `/tmp/${WORKTREE_ID}`,
  repositoryPath: `/tmp/${WORKTREE_ID}-repo`,
  repositoryName: 'e2e-repo',
  repositoryDisplayName: 'E2E Repo',
  description: 'E2E update prompt worktree',
  selectedAgents: ['claude', 'codex'],
  agentInstances: [
    { id: 'claude', cliTool: 'claude', alias: 'claude', order: 0 },
    { id: 'codex', cliTool: 'codex', alias: 'codex', order: 1 },
  ],
  cliToolId: 'claude',
  status: 'ready',
  sessionStatusByCli: {
    claude: { isRunning: true, isWaitingForResponse: false, isProcessing: false },
    codex: { isRunning: true, isWaitingForResponse: false, isProcessing: false },
  },
  gitStatus: {
    currentBranch: 'main',
    initialBranch: 'main',
    isBranchMismatch: false,
    commitHash: 'e2e0000',
    isDirty: false,
  },
};

const RELEASE_NOTES = {
  notes: [
    {
      version: '99.0.0',
      // Long enough that the dialog fills the screen, which is what puts its Close
      // button in the corner the prompt occupies (the test asserts the overlap).
      date: '2026-11-02',
      added: Array.from({ length: 30 }, (_, i) => ({ en: `Added item ${i}`, ja: `追加 ${i}` })),
      improved: [],
      fixed: [],
    },
  ],
};

/**
 * A prompt tall enough to reach the card's height. Not taller: past about 10
 * options the sheet's own top goes off the screen (it has no max-height).
 */
const TALL_PROMPT = {
  type: 'multiple_choice',
  question: 'Which of these should the agent do next, given everything above?',
  options: Array.from({ length: 10 }, (_, i) => ({
    number: i + 1,
    label: `Option ${i + 1}`,
    isDefault: i === 0,
  })),
  status: 'pending',
};

interface MockOptions {
  relays?: unknown;
  /** Read on every poll, so a test can take the prompt away. */
  prompt?: { current: unknown; cliTool?: string };
  /** How many rows the worktree list serves (default 1). */
  rows?: number;
}

async function mockApi(page: Page, { relays = { open: [], held: [] }, prompt, rows = 1 }: MockOptions = {}): Promise<void> {
  await page.route(
    url => url.pathname.startsWith('/api/'),
    async route => {
      const { pathname, searchParams } = new URL(route.request().url());
      if (pathname === '/api/app/release-notes') return fulfillJson(route, RELEASE_NOTES);
      if (pathname === '/api/relays') return fulfillJson(route, relays);
      if (pathname === '/api/worktrees') {
        return fulfillJson(route, {
          worktrees: Array.from({ length: rows }, (_, i) =>
            i === 0 ? WORKTREE : { ...WORKTREE, id: `${WORKTREE_ID}-${i}`, name: `E2E row ${i}` }
          ),
          repositories: [
            {
              path: WORKTREE.repositoryPath,
              name: WORKTREE.repositoryName,
              displayName: WORKTREE.repositoryDisplayName,
              worktreeCount: 1,
              visible: true,
            },
          ],
        });
      }
      const detail = pathname.match(/\/api\/worktrees\/([^/]+)(\/.*)?$/);
      if (detail) {
        const sub = detail[2] ?? '';
        if (sub === '') return fulfillJson(route, WORKTREE);
        if (sub.startsWith('/auto-yes')) return fulfillJson(route, { enabled: false, expiresAt: null });
        if (sub.startsWith('/current-output')) {
          const askedTool = searchParams.get('cliTool');
          const promptNow = prompt && (!prompt.cliTool || prompt.cliTool === askedTool) ? prompt.current : null;
          return fulfillJson(route, {
            isRunning: true,
            cliToolId: askedTool ?? 'claude',
            sessionStatus: 'ready',
            isGenerating: false,
            isPromptWaiting: Boolean(promptNow),
            ...(promptNow ? { promptData: promptNow, promptAnswerable: true } : {}),
            content: '> ',
            fullOutput: '> ',
            realtimeSnippet: '> ',
            thinking: false,
            isSelectionListActive: false,
            isPagerActive: false,
            isDismissablePanelActive: false,
            isUnclassifiedActive: false,
            autoYes: { enabled: false, expiresAt: null },
          });
        }
        if (/^\/(messages|memos|execution-logs|schedules)/.test(sub)) return fulfillJson(route, []);
        if (sub.startsWith('/tree')) return fulfillJson(route, { items: [] });
        if (sub.startsWith('/tasks')) return fulfillJson(route, { tasks: [] });
        if (sub.startsWith('/verify/runs')) return fulfillJson(route, { runs: [] });
        if (sub.startsWith('/verify/config')) return fulfillJson(route, { exists: false, gates: [] });
        if (sub.startsWith('/slash-commands')) return fulfillJson(route, { groups: [] });
        return fulfillJson(route, {});
      }
      if (pathname.includes('/repositories') || pathname.includes('/tools')) return fulfillJson(route, []);
      return fulfillJson(route, {});
    },
  );
  await mockStartPreview(page);
}

/** See the file header. Returns a counter of how many served scripts had the guard. */
async function armUpdatePrompt(page: Page): Promise<() => number> {
  let rewritten = 0;
  await page.addInitScript(() => {
    const messages: unknown[] = [];
    (window as unknown as { __swMessages: unknown[] }).__swMessages = messages;
    const noop = (): void => undefined;
    const waiting = { state: 'installed', postMessage: (m: unknown) => messages.push(m), addEventListener: noop, removeEventListener: noop };
    const registration = {
      waiting,
      installing: null,
      active: waiting,
      scope: '/',
      addEventListener: noop,
      removeEventListener: noop,
      update: () => Promise.resolve(),
      unregister: () => Promise.resolve(true),
      pushManager: { getSubscription: () => Promise.resolve(null) },
    };
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        controller: {},
        ready: Promise.resolve(registration),
        register: () => Promise.resolve(registration),
        getRegistration: () => Promise.resolve(registration),
        getRegistrations: () => Promise.resolve([registration]),
        addEventListener: noop,
        removeEventListener: noop,
      },
    });
  });
  await page.route(
    url => url.pathname.startsWith('/_next/') && url.pathname.endsWith('.js'),
    async route => {
      const response = await route.fetch();
      const body = await response.text();
      const patched = body.replace(REGISTER_GUARD, 'true');
      if (patched !== body) rewritten += 1;
      await route.fulfill({ response, body: patched });
    },
  );
  return () => rewritten;
}

/** What the browser would deliver a click to at `locator`'s centre. */
async function receivesClickAtCentre(locator: Locator): Promise<boolean> {
  return locator.evaluate(el => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return hit !== null && (el === hit || el.contains(hit));
  });
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

function boxesOverlap(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

async function clickAtCentre(page: Page, locator: Locator): Promise<void> {
  const box = await locator.boundingBox();
  if (!box) throw new Error('target has no box');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

async function expectPromptShown(page: Page, rewritten: () => number): Promise<void> {
  await expect(
    page.getByTestId('pwa-update-toast-card'),
    'the update prompt did not appear',
  ).toBeVisible({ timeout: 30_000 });
  expect(rewritten(), 'the registration guard was not found in the dev bundle').toBeGreaterThan(0);
}

test.describe('[#4103] the update prompt covers nothing that has to be pressed', () => {
  test('1280×800: What’s new can be closed with its Close button, then Reload can be pressed', async ({ page }) => {
    await page.setViewportSize(PC_VIEWPORT);
    await mockApi(page);
    const rewritten = await armUpdatePrompt(page);
    await page.addInitScript(key => localStorage.setItem(key, '0.0.1'), LAST_SEEN_KEY);
    await page.goto('/sessions');
    await expectPromptShown(page, rewritten);

    const close = page.getByTestId('whats-new-close');
    await expect(close).toBeVisible({ timeout: 30_000 });
    await close.evaluate(el => el.scrollIntoView({ block: 'end' }));
    // The Modal animates in; measure where it comes to rest.
    await expect(page.getByTestId('modal-panel')).toHaveAttribute('data-state', 'open');
    await page.waitForTimeout(EXIT_ANIMATION_DURATION_MS * 2);

    // Not vacuous: the two do overlap, so only the layer order decides the click.
    const card = page.getByTestId('pwa-update-toast-card');
    const [closeBox, cardBox] = [await close.boundingBox(), await card.boundingBox()];
    expect(boxesOverlap(closeBox!, cardBox!), 'the scenario no longer puts Close under the prompt').toBe(true);

    // Positive control: at the toast layer (the defect) the prompt takes the click.
    const toast = page.getByTestId('pwa-update-toast');
    const layer = await toast.evaluate(el => el.style.zIndex);
    await toast.evaluate((el, z) => {
      el.style.zIndex = String(z);
    }, Z_INDEX.TOAST);
    expect(await receivesClickAtCentre(close), 'control: above Modal the prompt should cover Close').toBe(false);
    await toast.evaluate((el, z) => {
      el.style.zIndex = z;
    }, layer);

    expect(await receivesClickAtCentre(close), 'the prompt covers whats-new-close').toBe(true);
    await clickAtCentre(page, close);
    await expect(page.locator('[role="dialog"]')).toHaveCount(0);

    // Below the dialog is not gone: once it closes, the prompt works.
    const reload = page.getByTestId('pwa-update-toast-card').getByRole('button').first();
    expect(await receivesClickAtCentre(reload), 'Reload is not reachable after the dialog closed').toBe(true);
    await clickAtCentre(page, reload);
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __swMessages: unknown[] }).__swMessages))
      .toEqual([{ type: 'SKIP_WAITING' }]);
  });

  test('390×844: no tab of the worktree tab bar is covered', async ({ page }) => {
    await page.setViewportSize(PHONE_VIEWPORT);
    await mockApi(page);
    const rewritten = await armUpdatePrompt(page);
    await page.goto(`/worktrees/${WORKTREE_ID}?pane=terminal`);
    await expectPromptShown(page, rewritten);

    const bar = page.getByTestId('mobile-tab-bar');
    await expect(bar).toBeVisible({ timeout: 30_000 });
    const tabs = bar.getByRole('tab');
    const count = await tabs.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i += 1) {
      expect(await receivesClickAtCentre(tabs.nth(i)), `tab ${i} is covered`).toBe(true);
    }
    // The card moved up here to keep clear of the composer; it must clear this too.
    const surfaceToggle = page.getByTestId('mobile-surface-mode-toggle').getByRole('button');
    const toggleCount = await surfaceToggle.count();
    expect(toggleCount).toBeGreaterThan(0);
    for (let i = 0; i < toggleCount; i += 1) {
      expect(await receivesClickAtCentre(surfaceToggle.nth(i)), `surface button ${i} is covered`).toBe(true);
    }
    const barBox = await bar.boundingBox();
    const cardBox = await page.getByTestId('pwa-update-toast-card').boundingBox();
    expect(cardBox!.y + cardBox!.height).toBeLessThanOrEqual(barBox!.y);
  });

  test('390×844: the global bottom nav is not covered either', async ({ page }) => {
    await page.setViewportSize(PHONE_VIEWPORT);
    await mockApi(page);
    const rewritten = await armUpdatePrompt(page);
    await page.goto('/sessions');
    await expectPromptShown(page, rewritten);

    const nav = page.getByTestId('global-mobile-nav');
    await expect(nav).toBeVisible({ timeout: 30_000 });
    const items = nav.locator('a, button');
    const count = await items.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i += 1) {
      expect(await receivesClickAtCentre(items.nth(i)), `nav item ${i} is covered`).toBe(true);
    }
    const navBox = await nav.boundingBox();
    const cardBox = await page.getByTestId('pwa-update-toast-card').boundingBox();
    expect(cardBox!.y + cardBox!.height).toBeLessThanOrEqual(navBox!.y);
  });

  for (const [label, viewport, query] of [
    ['1280×800', PC_VIEWPORT, ''],
    ['390×844', PHONE_VIEWPORT, '?pane=terminal'],
  ] as const) {
    test(`${label}: the composer's controls still take the click (#2271)`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await mockApi(page);
      const rewritten = await armUpdatePrompt(page);
      await page.goto(`/worktrees/${WORKTREE_ID}${query}`);
      await expectPromptShown(page, rewritten);

      const toggle = page.getByRole('switch', { name: /Auto Yes/ }).first();
      await expect(toggle).toBeVisible({ timeout: 30_000 });

      // With text in it the composer shows everything it ever shows. Every button
      // in it, not only Auto-Yes: at 1280 the send button stands in the prompt's
      // corner, and on a phone a card raised by the tab bar's height lands on it.
      const composer = page.getByTestId('message-input-container').first();
      const input = composer.locator('textarea').first();
      await input.fill('hello');
      await page.screenshot({ path: test.info().outputPath('composer.png') });
      const buttons = composer.locator('button:visible');
      const count = await buttons.count();
      expect(count).toBeGreaterThan(0);
      for (let i = 0; i < count; i += 1) {
        const name = (await buttons.nth(i).getAttribute('aria-label')) ?? (await buttons.nth(i).innerText());
        expect(await receivesClickAtCentre(buttons.nth(i)), `the prompt covers "${name}"`).toBe(true);
      }
      await expect(composer.getByRole('button', { name: /send message/i })).toBeVisible();

      expect(await receivesClickAtCentre(toggle), 'the prompt covers the Auto-Yes switch').toBe(true);
      await clickAtCentre(page, toggle);
      await expect(page.getByTestId('confirm-button')).toBeVisible();
    });
  }
});

const HELD_ALIAS = 'a-rather-long-session-alias-for-the-other-end';

function heldRelay(id: string, instanceId: string, toInstance: string): Record<string, unknown> {
  return {
    id,
    from: { worktreeId: WORKTREE_ID, instanceId },
    to: { worktreeId: WORKTREE_ID, instanceId: toInstance },
    state: 'pending',
    hops: 1,
    sentRequestId: null,
    pendingKind: 'reply',
    createdAt: 0,
    updatedAt: 0,
    expiresAt: 0,
    deliveredAt: null,
    deliveryHold: {
      state: 'uncertain',
      payloadId: id,
      attemptId: id,
      kind: 'reply',
      reason: 'send-error',
      at: 1,
      checkCommand: 'commandmate capture x --instance y --pane',
    },
  };
}

test.describe('[#4103] the prompt on the phone screens other than the worktree', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(PHONE_VIEWPORT);
  });

  test('Sessions: the filter and both sort controls take the click', async ({ page }) => {
    await mockApi(page, { rows: 12 });
    const rewritten = await armUpdatePrompt(page);
    await page.goto('/sessions');
    await expectPromptShown(page, rewritten);

    for (const id of ['sessions-filter', 'sessions-sort-select', 'sessions-sort-direction']) {
      const target = page.getByTestId(id);
      await expect(target).toBeVisible({ timeout: 30_000 });
      expect(await receivesClickAtCentre(target), `the prompt covers ${id}`).toBe(true);
    }
    await clickAtCentre(page, page.getByTestId('sessions-sort-direction'));
  });

  // The position must not rest on any one screen's layout: every control on every
  // screen the prompt can appear over, rows included, with a long list.
  for (const path of ['/sessions', '/repositories', '/review', '/more', '/skills']) {
    test(`${path}: no control has its centre under the prompt`, async ({ page }) => {
      await mockApi(page, { rows: 12 });
      const rewritten = await armUpdatePrompt(page);
      await page.goto(path);
      await expectPromptShown(page, rewritten);
      await page.waitForLoadState('networkidle').catch(() => undefined);

      const covered = await page.evaluate(() => {
        const card = document.querySelector('[data-testid="pwa-update-toast-card"]');
        const controls = document.querySelectorAll<HTMLElement>('a, button, input, select, textarea, [role="button"]');
        return Array.from(controls)
          .filter(el => !card?.contains(el))
          .filter(el => {
            const r = el.getBoundingClientRect();
            const x = r.left + r.width / 2;
            const y = r.top + r.height / 2;
            if (r.width === 0 || y < 0 || y > innerHeight) return false;
            const hit = document.elementFromPoint(x, y);
            return hit !== null && card?.contains(hit) === true;
          })
          .map(el => el.getAttribute('data-testid') ?? el.getAttribute('aria-label') ?? el.textContent?.slice(0, 40));
      });
      expect(covered).toEqual([]);
    });
  }

  test('a confirmation sheet: the prompt steps aside, and comes back after it', async ({ page }) => {
    const prompt = { current: TALL_PROMPT as unknown };
    await mockApi(page, { prompt });
    const rewritten = await armUpdatePrompt(page);
    await page.goto(`/worktrees/${WORKTREE_ID}?pane=terminal`);

    const sheet = page.getByTestId('mobile-prompt-sheet');
    await expect(sheet).toBeVisible({ timeout: 30_000 });
    expect(rewritten()).toBeGreaterThan(0);
    await page.waitForTimeout(1_000);

    // Positive control, and the reproduction of the defect: with the step-aside
    // switched off the card IS drawn over the sheet, though the sheet says z-50.
    // `main` opens a stacking context, so that z-50 never meets the card's 45.
    const unhide = await page.addStyleTag({
      content: '[data-testid="pwa-update-toast"] { display: flex !important; }',
    });
    const card = page.getByTestId('pwa-update-toast-card');
    await expect(card).toBeVisible();
    const sheetBox = await sheet.boundingBox();
    const cardBox = await card.boundingBox();
    expect(boxesOverlap(sheetBox!, cardBox!), 'the scenario no longer reaches the card').toBe(true);
    expect(await receivesClickAtCentre(card), 'control: the card should be on top of the sheet').toBe(true);
    await unhide.evaluate(el => (el as HTMLElement).remove());

    await expect(card).toBeHidden();
    // Everything in the sheet, not just what happens to be near the prompt.
    const controls = sheet.locator('button, input, h3');
    const count = await controls.count();
    expect(count).toBeGreaterThan(5);
    for (let i = 0; i < count; i += 1) {
      expect(await receivesClickAtCentre(controls.nth(i)), `the prompt covers sheet item ${i}`).toBe(true);
    }

    // Negative control: this is the sheet stepping it aside, not a prompt that never came.
    prompt.current = null;
    await expect(sheet).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByTestId('pwa-update-toast-card')).toBeVisible();
  });

  test('it can be put away for now, and the update is offered again on the next load', async ({ page }) => {
    await mockApi(page);
    const rewritten = await armUpdatePrompt(page);
    await page.goto(`/worktrees/${WORKTREE_ID}?pane=terminal`);
    await expectPromptShown(page, rewritten);

    await page.getByTestId('pwa-update-toast-dismiss').click();
    await expect(page.getByTestId('pwa-update-toast-card')).toHaveCount(0);

    await page.reload();
    await expect(page.getByTestId('pwa-update-toast-card')).toBeVisible({ timeout: 30_000 });
  });
});

test.describe('[#4103] what counts as a dialog the prompt steps aside for', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(PC_VIEWPORT);
  });

  test('negative: the inline PromptPanel blocks nothing, so Reload and × stay', async ({ page }) => {
    await mockApi(page, { prompt: { current: TALL_PROMPT } });
    const rewritten = await armUpdatePrompt(page);
    await page.goto(`/worktrees/${WORKTREE_ID}`);
    await expect(page.getByTestId('prompt-panel').first()).toBeVisible({ timeout: 30_000 });
    expect(await page.getByTestId('prompt-panel').first().getAttribute('aria-modal')).toBe('true');
    await expectPromptShown(page, rewritten);
    await expect(page.getByTestId('pwa-update-toast-dismiss')).toBeVisible();
  });

  test('negative: a question in a split hidden behind a maximized one does not hide it', async ({ page }) => {
    await page.addInitScript(
      ([key, value]) => localStorage.setItem(key, value),
      [
        getTerminalSplitsStorageKey(WORKTREE_ID),
        JSON.stringify({
          splits: [
            { cliToolId: 'claude', instanceId: 'claude' },
            { cliToolId: 'codex', instanceId: 'codex' },
          ],
          widths: [50, 50],
        }),
      ],
    );
    await mockApi(page, { prompt: { current: TALL_PROMPT, cliTool: 'codex' } });
    const rewritten = await armUpdatePrompt(page);
    await page.goto(`/worktrees/${WORKTREE_ID}`);
    await expect(page.getByTestId('prompt-panel').first()).toBeVisible({ timeout: 30_000 });

    await page.getByTestId('split-wrapper-0').click({ position: { x: 40, y: 40 } });
    await page.getByTestId('toggle-maximize-split').click();
    await expect(page.getByTestId('split-wrapper-1')).toHaveAttribute('data-hidden', 'true');
    await expect(page.getByTestId('prompt-panel').first()).toBeAttached();
    await expect(page.getByTestId('prompt-panel').first()).toBeHidden();

    await expectPromptShown(page, rewritten);
  });

  // The selector's own table, in a browser because jsdom has no Tailwind. Each row
  // is put in `main` as those dialogs really are; `modal-open.ts` is the same list.
  test('the conditions, one by one', async ({ page }) => {
    await mockApi(page);
    const rewritten = await armUpdatePrompt(page);
    await page.goto('/sessions');
    await expectPromptShown(page, rewritten);
    const card = page.getByTestId('pwa-update-toast-card');

    const rows: Array<[string, string, boolean]> = [
      ['a real modal, as GitBranchPanel draws one', '<div role="dialog" aria-modal="true"></div>', true],
      ['the inline PromptPanel', '<div role="dialog" aria-modal="true" data-testid="prompt-panel"></div>', false],
      ['a dialog on its way out', '<div role="dialog" aria-modal="true" data-state="closed"></div>', false],
      ['inside a split behind a maximized one', '<div data-hidden="true"><div role="dialog" aria-modal="true"></div></div>', false],
      ['inside a hidden element', '<div hidden><div role="dialog" aria-modal="true"></div></div>', false],
      ['aria-modal without the dialog role', '<div aria-modal="true"></div>', false],
    ];
    for (const [label, html, hides] of rows) {
      const added = await page.evaluateHandle(markup => {
        const holder = document.createElement('div');
        holder.innerHTML = markup;
        document.querySelector('main')?.appendChild(holder);
        return holder;
      }, html);
      if (hides) await expect(card, label).toBeHidden();
      else await expect(card, label).toBeVisible();
      await added.evaluate(el => el.remove());
      await expect(card, `${label}: back after it goes`).toBeVisible();
    }
  });
});

test.describe('[#4103] the PC roster at 1280 wide', () => {
  const HELD = [
    heldRelay('r1', 'claude', 'a'),
    heldRelay('r2', 'claude', 'b'),
    heldRelay('r3', 'claude', 'c'),
    heldRelay('r4', 'claude', 'd'),
    heldRelay('r5', 'codex', HELD_ALIAS),
  ];

  for (const [locale, manyText, oneText] of [
    ['en', '4 unconfirmed', 'Unconfirmed: '],
    ['ja', '4 件の配送が未確認', '配送が未確認: '],
  ] as const) {
    test(`${locale}: the held count is not cut off`, async ({ page, context }) => {
      await context.addCookies([{ name: 'locale', value: locale, domain: 'localhost', path: '/' }]);
      await page.setViewportSize(PC_VIEWPORT);
      await page.addInitScript(id => {
        localStorage.setItem(`commandmate.worktree.activeActivity-${id}`, 'agent');
      }, WORKTREE_ID);
      await mockApi(page, { relays: { open: HELD, held: HELD, owed: [], awaiting: [] } });
      await page.goto(`/worktrees/${WORKTREE_ID}`);

      const many = page.getByTestId('agent-instance-relay-held-claude');
      await expect(many).toBeVisible({ timeout: 30_000 });
      await expect(many).toHaveText(manyText);
      // `truncate` clips without changing the text: only the box says it was cut.
      const clipped = await many.locator('span').evaluate(el => el.scrollWidth > el.clientWidth);
      expect(clipped, 'the count line is clipped').toBe(false);

      // One relay with a long alias: what is at stake is at the front, so a cut
      // takes the end of the name and not the word "unconfirmed".
      const one = page.getByTestId('agent-instance-relay-held-codex');
      await expect(one).toContainText(oneText);
      await page.getByTestId('agent-instances-pane').screenshot({ path: test.info().outputPath(`roster-${locale}.png`) });
    });
  }
});
