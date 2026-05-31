/**
 * E2E fixtures for terminal-split tests (Issue #735 / #728 AC-27)
 *
 * The worktree detail page (`/worktrees/[id]`) normally depends on a real
 * SQLite DB, a real git worktree scan, and tmux/CLI sessions — none of which
 * are reproducible in CI. These helpers decouple the PC split UI from that
 * backend by **mocking the worktree API routes at the browser level**
 * (`page.route`), so the split shell (ActivityBar + TerminalSplitContainer +
 * PaneResizers) renders deterministically without any live session.
 *
 * They also provide **per-test localStorage isolation**: existing e2e specs
 * run `fullyParallel` and never clear localStorage, while the split feature
 * persists `commandmate:terminalSplits:{worktreeId}`. Without isolation, a
 * persisted split config (incl. drag-resized widths) would leak across tests
 * and retries and break the known-initial-state assumptions (S3-001 / S3-006).
 *
 * Strategy reference: Issue #735 work-plan "テストフィクスチャ戦略 (API モック優先)".
 */

import type { Page, Route } from '@playwright/test';

/** Unique worktree IDs scoped to these specs (must not collide with other
 *  e2e specs that reuse generic IDs like `test-worktree`). */
export const E2E_WORKTREE_A = 'e2e-split-a';
export const E2E_WORKTREE_B = 'e2e-split-b';

/** localStorage key prefix used by `useTerminalSplits` (mirror of
 *  `TERMINAL_SPLITS_STORAGE_KEY_PREFIX` in src/config/terminal-split-config.ts). */
const TERMINAL_SPLITS_PREFIX = 'commandmate:terminalSplits:';

/** Activity-bar persistence key (mirror of ACTIVITY_BAR_STORAGE_KEY). Cleared
 *  so the Files activity toggle starts from a known state. */
const ACTIVITY_BAR_KEY = 'commandmate.worktree.activeActivity';

/** History pane visibility key (mirror of useHistoryPaneState). Cleared so
 *  History starts from its default (visible=true). */
const HISTORY_VISIBLE_KEY = 'commandmate.worktree.historyVisible';
const HISTORY_WIDTH_KEY = 'commandmate.worktree.historyWidth';

