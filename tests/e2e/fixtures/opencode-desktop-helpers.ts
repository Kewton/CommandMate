/**
 * E2E fixtures for the PC opencode split pane (Issue #2131).
 *
 * #2131 is the same KIND of Issue as #2106 — a claim about how many pixels the
 * quick-keys strip takes away from `TerminalDisplay` — but on the other screen.
 * #2106 wrote into the component that PC did not need folding "because a split
 * pane has the width", and nobody had measured PC to check. These helpers are
 * what makes checking possible: the real desktop detail page, in a real browser,
 * at a real desktop viewport, with `/api/` mocked at the browser level exactly
 * as `terminal-split-helpers.ts` (Issue #735) and `opencode-mobile-helpers.ts`
 * (Issue #2106) already do.
 *
 * No opencode process is involved. The strip's gate is `terminal.isRunning` +
 * `cliToolId === 'opencode'`, both fields on `/current-output`, so a mocked
 * payload renders the identical tree.
 *
 * ## Why the roster is opencode + claude + codex
 *
 * The Issue's 3-split measurement carries its own control INSIDE one frame:
 * splits 1 and 2 showed no strip and kept 650px of terminal while split 0 kept
 * 64px. Reproducing that needs a roster of three DISTINCT instances (
 * `useTerminalSplits` trims the split count to `instances.length` and forbids
 * one instance in two splits), only the first of which is opencode. So split 0
 * is the measured pane and splits 1/2 are the control — same viewport, same
 * pane width, same everything but the strip.
 */

import type { Page, Route } from '@playwright/test';
import { getTerminalSplitsStorageKey } from '../../../src/config/terminal-split-config';

/** Worktree id scoped to the #2131 specs (must not collide with other specs). */
export const E2E_DESKTOP_OPENCODE_WORKTREE = 'e2e-opencode-2131';

/** Mirror of ACTIVE_CLI_TAB_STORAGE_KEY_PREFIX in useWorktreeDetailController. */
const ACTIVE_CLI_TAB_PREFIX = 'activeCliTab-';
/** Mirror of ACTIVE_INSTANCE_STORAGE_KEY_PREFIX in useWorktreeDetailController. */
const ACTIVE_INSTANCE_PREFIX = 'activeInstanceId-';

/** Activity-bar / history keys, cleared so every run starts from the defaults. */
const ACTIVITY_BAR_PREFIX = 'commandmate.worktree.activeActivity-';
const HISTORY_VISIBLE_KEY = 'commandmate.worktree.historyVisible';
const HISTORY_WIDTH_KEY = 'commandmate.worktree.historyWidth';

/**
 * The three splits, in order. Only the first is opencode — the other two are the
 * in-frame control the Issue's measurement relies on.
 */
export const DESKTOP_SPLIT_TOOLS = ['opencode', 'claude', 'codex'] as const;

/** Enough rows that TerminalDisplay is never at empty-placeholder height. */
const TERMINAL_OUTPUT = Array.from({ length: 200 }, (_, i) => `row ${i + 1}`).join('\n');

