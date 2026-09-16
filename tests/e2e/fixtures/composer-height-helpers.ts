/**
 * E2E fixtures for the two-row PC composer and its height handle (Issue #2598).
 *
 * Self-contained for the reason `agent-mode-helpers.ts` gives: the specs that
 * measure pixel budgets (#2106, #2131, #2592/#2597) each own their fixture, so
 * editing one to suit another cannot move a floor unnoticed. The measuring
 * helpers (`boxesInSplit` and friends) are pure and are reused from there.
 *
 * What differs from #2597's fixture:
 *
 * - **Up to four splits.** The fourth split turns the row into the #2421 grid,
 *   which halves each pane's height — the one split-count change that moves the
 *   composer's upper bound. Four distinct instances are served so that
 *   `useTerminalSplits` can assign one to each split.
 * - **Two worktrees.** "A stored height does not leak into another worktree"
 *   needs a second one with the same layout.
 *
 * No agent process is involved; `/api/` is mocked in the browser.
 */

import type { Page, Route } from '@playwright/test';
import { getTerminalSplitsStorageKey } from '../../../src/config/terminal-split-config';
import {
  COMPOSER_HEIGHT_STORAGE_KEY_PREFIX,
} from '../../../src/config/composer-height';
import { modeFrame } from './agent-mode-helpers';

/** Worktree ids scoped to the #2598 specs (must not collide with other specs). */
export const E2E_COMPOSER_WORKTREE = 'e2e-composer-2598-a';
export const E2E_COMPOSER_OTHER_WORKTREE = 'e2e-composer-2598-b';

/**
 * The four instances, in split order, and the frame each serves.
 *
 * All four declare a mode cycle, so every pane's toolbar carries the widest
 * control the composer has (#2592) — the layout claims are made against the
 * worst case, not against a pane with an empty toolbar.
 */
export const COMPOSER_SPLITS = [
  { cliTool: 'claude', frame: 'claude-auto', agentMode: 'auto' },
  { cliTool: 'codex', frame: 'codex-plan', agentMode: 'plan' },
  { cliTool: 'copilot', frame: 'copilot-plan', agentMode: 'plan' },
  { cliTool: 'antigravity', frame: 'antigravity-plan', agentMode: 'plan' },
] as const;

/**
 * A fifth instance the worktree also declares, for the one pane that needs it:
 * opencode draws no mode control but four session buttons in the toolbar
 * (#2038), the widest toolbar content a narrow pane has to hold.
 */
export const OPENCODE_SPLIT = { cliTool: 'opencode', frame: 'claude-plan', agentMode: 'unknown' } as const;

const ALL_INSTANCES = [...COMPOSER_SPLITS, OPENCODE_SPLIT] as const;

/** Mirrors of the storage keys the detail page reads on mount. */
const ACTIVE_CLI_TAB_PREFIX = 'activeCliTab-';
const ACTIVE_INSTANCE_PREFIX = 'activeInstanceId-';
const ACTIVITY_BAR_PREFIX = 'commandmate.worktree.activeActivity-';
const HISTORY_VISIBLE_KEY = 'commandmate.worktree.historyVisible';
const HISTORY_WIDTH_KEY = 'commandmate.worktree.historyWidth';

/** The composer-height key the app writes (mirror of `getComposerHeightStorageKey`). */
export function composerHeightKey(worktreeId: string, scope: string): string {
  return `${COMPOSER_HEIGHT_STORAGE_KEY_PREFIX}${worktreeId}:${scope}`;
}

function buildWorktree(id: string): Record<string, unknown> {
  const tools = ALL_INSTANCES.map(split => split.cliTool);
  return {
    id,
    name: `E2E ${id}`,
    path: `/tmp/${id}`,
    repositoryPath: `/tmp/${id}-repo`,
    repositoryName: 'e2e-repo',
    repositoryDisplayName: 'E2E Repo',
    description: 'E2E composer worktree',
    selectedAgents: [...tools],
    agentInstances: tools.map((cliTool, order) => ({ id: cliTool, cliTool, alias: cliTool, order })),
    cliToolId: tools[0],
    status: 'ready',
    sessionStatusByCli: Object.fromEntries(
      tools.map(cliTool => [
        cliTool,
        { isRunning: true, isWaitingForResponse: false, isProcessing: false },
      ]),
    ),
    gitStatus: {
      currentBranch: 'main',
      initialBranch: 'main',
      isBranchMismatch: false,
      commitHash: 'e2e0000',
      isDirty: false,
    },
  };
}