/** Build a minimal Worktree object sufficient to render the detail page. */
function buildWorktree(id: string): Record<string, unknown> {
  return {
    id,
    name: `E2E ${id}`,
    path: `/tmp/${id}`,
    repositoryPath: `/tmp/${id}-repo`,
    repositoryName: 'e2e-repo',
    repositoryDisplayName: 'E2E Repo',
    description: 'E2E split test worktree',
    // All 6 CLI tools so any split auto-assigned CLI is permissible.
    selectedAgents: ['claude', 'codex', 'gemini', 'vibe-local', 'opencode', 'copilot'],
    cliToolId: 'claude',
    status: 'ready',
    sessionStatusByCli: {
      claude: { isRunning: false, isWaitingForResponse: false, isProcessing: false },
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

/** Stub `current-output` response: no running session, empty terminal. */
const EMPTY_OUTPUT = {
  isRunning: false,
  cliToolId: 'claude',
  isGenerating: false,
  isPromptWaiting: false,
  content: '',
  fullOutput: '',
  realtimeSnippet: '',
  thinking: false,
  isSelectionListActive: false,
};

function fulfillJson(route: Route, body: unknown): Promise<void> {
  return route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

/**
 * Intercept ALL `/api/...` requests for the duration of a test and serve
 * deterministic responses for the worktree detail page. Anything not
 * explicitly handled returns an empty, well-formed payload so the UI never
 * hangs on a pending fetch or surfaces an error state.
 *
 * Registered as a URL predicate (not a glob) to avoid trailing-segment
 * ambiguity between `/api/worktrees/{id}` and `/api/worktrees/{id}/...`.
 */
export async function mockWorktreeApi(
  page: Page,
  ids: string[] = [E2E_WORKTREE_A, E2E_WORKTREE_B],
): Promise<void> {
  const worktrees = ids.map(buildWorktree);
  const byId = new Map(worktrees.map(w => [w.id as string, w]));

  await page.route(
    url => url.pathname.startsWith('/api/'),
    async route => {
      const { pathname } = new URL(route.request().url());

      // Worktree list endpoint.
      if (pathname === '/api/worktrees' || pathname.endsWith('/api/worktrees')) {
        return fulfillJson(route, worktrees);
      }

      // Sub-resources of a specific worktree.
      const detailMatch = pathname.match(/\/api\/worktrees\/([^/]+)(\/.*)?$/);
      if (detailMatch) {
        const id = decodeURIComponent(detailMatch[1]);
        const sub = detailMatch[2] ?? '';
        const wt = byId.get(id) ?? buildWorktree(id);

        if (sub === '' ) return fulfillJson(route, wt);
        if (sub.startsWith('/messages')) return fulfillJson(route, []);
        if (sub.startsWith('/current-output')) return fulfillJson(route, EMPTY_OUTPUT);
        if (sub.startsWith('/memos')) return fulfillJson(route, []);
        if (sub.startsWith('/execution-logs')) return fulfillJson(route, []);
        if (sub.startsWith('/schedules')) return fulfillJson(route, []);
        // FileTreeView reads `rootData.items`.
        if (sub.startsWith('/tree')) return fulfillJson(route, { items: [] });
        // useSlashCommands reads `data.groups`.
        if (sub.startsWith('/slash-commands')) return fulfillJson(route, { groups: [] });
        // Any other worktree sub-resource: empty object is safe.
        return fulfillJson(route, {});
      }

      // Repositories / tools / anything else under /api/: empty-but-valid.
      if (pathname.includes('/repositories')) return fulfillJson(route, []);
      if (pathname.includes('/tools')) return fulfillJson(route, []);
      return fulfillJson(route, {});
    },
  );
}

/** sessionStorage guard key: ensures the localStorage clear runs only on the
 *  FIRST document load of a test, not on every `page.goto`. Critical for the
 *  cross-worktree persistence spec, which navigates several times and relies on
 *  split config persisting across those navigations. sessionStorage survives
 *  same-tab navigations but is reset per fresh Playwright context (per test). */
const CLEARED_GUARD_KEY = '__e2e_split_cleared__';

/**
 * Clear split/layout localStorage exactly ONCE per test, before any app script
 * runs. Uses an `addInitScript` (runs before app JS on every document) but
 * gates the actual clear behind a sessionStorage flag so it fires only on the
 * first load — subsequent navigations within the same test keep the
 * worktree-scoped split config they persisted (S3-001 isolation without
 * defeating the persistence assertions).
 */
export async function clearSplitStorage(page: Page): Promise<void> {
  await page.addInitScript(
    ({ prefix, keys, guard }) => {
      try {
        if (sessionStorage.getItem(guard)) return;
        sessionStorage.setItem(guard, '1');
        Object.keys(localStorage)
          .filter(k => k.startsWith(prefix))
          .forEach(k => localStorage.removeItem(k));
        keys.forEach((k: string) => localStorage.removeItem(k));
      } catch {
        /* localStorage / sessionStorage unavailable - non-fatal */
      }
    },
    {
      prefix: TERMINAL_SPLITS_PREFIX,
      keys: [ACTIVITY_BAR_KEY, HISTORY_VISIBLE_KEY, HISTORY_WIDTH_KEY],
      guard: CLEARED_GUARD_KEY,
    },
  );
}

/**
 * Combined setup: install API mocks + localStorage isolation. Call in
 * `beforeEach` before any `page.goto`.
 */
export async function setupSplitTest(
  page: Page,
  ids: string[] = [E2E_WORKTREE_A, E2E_WORKTREE_B],
): Promise<void> {
  await clearSplitStorage(page);
  await mockWorktreeApi(page, ids);
}

/**
 * Ensure the Files activity pane (and therefore its ActivityPane↔Right
 * PaneResizer) is visible, regardless of the persisted/default activity
 * state. Idempotent: clicks the Files button only if the pane is hidden.
 */
export async function ensureFilesActivityVisible(page: Page): Promise<void> {
  const slot = page.locator('[data-testid="activity-pane-slot"]');
  const visible = await slot.isVisible().catch(() => false);
  if (!visible) {
    await page.click('[data-testid="activity-bar-button-files"]');
  }
}