function buildWorktree(id: string): Record<string, unknown> {
  return {
    id,
    name: `E2E ${id}`,
    path: `/tmp/${id}`,
    repositoryPath: `/tmp/${id}-repo`,
    repositoryName: 'e2e-repo',
    repositoryDisplayName: 'E2E Repo',
    description: 'E2E opencode desktop worktree',
    selectedAgents: [...DESKTOP_SPLIT_TOOLS],
    agentInstances: DESKTOP_SPLIT_TOOLS.map((cliTool, order) => ({
      id: cliTool,
      cliTool,
      alias: cliTool,
      order,
    })),
    cliToolId: DESKTOP_SPLIT_TOOLS[0],
    status: 'ready',
    sessionStatusByCli: Object.fromEntries(
      DESKTOP_SPLIT_TOOLS.map(cliTool => [
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

/** A live pane: running, not generating, no prompt, no agent session yet. */
function buildOutput(cliTool: string): Record<string, unknown> {
  return {
    isRunning: true,
    cliToolId: cliTool,
    isGenerating: false,
    isPromptWaiting: false,
    content: TERMINAL_OUTPUT,
    fullOutput: TERMINAL_OUTPUT,
    realtimeSnippet: 'row 200',
    thinking: false,
    isSelectionListActive: false,
    isPagerActive: false,
    isUnclassifiedActive: false,
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
 * Serve deterministic `/api/` responses for the desktop opencode detail page.
 *
 * `/current-output` is keyed on the `cliTool` query parameter, because each
 * split polls for its OWN tool (Issue #728) and a single canned payload would
 * make all three splits claim to be opencode.
 */
export async function mockDesktopOpencodeApi(
  page: Page,
  id: string = E2E_DESKTOP_OPENCODE_WORKTREE,
): Promise<void> {
  const worktree = buildWorktree(id);

  await page.route(
    url => url.pathname.startsWith('/api/'),
    async route => {
      const requestUrl = new URL(route.request().url());
      const { pathname } = requestUrl;

      if (pathname === '/api/worktrees' || pathname.endsWith('/api/worktrees')) {
        return fulfillJson(route, [worktree]);
      }

      const detailMatch = pathname.match(/\/api\/worktrees\/([^/]+)(\/.*)?$/);
      if (detailMatch) {
        const sub = detailMatch[2] ?? '';
        if (sub === '') return fulfillJson(route, worktree);
        if (sub.startsWith('/messages')) return fulfillJson(route, []);
        if (sub.startsWith('/current-output')) {
          const cliTool = requestUrl.searchParams.get('cliTool') ?? DESKTOP_SPLIT_TOOLS[0];
          return fulfillJson(route, buildOutput(cliTool));
        }
        if (sub.startsWith('/memos')) return fulfillJson(route, []);
        if (sub.startsWith('/execution-logs')) return fulfillJson(route, []);
        if (sub.startsWith('/schedules')) return fulfillJson(route, []);
        if (sub.startsWith('/tree')) return fulfillJson(route, { items: [] });
        if (sub.startsWith('/tasks')) return fulfillJson(route, { tasks: [] });
        if (sub.startsWith('/verify/runs')) return fulfillJson(route, { runs: [] });
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
 * Seed the page's localStorage before any app script runs.
 *
 * Everything here happens exactly ONCE per test, gated on a sessionStorage flag:
 * `addInitScript` runs before app JS on EVERY document, so an unguarded seed
 * would also overwrite the preference the reload test is trying to observe
 * surviving a reload (the same guard `clearSplitStorage` uses since #735).
 *
 * @param page - The page under test.
 * @param disclosureKeys - Disclosure keys to clear so each test starts at the
 *   component's declared default rather than a leftover preference.
 * @param id - Worktree id to seed the split config for.
 */
export async function seedDesktopOpencodeSplits(
  page: Page,
  disclosureKeys: string[],
  id: string = E2E_DESKTOP_OPENCODE_WORKTREE,
): Promise<void> {
  await page.addInitScript(
    ({ splitsKey, splitsValue, cliKey, instanceKey, tool, clearKeys, clearPrefixes, guard }) => {
      try {
        if (sessionStorage.getItem(guard)) return;
        sessionStorage.setItem(guard, '1');
        localStorage.setItem(splitsKey, splitsValue);
        localStorage.setItem(cliKey, tool);
        localStorage.setItem(instanceKey, tool);
        clearKeys.forEach((k: string) => localStorage.removeItem(k));
        Object.keys(localStorage)
          .filter(k => clearPrefixes.some((p: string) => k.startsWith(p)))
          .forEach(k => localStorage.removeItem(k));
      } catch {
        /* storage unavailable - non-fatal */
      }
    },
    {
      splitsKey: getTerminalSplitsStorageKey(id),
      splitsValue: JSON.stringify({
        splits: DESKTOP_SPLIT_TOOLS.map(cliToolId => ({ cliToolId, instanceId: cliToolId })),
        widths: DESKTOP_SPLIT_TOOLS.map(() => 1),
      }),
      cliKey: ACTIVE_CLI_TAB_PREFIX + id,
      instanceKey: ACTIVE_INSTANCE_PREFIX + id,
      tool: DESKTOP_SPLIT_TOOLS[0],
      clearKeys: [...disclosureKeys, HISTORY_VISIBLE_KEY, HISTORY_WIDTH_KEY],
      clearPrefixes: [ACTIVITY_BAR_PREFIX],
      guard: '__e2e_2131_seeded__',
    },
  );
}

/** Rect of one element inside one split pane, or null when it is not in the DOM. */
export async function rectInSplit(
  page: Page,
  splitIndex: number,
  testId: string,
): Promise<{ top: number; bottom: number; height: number; width: number } | null> {
  return page.evaluate(
    ({ idx, id }) => {
      const pane = document.querySelector(`[data-testid="terminal-split-pane-${idx}"]`);
      const el = pane?.querySelector(`[data-testid="${id}"]`);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, height: r.height, width: r.width };
    },
    { idx: splitIndex, id: testId },
  );
}
