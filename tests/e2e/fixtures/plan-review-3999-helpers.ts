/**
 * E2E fixtures for Command Code's plan review reached from every surface
 * (Issue #3999).
 *
 * #3999 is a layout Issue: on a 412x892 phone the chat card's `Approve` sat at
 * 738px, below the 698px bottom of an `overflow-hidden` chat surface, with no
 * scrollable ancestor — present in the DOM, unreachable on screen. jsdom lays
 * nothing out, so only a real browser can say whether a control is reachable.
 * These helpers put the real worktree / `/sessions` pages in Chromium with
 * `/api/` mocked at the browser level, exactly as `opencode-mobile-helpers.ts`
 * (#2106) and `composer-height-helpers.ts` (#2598) do. No Command Code, no
 * tmux, no server state: the plan review is a frame served on
 * `/current-output`.
 *
 * ## The frame
 *
 * `tests/fixtures/command-code-plan-review-2763/plan-review-long-top.txt`, a
 * live 200x1000 capture of Command Code 1.58.0's REVIEW screen on a plan of
 * well over 77 rows — the shape the Issue was observed on (77 rows of plan
 * counted as selection-list rows, past #2326's 24-row threshold).
 *
 * ## The roster
 *
 * `command-code` first (the primary: `/sessions` tiles show it), then three
 * idle instances so the PC can be split into 3 panes and the #2421 2x2 grid.
 * Only `command-code` is in the plan review; the others are the in-frame
 * control (a send to them is never stopped).
 */

import fs from 'fs';
import path from 'path';
import type { Page, Route } from '@playwright/test';
import { getTerminalSplitsStorageKey } from '../../../src/config/terminal-split-config';

/** Worktree id scoped to the #3999 spec (must not collide with other specs). */
export const E2E_PLAN_REVIEW_WORKTREE = 'e2e-plan-review-3999';

/** The instance in the plan review, and the three idle ones beside it. */
export const PLAN_REVIEW_TOOL = 'command-code';
export const IDLE_TOOLS = ['claude', 'codex', 'copilot'] as const;
const ALL_TOOLS = [PLAN_REVIEW_TOOL, ...IDLE_TOOLS] as const;

/** Mirrors of the storage keys the pages read on mount. */
const ACTIVE_CLI_TAB_PREFIX = 'activeCliTab-';
const ACTIVE_INSTANCE_PREFIX = 'activeInstanceId-';
const ACTIVITY_BAR_PREFIX = 'commandmate.worktree.activeActivity-';
const HISTORY_VISIBLE_KEY = 'commandmate.worktree.historyVisible';
const HISTORY_WIDTH_KEY = 'commandmate.worktree.historyWidth';
/** Mirror of `SURFACE_MODE_STORAGE_KEY_PREFIX` (src/config/surface-mode-config.ts). */
const SURFACE_MODE_PREFIX = 'commandmate.worktree.surfaceMode-';
/** Mirror of SESSIONS_VIEW_MODE_STORAGE_KEY (src/hooks/useSessionsViewMode.ts). */
const SESSIONS_VIEW_MODE_KEY = 'mcbd-sessions-view-mode';
/** Mirror of SESSION_TILE_SURFACE_MODE_STORAGE_KEY_PREFIX. */
const TILE_SURFACE_MODE_PREFIX = 'commandmate.sessions.tileSurfaceMode-';
/** Mirror of the tile History toggle key (`useHistoryPaneState`'s tile scope). */
const TILE_HISTORY_VISIBLE_KEY = 'commandmate.sessions.tileHistoryVisible';
/** Mirror of DRAFT_STORAGE_KEY_PREFIX in MessageInput. */
const DRAFT_PREFIX = 'commandmate:draft-message:';

export type Surface = 'chat' | 'terminal';

/** The REVIEW frame, ANSI-free, as captured. */
export function planReviewFrame(): string {
  return fs.readFileSync(
    path.join(process.cwd(), 'tests/fixtures/command-code-plan-review-2763/plan-review-long-top.txt'),
    'utf8',
  );
}

/** An idle pane: running, at its prompt, nothing to answer. */
const IDLE_FRAME = Array.from({ length: 60 }, (_, i) => `row ${i + 1}`).join('\n');

