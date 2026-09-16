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

/**
 * The widest portrait phone in current use (Issue #2597).
 *
 * Its composer row measures 398px, which is the phone side of the key
 * notation's 400px container threshold: below it, the notation stays hidden on
 * every portrait phone, exactly as `hidden sm:inline` had it.
 */
export const WIDEST_PORTRAIT_PHONE = { width: 440, height: 956 } as const;

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

// ---------------------------------------------------------------------------
// Issue #2597: the control in a PC split pane that is narrower than its row
// ---------------------------------------------------------------------------

/** Worktree id scoped to the #2597 split specs (must not collide with #2592's). */
export const E2E_AGENT_MODE_SPLIT_WORKTREE = 'e2e-agent-mode-2597';

/**
 * The three splits, in order, and the frame each one serves.
 *
 * All three tools declare a mode cycle, so every pane draws the control — the
 * comparison #2597 asks for is one control at two pane widths on one screen,
 * which needs the same component in all of them. claude carries a chip only
 * (`auto`, the chip the Issue saw squeezed to `au`); codex carries a chip AND
 * the caution (`A`); copilot is the third distinct instance
 * `useTerminalSplits` needs and draws a chip only.
 */
export const AGENT_MODE_SPLITS = [
  { cliTool: 'claude', frame: 'claude-auto', agentMode: 'auto' },
  { cliTool: 'codex', frame: 'codex-plan', agentMode: 'plan' },
  { cliTool: 'copilot', frame: 'copilot-plan', agentMode: 'plan' },
] as const;

/** Mirror of the activity-bar key prefix (cleared so every run starts at the defaults). */
const ACTIVITY_BAR_PREFIX = 'commandmate.worktree.activeActivity-';
const HISTORY_VISIBLE_KEY = 'commandmate.worktree.historyVisible';
const HISTORY_WIDTH_KEY = 'commandmate.worktree.historyWidth';

/** Mirror of TERMINAL_SPLITS_STORAGE_KEY_PREFIX in src/config/terminal-split-config.ts. */
const TERMINAL_SPLITS_PREFIX = 'commandmate:terminalSplits:';

function buildSplitWorktree(id: string): Record<string, unknown> {
  const tools = AGENT_MODE_SPLITS.map(split => split.cliTool);
  return {
    ...buildWorktree(id, tools[0]),
    selectedAgents: [...tools],
    agentInstances: tools.map((cliTool, order) => ({ id: cliTool, cliTool, alias: cliTool, order })),
    sessionStatusByCli: Object.fromEntries(
      tools.map(cliTool => [
        cliTool,
        { isRunning: true, isWaitingForResponse: false, isProcessing: false },
      ]),
    ),
  };
}

/**
 * Serve the three-split detail page.
 *
 * `/current-output` is keyed on the `cliTool` query parameter, because each
 * split polls for its OWN tool (Issue #728): one canned payload would make all
 * three panes claim the same tool, and the codex caution would never be drawn.
 */
export async function mockAgentModeSplitApi(
  page: Page,
  id: string = E2E_AGENT_MODE_SPLIT_WORKTREE,
): Promise<void> {
  const worktree = buildSplitWorktree(id);
  const outputs = new Map<string, Record<string, unknown>>(
    AGENT_MODE_SPLITS.map(split => [
      split.cliTool,
      buildOutput({ cliTool: split.cliTool, frame: split.frame, agentMode: split.agentMode }),
    ]),
  );
  const fallback = outputs.get(AGENT_MODE_SPLITS[0].cliTool);

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
        if (sub.startsWith('/current-output')) {
          const cliTool = requestUrl.searchParams.get('cliTool') ?? '';
          return fulfillJson(route, outputs.get(cliTool) ?? fallback);
        }
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
 * Seed three splits with the given width shares, before any app script runs.
 *
 * `widths` are the persisted unitless shares (`TerminalSplitConfig.widths`), so
 * `[2, 1, 1]` is one pane twice as wide as the other two — on ONE viewport,
 * which is the whole point: the key notation must follow the pane, and only
 * panes of different widths on the same screen can show that it does.
 *
 * Guarded by a sessionStorage flag like `seedDesktopOpencodeSplits`, so a
 * reload observes what the app wrote rather than the seed.
 */
export async function seedAgentModeSplits(
  page: Page,
  widths: readonly number[],
  id: string = E2E_AGENT_MODE_SPLIT_WORKTREE,
): Promise<void> {
  const first = AGENT_MODE_SPLITS[0].cliTool;
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
      splitsKey: TERMINAL_SPLITS_PREFIX + id,
      splitsValue: JSON.stringify({
        splits: AGENT_MODE_SPLITS.map(split => ({
          cliToolId: split.cliTool,
          instanceId: split.cliTool,
        })),
        widths: [...widths],
      }),
      cliKey: ACTIVE_CLI_TAB_PREFIX + id,
      instanceKey: ACTIVE_INSTANCE_PREFIX + id,
      tool: first,
      clearKeys: [HISTORY_VISIBLE_KEY, HISTORY_WIDTH_KEY],
      clearPrefixes: [ACTIVITY_BAR_PREFIX],
      guard: '__e2e_2597_seeded__',
    },
  );
}

/** A box in viewport coordinates, with all four edges. */
export interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

/**
 * The rect of one testid inside one split pane, or null when it is absent.
 *
 * `visible` is the part of that rect that is actually painted: the rect
 * intersected with every ancestor (up to the pane) that clips its overflow.
 * `getBoundingClientRect` ignores clipping, so a pill that has been clipped to
 * nothing would still report its full width there — the painted box is what a
 * claim about "overlapping" has to be about.
 */
export async function boxesInSplit(
  page: Page,
  splitIndex: number,
  testIds: readonly string[],
): Promise<Record<string, { box: Box; visible: Box | null } | null>> {
  return page.evaluate(
    ({ idx, ids }) => {
      const toBox = (r: { left: number; right: number; top: number; bottom: number }) => ({
        left: r.left,
        right: r.right,
        top: r.top,
        bottom: r.bottom,
        width: Math.max(0, r.right - r.left),
        height: Math.max(0, r.bottom - r.top),
      });
      const pane = document.querySelector(`[data-testid="terminal-split-pane-${idx}"]`);
      const out: Record<string, unknown> = {};
      for (const id of ids) {
        const el = pane?.querySelector(`[data-testid="${id}"]`);
        if (!el) {
          out[id] = null;
          continue;
        }
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
        const painted = clip.right > clip.left && clip.bottom > clip.top ? toBox(clip) : null;
        out[id] = { box: toBox(r), visible: painted };
      }
      return out as Record<string, { box: Box; visible: Box | null } | null>;
    },
    { idx: splitIndex, ids: [...testIds] },
  );
}

/** Whether two boxes share any area (touching edges do not count). */
export function boxesIntersect(a: Box, b: Box): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/** Whether `inner` lies within `outer`, allowing sub-pixel rounding. */
export function boxContains(outer: Box, inner: Box, tolerance = 0.5): boolean {
  return (
    inner.left >= outer.left - tolerance &&
    inner.right <= outer.right + tolerance &&
    inner.top >= outer.top - tolerance &&
    inner.bottom <= outer.bottom + tolerance
  );
}
