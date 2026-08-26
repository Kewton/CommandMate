/**
 * E2E fixtures for the mobile opencode terminal tab (Issue #2106).
 *
 * Issue #2106 is a *layout* Issue: the claim under test is how many pixels the
 * quick-keys strip takes away from `TerminalDisplay` on a phone. That cannot be
 * settled in jsdom (no layout) nor from label widths on paper, so these helpers
 * put the real mobile detail page in a real browser at a real phone viewport,
 * with `/api/` mocked at the browser level exactly as
 * `terminal-split-helpers.ts` does for the PC split shell (Issue #735).
 *
 * No opencode process is involved. The strip's gate is `terminal.isRunning` +
 * `cliToolId === 'opencode'`, both of which are just fields on
 * `/current-output`, so a mocked payload renders the identical tree.
 */

import type { Page, Route } from '@playwright/test';

/** Worktree id scoped to the #2106 specs (must not collide with other specs). */
export const E2E_OPENCODE_WORKTREE = 'e2e-opencode-2106';

/** Mirror of ACTIVE_CLI_TAB_STORAGE_KEY_PREFIX in useWorktreeDetailController. */
const ACTIVE_CLI_TAB_PREFIX = 'activeCliTab-';
/** Mirror of ACTIVE_INSTANCE_STORAGE_KEY_PREFIX in useWorktreeDetailController. */
const ACTIVE_INSTANCE_PREFIX = 'activeInstanceId-';

/** Phone viewports measured by #2106. The second is the narrow-device case. */
export const PHONE_VIEWPORTS = [
  { width: 390, height: 730, label: '390x730' },
  { width: 360, height: 640, label: '360x640' },
] as const;

/** Enough rows that TerminalDisplay is never empty-placeholder height. */
const TERMINAL_OUTPUT = Array.from({ length: 120 }, (_, i) => `row ${i + 1}`).join('\n');

function buildWorktree(id: string, cliTool: string): Record<string, unknown> {
  return {
    id,
    name: `E2E ${id}`,
    path: `/tmp/${id}`,
    repositoryPath: `/tmp/${id}-repo`,
    repositoryName: 'e2e-repo',
    repositoryDisplayName: 'E2E Repo',
    description: 'E2E opencode mobile worktree',
    selectedAgents: [cliTool],
    // The roster the controller reads; a single primary instance keeps the CLI
    // tab strip unambiguous.
    agentInstances: [{ id: cliTool, cliTool, alias: cliTool, order: 0 }],
    cliToolId: cliTool,
    status: 'ready',
    sessionStatusByCli: {
      [cliTool]: { isRunning: true, isWaitingForResponse: false, isProcessing: false },
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

/** A live pane: running, not generating, no prompt, no agent session yet. */
function buildOutput(cliTool: string): Record<string, unknown> {
  return {
  isRunning: true,
  cliToolId: cliTool,
  isGenerating: false,
  isPromptWaiting: false,
  content: TERMINAL_OUTPUT,
  fullOutput: TERMINAL_OUTPUT,
  realtimeSnippet: 'row 120',
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

/** Serve deterministic `/api/` responses for the mobile opencode detail page. */
export async function mockOpencodeWorktreeApi(
  page: Page,
  id: string = E2E_OPENCODE_WORKTREE,
  cliTool: string = 'opencode',
): Promise<void> {
  const worktree = buildWorktree(id, cliTool);
  const output = buildOutput(cliTool);

  await page.route(
    url => url.pathname.startsWith('/api/'),
    async route => {
      const { pathname } = new URL(route.request().url());

      if (pathname === '/api/worktrees' || pathname.endsWith('/api/worktrees')) {
        return fulfillJson(route, [worktree]);
      }

      const detailMatch = pathname.match(/\/api\/worktrees\/([^/]+)(\/.*)?$/);
      if (detailMatch) {
        const sub = detailMatch[2] ?? '';
        if (sub === '') return fulfillJson(route, worktree);
        if (sub.startsWith('/messages')) return fulfillJson(route, []);
        if (sub.startsWith('/current-output')) return fulfillJson(route, output);
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
 * Pin the active instance to opencode before any app script runs.
 *
 * `useWorktreeDetailController` seeds `activeInstanceId` from localStorage in a
 * `useState` initialiser, so this must be an init script rather than a
 * post-navigation write.
 */
export async function seedOpencodeActiveInstance(
  page: Page,
  id: string = E2E_OPENCODE_WORKTREE,
  cliTool: string = 'opencode',
): Promise<void> {
  await page.addInitScript(
    ({ cliKey, instanceKey, tool }) => {
      try {
        localStorage.setItem(cliKey, tool);
        localStorage.setItem(instanceKey, tool);
      } catch {
        /* localStorage unavailable - non-fatal */
      }
    },
    { cliKey: ACTIVE_CLI_TAB_PREFIX + id, instanceKey: ACTIVE_INSTANCE_PREFIX + id, tool: cliTool },
  );
}

/** Clear the #2106 collapse preference so every test starts at the default. */
export async function clearQuickKeysPreference(page: Page, storageKey: string): Promise<void> {
  await page.addInitScript(key => {
    try {
      localStorage.removeItem(key);
    } catch {
      /* localStorage unavailable - non-fatal */
    }
  }, storageKey);
}

/** Rect of one element, or null when it is not in the DOM. */
export async function rectOf(page: Page, testId: string): Promise<{ top: number; bottom: number; height: number; width: number } | null> {
  return page.evaluate(id => {
    const el = document.querySelector(`[data-testid="${id}"]`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, height: r.height, width: r.width };
  }, testId);
}