function buildWorktree(id: string): Record<string, unknown> {
  return {
    id,
    name: `E2E ${id}`,
    path: `/tmp/${id}`,
    repositoryPath: `/tmp/${id}-repo`,
    repositoryName: 'e2e-repo',
    repositoryDisplayName: 'E2E Repo',
    description: 'E2E plan review worktree',
    selectedAgents: [...ALL_TOOLS],
    agentInstances: ALL_TOOLS.map((cliTool, order) => ({ id: cliTool, cliTool, alias: cliTool, order })),
    cliToolId: PLAN_REVIEW_TOOL,
    status: 'ready',
    sessionStatusByCli: Object.fromEntries(
      ALL_TOOLS.map(cliTool => [
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

function idleOutput(cliTool: string): Record<string, unknown> {
  return {
    isRunning: true,
    cliToolId: cliTool,
    sessionStatus: 'ready',
    sessionStatusReason: 'input_prompt',
    isGenerating: false,
    isPromptWaiting: false,
    content: IDLE_FRAME,
    fullOutput: IDLE_FRAME,
    realtimeSnippet: IDLE_FRAME,
    thinking: false,
    isSelectionListActive: false,
    isPagerActive: false,
    isDismissablePanelActive: false,
    isUnclassifiedActive: false,
    statusEvidence: 'positive',
  };
}

/** What the server answered on 2026-10-30: waiting, plan review, a selection list. */
function planReviewOutput(frame: string): Record<string, unknown> {
  return {
    isRunning: true,
    cliToolId: PLAN_REVIEW_TOOL,
    sessionStatus: 'waiting',
    sessionStatusReason: 'command_code_plan_review',
    isGenerating: false,
    isPromptWaiting: false,
    promptData: null,
    content: frame,
    fullOutput: frame,
    realtimeSnippet: frame.split('\n').slice(-100).join('\n'),
    thinking: false,
    isSelectionListActive: true,
    isPagerActive: false,
    isDismissablePanelActive: false,
    isUnclassifiedActive: false,
    statusEvidence: 'positive',
  };
}

function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

/** What the mock recorded, and the switches a test flips. */
export interface PlanReviewMock {
  /** Bodies POSTed to `/prompt-response`, in order. */
  promptResponses: Array<Record<string, unknown>>;
  /** `/send` requests, in order: the instance the composer targeted and the text. */
  sends: Array<{ cliToolId?: string; instanceId?: string; content?: string }>;
  /** Flip to false to end the review (the pane goes idle). */
  setPlanReview(active: boolean): void;
  /**
   * Make the next `/prompt-response` answers a refusal with this message
   * (`plan_review_busy`), or `null` to answer success again.
   */
  setRefusal(message: string | null): void;
}

/**
 * Serve the worktree detail page and (`listResponse`) `/sessions`.
 *
 * `/current-output` is keyed on `cliTool`, because each split polls for its own
 * tool (#728); the phone's controller poll asks for `command-code` too.
 */
export async function mockPlanReviewApi(
  page: Page,
  options: { listResponse?: boolean } = {},
): Promise<PlanReviewMock> {
  const worktree = buildWorktree(E2E_PLAN_REVIEW_WORKTREE);
  const frame = planReviewFrame();
  let planReview = true;
  let refusal: string | null = null;
  const mock: PlanReviewMock = {
    promptResponses: [],
    sends: [],
    setPlanReview(active) {
      planReview = active;
    },
    setRefusal(message) {
      refusal = message;
    },
  };

  await page.route(
    url => url.pathname.startsWith('/api/'),
    async route => {
      const request = route.request();
      const requestUrl = new URL(request.url());
      const { pathname } = requestUrl;

      if (pathname === '/api/worktrees' || pathname.endsWith('/api/worktrees')) {
        return fulfillJson(route, options.listResponse ? { worktrees: [worktree], repositories: [] } : [worktree]);
      }

      const detailMatch = pathname.match(/\/api\/worktrees\/([^/]+)(\/.*)?$/);
      if (detailMatch) {
        const sub = detailMatch[2] ?? '';
        if (sub === '') return fulfillJson(route, worktree);
        if (sub.startsWith('/current-output')) {
          const cliTool = requestUrl.searchParams.get('cliTool') ?? PLAN_REVIEW_TOOL;
          if (cliTool === PLAN_REVIEW_TOOL && planReview) return fulfillJson(route, planReviewOutput(frame));
          return fulfillJson(route, idleOutput(cliTool));
        }
        if (sub.startsWith('/prompt-response') && request.method() === 'POST') {
          mock.promptResponses.push(JSON.parse(request.postData() ?? '{}'));
          if (refusal !== null) {
            return fulfillJson(route, { success: false, reason: 'plan_review_busy', message: refusal }, 409);
          }
          return fulfillJson(route, { success: true });
        }
        if (sub.startsWith('/send') && request.method() === 'POST') {
          const body = JSON.parse(request.postData() ?? '{}');
          mock.sends.push({ cliToolId: body.cliToolId, instanceId: body.instanceId, content: body.content });
          return fulfillJson(route, {
            id: `msg-${mock.sends.length}`,
            worktreeId: E2E_PLAN_REVIEW_WORKTREE,
            role: 'user',
            content: body.content ?? '',
            timestamp: new Date().toISOString(),
            messageType: 'normal',
            cliToolId: body.cliToolId,
          });
        }
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
  return mock;
}

/**
 * Seed localStorage once per tab (the #735 sessionStorage guard): which
 * instance is active, how many PC splits and which surface each shows, the
 * phone's surface, and the `/sessions` tile mode.
 *
 * @param splits - PC split count (1–4; 4 is the #2421 grid). Split 0 is the
 *   plan review.
 * @param surface - The surface every split, the phone and the tile show.
 */
export async function seedPlanReviewLayout(
  page: Page,
  { splits = 1, surface }: { splits?: number; surface: Surface },
): Promise<void> {
  const id = E2E_PLAN_REVIEW_WORKTREE;
  const tools = ALL_TOOLS.slice(0, splits);
  const seed: Record<string, string> = {
    [getTerminalSplitsStorageKey(id)]: JSON.stringify({
      splits: tools.map(cliToolId => ({ cliToolId, instanceId: cliToolId })),
      widths: tools.map(() => 1),
    }),
    [ACTIVE_CLI_TAB_PREFIX + id]: PLAN_REVIEW_TOOL,
    [ACTIVE_INSTANCE_PREFIX + id]: PLAN_REVIEW_TOOL,
    [`${SURFACE_MODE_PREFIX}${id}-mobile`]: surface,
    [SESSIONS_VIEW_MODE_KEY]: 'tile',
    [TILE_SURFACE_MODE_PREFIX + id]: surface,
    [TILE_HISTORY_VISIBLE_KEY]: 'true',
  };
  for (let i = 0; i < 4; i += 1) seed[`${SURFACE_MODE_PREFIX}${id}-split-${i}`] = surface;

  await page.addInitScript(
    ({ entries, clearKeys, clearPrefixes, guard }) => {
      try {
        if (sessionStorage.getItem(guard)) return;
        sessionStorage.setItem(guard, '1');
        clearKeys.forEach((k: string) => localStorage.removeItem(k));
        Object.keys(localStorage)
          .filter(k => clearPrefixes.some((p: string) => k.startsWith(p)))
          .forEach(k => localStorage.removeItem(k));
        Object.entries(entries).forEach(([k, v]) => localStorage.setItem(k, v as string));
      } catch {
        /* storage unavailable - non-fatal */
      }
    },
    {
      entries: seed,
      clearKeys: [HISTORY_VISIBLE_KEY, HISTORY_WIDTH_KEY],
      clearPrefixes: [ACTIVITY_BAR_PREFIX, DRAFT_PREFIX],
      guard: '__e2e_3999_seeded__',
    },
  );
}

/** Where a control's centre lands: `true` when the topmost element there is the control. */
export async function isHitTarget(page: Page, testId: string, scope: string): Promise<boolean> {
  return page.evaluate(
    ({ id, root }) => {
      const container = document.querySelector(root) ?? document;
      const el = container.querySelector(`[data-testid="${id}"]`);
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return hit !== null && (hit === el || el.contains(hit));
    },
    { id: testId, root: scope },
  );
}