function buildOutput(cliTool: string, frame: string, agentMode: string): Record<string, unknown> {
  const output = modeFrame(frame);
  return {
    isRunning: true,
    cliToolId: cliTool,
    sessionStatus: 'ready',
    sessionStatusReason: 'input_prompt',
    isGenerating: false,
    isPromptWaiting: false,
    content: output,
    fullOutput: output,
    realtimeSnippet: output.split('\n').slice(-100).join('\n'),
    thinking: false,
    isSelectionListActive: false,
    isPagerActive: false,
    isDismissablePanelActive: false,
    isUnclassifiedActive: false,
    statusEvidence: 'positive',
    agentMode,
  };
}

function fulfillJson(route: Route, body: unknown): Promise<void> {
  return route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

/**
 * Serve both worktrees' detail pages and (with `listResponse`) the `/sessions` tiles.
 *
 * `/current-output` is keyed on the `cliTool` query parameter, because each
 * split polls for its own tool (#728).
 */
export async function mockComposerApi(
  page: Page,
  options: {
    autoYesEnabled?: boolean;
    /**
     * Serve `GET /api/worktrees` as the real `{ worktrees, repositories }`
     * payload, which `/sessions` needs to draw its tiles. Off by default: the
     * detail-page measurements above were taken with the bare array (the
     * sidebar then lists nothing), and a populated sidebar is not what they
     * compare against.
     */
    listResponse?: boolean;
  } = {},
): Promise<void> {
  const worktrees = [buildWorktree(E2E_COMPOSER_WORKTREE), buildWorktree(E2E_COMPOSER_OTHER_WORKTREE)];
  // Auto-Yes on draws the toggle at its widest (label, tool name, countdown).
  const autoYes = {
    instances: Object.fromEntries(
      ALL_INSTANCES.map(split => [
        split.cliTool,
        {
          enabled: options.autoYesEnabled ?? false,
          expiresAt: options.autoYesEnabled ? Date.now() + 3 * 60 * 60 * 1000 : null,
        },
      ]),
    ),
  };
  const byId = new Map(worktrees.map(w => [w.id as string, w]));
  const outputs = new Map<string, Record<string, unknown>>(
    ALL_INSTANCES.map(split => [split.cliTool, buildOutput(split.cliTool, split.frame, split.agentMode)]),
  );
  const fallback = outputs.get(COMPOSER_SPLITS[0].cliTool);

  await page.route(
    url => url.pathname.startsWith('/api/'),
    async route => {
      const requestUrl = new URL(route.request().url());
      const { pathname } = requestUrl;

      if (pathname === '/api/worktrees' || pathname.endsWith('/api/worktrees')) {
        return fulfillJson(
          route,
          options.listResponse ? { worktrees, repositories: [] } : worktrees,
        );
      }

      const detailMatch = pathname.match(/\/api\/worktrees\/([^/]+)(\/.*)?$/);
      if (detailMatch) {
        const id = decodeURIComponent(detailMatch[1]);
        const sub = detailMatch[2] ?? '';
        if (sub === '') return fulfillJson(route, byId.get(id) ?? worktrees[0]);
        if (sub.startsWith('/current-output')) {
          const cliTool = requestUrl.searchParams.get('cliTool') ?? '';
          return fulfillJson(route, outputs.get(cliTool) ?? fallback);
        }
        if (sub.startsWith('/auto-yes')) return fulfillJson(route, autoYes);
        if (sub.startsWith('/special-keys')) return fulfillJson(route, { success: true });
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

/**
 * Seed the split layout for both worktrees, once per tab.
 *
 * Guarded by a sessionStorage flag (the #735 / #2131 pattern), so a reload
 * observes what the app wrote — a stored composer height, a changed split
 * count — rather than the seed.
 *
 * @param widths - Persisted width shares, one per split. Its length is the
 *   split count; 4 is the #2421 grid.
 * @param tools - The instance of each split, in order (default: COMPOSER_SPLITS).
 */
export async function seedComposerSplits(
  page: Page,
  widths: readonly number[],
  tools: readonly string[] = COMPOSER_SPLITS.map(split => split.cliTool),
): Promise<void> {
  const splits = tools.slice(0, widths.length).map(cliTool => ({
    cliToolId: cliTool,
    instanceId: cliTool,
  }));
  const splitsValue = JSON.stringify({ splits, widths: [...widths] });
  const first = COMPOSER_SPLITS[0].cliTool;
  const perWorktree = [E2E_COMPOSER_WORKTREE, E2E_COMPOSER_OTHER_WORKTREE].map(id => ({
    splitsKey: getTerminalSplitsStorageKey(id),
    cliKey: ACTIVE_CLI_TAB_PREFIX + id,
    instanceKey: ACTIVE_INSTANCE_PREFIX + id,
  }));

  await page.addInitScript(
    ({ entries, value, tool, clearKeys, clearPrefixes, guard }) => {
      try {
        if (sessionStorage.getItem(guard)) return;
        sessionStorage.setItem(guard, '1');
        for (const entry of entries) {
          localStorage.setItem(entry.splitsKey, value);
          localStorage.setItem(entry.cliKey, tool);
          localStorage.setItem(entry.instanceKey, tool);
        }
        clearKeys.forEach((k: string) => localStorage.removeItem(k));
        Object.keys(localStorage)
          .filter(k => clearPrefixes.some((p: string) => k.startsWith(p)))
          .forEach(k => localStorage.removeItem(k));
      } catch {
        /* storage unavailable - non-fatal */
      }
    },
    {
      entries: perWorktree,
      value: splitsValue,
      tool: first,
      clearKeys: [HISTORY_VISIBLE_KEY, HISTORY_WIDTH_KEY],
      clearPrefixes: [ACTIVITY_BAR_PREFIX, COMPOSER_HEIGHT_STORAGE_KEY_PREFIX],
      guard: '__e2e_2598_seeded__',
    },
  );
}

/**
 * Open one worktree's detail page and wait until `chips` panes have read their
 * frames (a pane draws its mode chip once its first poll has landed).
 */
export async function openComposerWorktree(
  page: Page,
  chips: number,
  id: string = E2E_COMPOSER_WORKTREE,
): Promise<void> {
  await page.goto(`/worktrees/${id}`);
  await page.getByTestId('terminal-split-container').waitFor({ state: 'visible', timeout: 30_000 });
  await page.waitForFunction(
    n => document.querySelectorAll('[data-testid="agent-mode-chip"]').length === n,
    chips,
    { timeout: 30_000 },
  );
}

/** Mirror of SESSIONS_VIEW_MODE_STORAGE_KEY (src/hooks/useSessionsViewMode.ts). */
const SESSIONS_VIEW_MODE_KEY = 'mcbd-sessions-view-mode';

/** Open `/sessions` in tile mode, with no stored composer heights. */
export async function openSessionTiles(page: Page): Promise<void> {
  await page.addInitScript(
    ({ viewKey, prefix, guard }) => {
      try {
        if (sessionStorage.getItem(guard)) return;
        sessionStorage.setItem(guard, '1');
        localStorage.setItem(viewKey, 'tile');
        Object.keys(localStorage)
          .filter(k => k.startsWith(prefix))
          .forEach(k => localStorage.removeItem(k));
      } catch {
        /* storage unavailable - non-fatal */
      }
    },
    {
      viewKey: SESSIONS_VIEW_MODE_KEY,
      prefix: COMPOSER_HEIGHT_STORAGE_KEY_PREFIX,
      guard: '__e2e_2598_sessions_seeded__',
    },
  );
  await mockComposerApi(page, { listResponse: true });
  await page.goto('/sessions');
  await page
    .getByTestId(`session-tile-composer-${E2E_COMPOSER_WORKTREE}`)
    .waitFor({ state: 'visible', timeout: 30_000 });
}
