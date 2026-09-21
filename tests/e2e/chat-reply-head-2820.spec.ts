/**
 * The chat transcript lands on the HEAD of the latest reply (Issue #2820).
 *
 * With the tool-activity toggle on, a codex reply row measured 2,508px against
 * a 728px viewport, and the transcript held the bottom of that row — so the
 * answer, which a reply row draws first, sat 2,500px above the reader. jsdom
 * measures nothing, so where the scroll actually stops is asserted here, in a
 * real browser, at a desktop and a phone viewport.
 *
 * `/api/` is mocked in the browser (the `opencode-mobile-helpers.ts` pattern);
 * no agent process is involved. The latest reply carries 160 tool calls, so
 * with the toggle on it is several viewports tall, and folded it is not.
 */

import { test, expect, type Page, type Route } from '@playwright/test';
import { separateTurnBody } from '@/lib/hooks/sources/turn-body';

const WORKTREE_ID = 'e2e-chat-reply-head-2820';
const TOOL = 'codex';
const SCROLL_CONTAINER = '[data-testid="chat-transcript-scroll-container"]';
const FAB = '[data-testid="chat-transcript-jump-fab"]';
/**
 * The tool-activity toggle: the transcript's own corner button, or — once
 * #2821 moves it on the phone — the surface pill's. Exactly one of the two is
 * on screen at each viewport either way, so the locator stays strict.
 */
const TOOL_TOGGLE =
  '[data-testid="chat-transcript-tool-activity-toggle"], [data-testid="mobile-chat-tool-activity-toggle"]';

/** "Within 16px of the top" — the Issue's criterion. */
const HEAD_TOLERANCE_PX = 16;

const VIEWPORTS = [
  { width: 1600, height: 1000, label: '1600x1000', path: `/worktrees/${WORKTREE_ID}?view=chat` },
  { width: 390, height: 730, label: '390x730', path: `/worktrees/${WORKTREE_ID}?pane=terminal&view=chat` },
] as const;

const T0 = Date.UTC(2026, 8, 21, 9, 0, 0);

function headText(id: string): string {
  return `HEAD-OF-${id}: the answer the reader came back for.`;
}

function row(id: string, role: 'user' | 'assistant', content: string, i: number): Record<string, unknown> {
  return {
    id,
    worktreeId: WORKTREE_ID,
    role,
    content,
    timestamp: new Date(T0 + i * 60_000).toISOString(),
    messageType: 'normal',
    archived: false,
    cliToolId: TOOL,
    instanceId: TOOL,
    requestId: role === 'user' ? `codex-prompt:${id}` : `codex-turn:${id}`,
  };
}

/** A codex reply: two short paragraphs, a Thinking block, and 160 tool calls. */
function tallReply(id: string, i: number): Record<string, unknown> {
  const body = separateTurnBody([
    { kind: 'prose', text: `${headText(id)}\n\nA second paragraph of the answer.` },
    { kind: 'reasoning', text: 'Checked the tests before answering.' },
    ...Array.from({ length: 160 }, (_, n) => ({
      kind: 'tool' as const,
      text: `- \`Bash\` — npx vitest run tests/unit/file-${n}.test.ts`,
    })),
  ]).body;
  return row(id, 'assistant', body, i);
}

/** 30 short turns, then the question and its tall reply. */
function baseMessages(): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (let n = 0; n < 30; n += 1) {
    rows.push(row(`u-${n}`, 'user', `question ${n}`, rows.length));
    rows.push(row(`a-${n}`, 'assistant', `short answer ${n}`, rows.length));
  }
  rows.push(row('q-1', 'user', 'the question', rows.length));
  rows.push(tallReply('reply-1', rows.length));
  return rows;
}

