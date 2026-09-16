/**
 * E2E fixtures for the permission-mode control (Issue #2592).
 *
 * Self-contained rather than an extension of `opencode-mobile-helpers.ts` /
 * `terminal-split-helpers.ts`, deliberately. Those two are the harnesses #2106,
 * #2131 and #735 measure their own pixel claims against, and this Issue's
 * fixture has to differ from both in exactly the fields those specs are
 * sensitive to — a running claude session at `sessionStatus: 'ready'` with a
 * real mode footer in `fullOutput`. Editing a shared fixture to suit one spec is
 * how another spec's floor moves without anybody noticing.
 *
 * No agent process is involved. The control's gate is five fields on
 * `/current-output`, so a mocked payload renders the identical tree.
 */

import fs from 'fs';
import path from 'path';
import type { Page, Route } from '@playwright/test';

/** Worktree id scoped to the #2592 specs (must not collide with other specs). */
export const E2E_AGENT_MODE_WORKTREE = 'e2e-agent-mode-2592';

/** Mirror of ACTIVE_CLI_TAB_STORAGE_KEY_PREFIX in useWorktreeDetailController. */
const ACTIVE_CLI_TAB_PREFIX = 'activeCliTab-';
/** Mirror of ACTIVE_INSTANCE_STORAGE_KEY_PREFIX in useWorktreeDetailController. */
const ACTIVE_INSTANCE_PREFIX = 'activeInstanceId-';

/**
 * The phone viewports #2106 measured, reused verbatim.
 *
 * The second one is the narrow-device case where #2106 found the pre-fix strip
 * had taken the terminal to **0px**. This Issue's control is in the composer's
 * existing action row and should move that number by nothing at all, which is
 * only checkable at the viewport the number was measured at.
 */
export const PHONE_VIEWPORTS = [
  // eslint-disable-next-line no-restricted-syntax -- i18n(#1271): `name` is a
  // viewport geometry used in the test title, not user-facing prose.
  { width: 390, height: 730, name: '390x730' },
  { width: 360, height: 640, name: '360x640' },
] as const;

/** A desktop viewport wide enough for the split shell's PC layout. */
export const DESKTOP_VIEWPORT = { width: 1440, height: 900 } as const;

/**
 * One of this Issue's checked-in mode frames, read off disk.
 *
 * The real captures, ANSI and all — the same bytes the unit suite reads — so the
 * browser is asked to render the mode from the same evidence the server reads it
 * from. See `tests/fixtures/agent-mode-2592/README.md`.
 */
export function modeFrame(name: string): string {
  return fs.readFileSync(
    path.join(process.cwd(), 'tests/fixtures/agent-mode-2592', `${name}.txt`),
    'utf8',
  );
}

function buildWorktree(id: string, cliTool: string): Record<string, unknown> {
  return {
    id,
    name: `E2E ${id}`,
    path: `/tmp/${id}`,
    repositoryPath: `/tmp/${id}-repo`,
    repositoryName: 'e2e-repo',
    repositoryDisplayName: 'E2E Repo',
    description: 'E2E agent-mode worktree',
    selectedAgents: [cliTool],
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

/** What `/current-output` serves. Overridable so a spec can put a dialog up. */
export interface AgentModeOutputFixture {
  cliTool?: string;
  /** Frame name under `tests/fixtures/agent-mode-2592/`. */
  frame?: string;
  /** The merged verdict. `'ready'` is the only value that enables the button. */
  sessionStatus?: string;
  isPromptWaiting?: boolean;
  isSelectionListActive?: boolean;
  isDismissablePanelActive?: boolean;
  isUnclassifiedActive?: boolean;
  /**
   * What the server publishes as `agentMode`.
   *
   * The PC split derives its own from the frame; the phone's composer reads this
   * field (see `useWorktreeDetailController`). A spec that wants the two to be
   * consistent passes a frame and lets this default to the matching mode.
   */
  agentMode?: string;
}

function buildOutput(fixture: AgentModeOutputFixture): Record<string, unknown> {
  const cliTool = fixture.cliTool ?? 'claude';
  const output = modeFrame(fixture.frame ?? 'claude-plan');
  return {
    isRunning: true,
    cliToolId: cliTool,
    sessionStatus: fixture.sessionStatus ?? 'ready',
    sessionStatusReason: 'input_prompt',
    isGenerating: false,
    isPromptWaiting: fixture.isPromptWaiting ?? false,
    content: output,
    fullOutput: output,
    realtimeSnippet: output.split('\n').slice(-100).join('\n'),
    thinking: false,
    isSelectionListActive: fixture.isSelectionListActive ?? false,
    isPagerActive: false,
    isDismissablePanelActive: fixture.isDismissablePanelActive ?? false,
    isUnclassifiedActive: fixture.isUnclassifiedActive ?? false,
    statusEvidence: 'positive',
    agentMode: fixture.agentMode ?? 'plan',
  };
}

function fulfillJson(route: Route, body: unknown): Promise<void> {
  return route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

/** Every `/api/worktrees/:id/special-keys` body this page has POSTed. */
export type SpecialKeyLog = Array<Record<string, unknown>>;

/**
 * Serve deterministic `/api/` responses for the worktree detail page, and record
 * every special-keys POST.
 *
 * The log is what makes "the button is disabled" checkable as "no key left the
 * browser", which is the property the gate actually has to have.
 */
export async function mockAgentModeApi(
  page: Page,
  fixture: AgentModeOutputFixture = {},
  id: string = E2E_AGENT_MODE_WORKTREE,
): Promise<SpecialKeyLog> {
  const cliTool = fixture.cliTool ?? 'claude';
  const worktree = buildWorktree(id, cliTool);
  const output = buildOutput(fixture);
  const specialKeys: SpecialKeyLog = [];

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
        if (sub.startsWith('/special-keys')) {
          try {
            specialKeys.push(JSON.parse(route.request().postData() ?? '{}'));
          } catch {
            specialKeys.push({});
          }
          return fulfillJson(route, { success: true });
        }
        if (sub.startsWith('/messages')) return fulfillJson(route, []);
        if (sub.startsWith('/current-output')) return fulfillJson(route, output);
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

  return specialKeys;
}

/**
 * Pin the active CLI tab / instance before any app script runs.
 *
 * `useWorktreeDetailController` seeds both from localStorage in a `useState`
 * initialiser, so this must be an init script rather than a post-navigation
 * write.
 */
export async function seedActiveInstance(
  page: Page,
  cliTool = 'claude',
  id: string = E2E_AGENT_MODE_WORKTREE,
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

/** Rect of one element, or null when it is not in the DOM. */
export async function rectOf(
  page: Page,
  testId: string,
): Promise<{ top: number; bottom: number; height: number; width: number } | null> {
  return page.evaluate(id => {
    const el = document.querySelector(`[data-testid="${id}"]`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, height: r.height, width: r.width };
  }, testId);
}