function buildWorktree(): Record<string, unknown> {
  return {
    id: WORKTREE_ID,
    name: `E2E ${WORKTREE_ID}`,
    path: `/tmp/${WORKTREE_ID}`,
    repositoryPath: `/tmp/${WORKTREE_ID}-repo`,
    repositoryName: 'e2e-repo',
    repositoryDisplayName: 'E2E Repo',
    description: 'E2E chat reply head worktree',
    selectedAgents: [TOOL],
    agentInstances: [{ id: TOOL, cliTool: TOOL, alias: TOOL, order: 0 }],
    cliToolId: TOOL,
    status: 'ready',
    sessionStatusByCli: {
      [TOOL]: { isRunning: true, isWaitingForResponse: false, isProcessing: false },
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

function buildOutput(sessionStatus: string): Record<string, unknown> {
  return {
    isRunning: true,
    cliToolId: TOOL,
    isGenerating: sessionStatus === 'running',
    sessionStatus,
    isPromptWaiting: false,
    content: 'codex pane',
    fullOutput: 'codex pane',
    realtimeSnippet: 'codex pane',
    thinking: false,
    isSelectionListActive: false,
    isPagerActive: false,
    isUnclassifiedActive: false,
  };
}

function fulfillJson(route: Route, body: unknown): Promise<void> {
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
}

/** What the mocked server answers right now; tests move it between phases. */
interface MockState {
  messages: Record<string, unknown>[];
  sessionStatus: string;
}

async function mockApi(page: Page, state: MockState): Promise<void> {
  const worktree = buildWorktree();
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const { pathname } = new URL(route.request().url());
      if (pathname.endsWith('/api/worktrees')) return fulfillJson(route, [worktree]);
      const detail = pathname.match(/\/api\/worktrees\/([^/]+)(\/.*)?$/);
      if (detail) {
        const sub = detail[2] ?? '';
        if (sub === '') return fulfillJson(route, worktree);
        if (sub.startsWith('/messages')) return fulfillJson(route, state.messages);
        if (sub.startsWith('/current-output')) return fulfillJson(route, buildOutput(state.sessionStatus));
        if (sub.startsWith('/tree')) return fulfillJson(route, { items: [] });
        if (sub.startsWith('/tasks')) return fulfillJson(route, { tasks: [] });
        if (sub.startsWith('/verify/runs')) return fulfillJson(route, { runs: [] });
        if (sub.startsWith('/slash-commands')) return fulfillJson(route, { groups: [] });
        if (/^\/(memos|execution-logs|schedules)/.test(sub)) return fulfillJson(route, []);
        return fulfillJson(route, {});
      }
      if (pathname.includes('/repositories') || pathname.includes('/tools')) return fulfillJson(route, []);
      return fulfillJson(route, {});
    },
  );
}

async function seedStorage(page: Page): Promise<void> {
  await page.addInitScript(
    ({ id, tool }) => {
      try {
        localStorage.setItem(`activeCliTab-${id}`, tool);
        localStorage.setItem(`activeInstanceId-${id}`, tool);
        localStorage.setItem('commandmate:chatShowToolActivity', 'true');
      } catch {
        /* storage unavailable - non-fatal */
      }
    },
    { id: WORKTREE_ID, tool: TOOL },
  );
}

interface Landing {
  /** Row top minus scroll-container top, or null when the row is not mounted. */
  rowTop: number | null;
  /** Whether the reply's first sentence is inside the scroll container's box. */
  headVisible: boolean;
  /** Distance from the bottom of the scroll range. */
  fromBottom: number;
}

function landing(page: Page, id: string): Promise<Landing> {
  return page.evaluate(
    ({ selector, messageId, text }) => {
      const container = document.querySelector<HTMLElement>(selector);
      if (!container) return { rowTop: null, headVisible: false, fromBottom: Number.NaN };
      const box = container.getBoundingClientRect();
      const fromBottom = container.scrollHeight - container.clientHeight - container.scrollTop;
      const rowEl = container.querySelector(`[data-row-message-id="${messageId}"]`);
      if (!rowEl) return { rowTop: null, headVisible: false, fromBottom };
      const para = Array.from(rowEl.querySelectorAll('p')).find((p) => p.textContent?.includes(text));
      const pr = para?.getBoundingClientRect();
      return {
        rowTop: rowEl.getBoundingClientRect().top - box.top,
        headVisible: !!pr && pr.top >= box.top && pr.bottom <= box.bottom,
        fromBottom,
      };
    },
    { selector: SCROLL_CONTAINER, messageId: id, text: headText(id) },
  );
}

/** Waits until the reply row's top is within the tolerance of the viewport top. */
async function expectAtHead(page: Page, id: string): Promise<void> {
  await expect
    .poll(async () => {
      const l = await landing(page, id);
      return l.rowTop !== null && l.rowTop >= -1 && l.rowTop <= HEAD_TOLERANCE_PX && l.headVisible;
    }, { timeout: 15_000 })
    .toBe(true);
  const l = await landing(page, id);
  // Not the bottom: the row is several viewports tall with its tool log open.
  expect(l.fromBottom).toBeGreaterThan(200);
  // eslint-disable-next-line no-console -- the measurement is the deliverable
  console.log(`LANDING-2820 head ${id} ${JSON.stringify(l)}`);
}

async function expectAtBottomWithHeadVisible(page: Page, id: string): Promise<void> {
  await expect
    .poll(async () => {
      const l = await landing(page, id);
      return l.fromBottom <= 2 && l.headVisible;
    }, { timeout: 15_000 })
    .toBe(true);
}

test.describe('Issue #2820: the chat transcript lands on the head of the latest reply', () => {
  test.describe.configure({ timeout: 180_000 });

  for (const vp of VIEWPORTS) {
    test(`open, toggle, FAB and a new reply at ${vp.label}`, async ({ page }) => {
      const state: MockState = { messages: baseMessages(), sessionStatus: 'idle' };
      await seedStorage(page);
      await mockApi(page, state);
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto(vp.path);
      await page.waitForSelector(SCROLL_CONTAINER, { timeout: 60_000 });

      // 1. Opening the transcript.
      await expectAtHead(page, 'reply-1');

      // 2. Folding the tool activity makes the row short: back to the bottom,
      //    with the answer still on screen. Unfolding it lands on the head.
      await page.locator(TOOL_TOGGLE).click();
      await expectAtBottomWithHeadVisible(page, 'reply-1');
      await page.locator(TOOL_TOGGLE).click();
      await expectAtHead(page, 'reply-1');

      // 3. Parked at the head is "at the latest": the FAB offers the top.
      await expect(page.locator(FAB)).toHaveAttribute('data-direction', 'top');

      // 4. The reader scrolls away; the FAB brings them back to the head.
      //    Scrolled only after the anchor run is over: while it runs, a scroll
      //    away is deliberately not read as "unpinned" (#2283), and the run
      //    ends by CHAT_TAIL_ANCHOR_MAX_MS (600ms) at the latest.
      await page.waitForTimeout(700);
      await page.evaluate((selector) => {
        const el = document.querySelector<HTMLElement>(selector);
        if (el) el.scrollTop = 0;
      }, SCROLL_CONTAINER);
      await expect(page.locator(FAB)).toHaveAttribute('data-direction', 'latest');
      await page.locator(FAB).click();
      await expectAtHead(page, 'reply-1');

      // 5. A new turn: the question arrives while the agent is running (the
      //    transcript follows the bottom), then the reply lands and the turn
      //    ends — the transcript moves to the NEW reply's head.
      state.messages = [...baseMessages(), row('q-2', 'user', 'the next question', 62)];
      state.sessionStatus = 'running';
      await expect(page.locator('[data-row-message-id="q-2"]')).toBeAttached({ timeout: 30_000 });
      await expect
        .poll(async () => (await landing(page, 'q-2')).fromBottom, { timeout: 15_000 })
        .toBeLessThanOrEqual(2);

      state.messages = [...state.messages, tallReply('reply-2', 63)];
      state.sessionStatus = 'idle';
      await expect(page.locator('[data-row-message-id="reply-2"]')).toBeAttached({ timeout: 30_000 });
      await expectAtHead(page, 'reply-2');
    });
  }
});
