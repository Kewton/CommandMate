/**
 * Issue #1786: the list API composes the structured layer in.
 *
 * Until this Issue `/api/worktrees` published `detectSessionStatus()`'s verdict
 * alone, so the sidebar, Home, Sessions, Review and the command palette were all
 * blind to a dialog only the agent's own hooks could see — the case Issue #1725
 * built the structured layer for. These cases drive the composed payload:
 * whether it waits, what kind of wait it is, when the wait began, and the
 * `awaiting_instruction` flag that has no `SessionStatus` of its own.
 *
 * The scaffolding mirrors `worktree-status-helper-status-mapping.test.ts` (one
 * CLI tool, a stubbed capture) so the only thing varying between cases is the
 * detector verdict and the structured events.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CLIToolType, AgentInstance } from '@/lib/cli-tools/types';
import type { SessionStatus } from '@/lib/detection/status-detector';

vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({
      getTool: (cliToolId: string) => ({
        getSessionName: (worktreeId: string, instanceId?: string) =>
          instanceId && instanceId !== cliToolId
            ? `${cliToolId}-${worktreeId}-${instanceId}`
            : `${cliToolId}-${worktreeId}`,
        name: cliToolId,
      }),
    }),
  },
}));

vi.mock('@/lib/cli-tools/types', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/cli-tools/types')>();
  return {
    ...original,
    CLI_TOOL_IDS: ['claude'] as readonly CLIToolType[],
  };
});

vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutput: vi.fn().mockResolvedValue('$ '),
}));

// Only `detectSessionStatus` is stubbed: the waiting taxonomy reads the real
// SELECTION_LIST_REASONS, and a factory mock that dropped it would hand the
// helper `undefined` at the call site.
vi.mock('@/lib/detection/status-detector', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/detection/status-detector')>()),
  detectSessionStatus: vi.fn(),
}));

vi.mock('@/lib/session/claude-session', () => ({
  isSessionHealthy: vi.fn().mockResolvedValue({ healthy: true }),
}));

vi.mock('@/lib/cli-tools/opencode', () => ({ OPENCODE_PANE_HEIGHT: 200 }));
vi.mock('@/lib/cli-tools/gemini', () => ({ GEMINI_PANE_HEIGHT: 200 }));

vi.mock('@/lib/polling/auto-yes-manager', () => ({
  getLastServerResponseTimestamp: vi.fn().mockReturnValue(null),
  buildCompositeKey: vi.fn((worktreeId: string, cliToolId: string) => `${worktreeId}:${cliToolId}`),
}));

import { detectWorktreeSessionStatus } from '@/lib/session/worktree-status-helper';
import { detectSessionStatus, STATUS_REASON } from '@/lib/detection/status-detector';
import { captureSessionOutput } from '@/lib/session/cli-session';
import {
  clearAgentStopEvents,
  getStructuredPromptWaiting,
  recordAgentEvent,
} from '@/lib/session/agent-event-state';
import { resolvePromptWaiting } from '@/lib/session/prompt-waiting-composition';
import { deriveCliStatus } from '@/lib/session/status-mapping';
import type { Worktree } from '@/types/models';
import {
  clearWaitingEpisodes,
  clearWaitingTransitionListeners,
  onWaitingTransition,
  type WaitingTransition,
} from '@/lib/session/waiting-episode-state';

const WORKTREE_ID = 'wt-1';
const SESSION_NAMES = new Set(['claude-wt-1']);

const mockDb = {} as ReturnType<typeof import('@/lib/db/db-instance').getDbInstance>;
const mockGetMessages = vi.fn().mockReturnValue([]);
const mockMarkPending = vi.fn();
const mockGetAgentInstances = vi.fn(() => [] as AgentInstance[]);

function mockScraper(
  status: SessionStatus,
  reason: string = STATUS_REASON.INPUT_PROMPT,
  hasActivePrompt = false,
): void {
  vi.mocked(detectSessionStatus).mockReturnValue({
    status,
    confidence: 'high',
    reason,
    hasActivePrompt,
    // Issue #1927: `evidence` became a required field of the detector's result.
    evidence: 'positive',
    promptDetection: { isPrompt: hasActivePrompt, cleanContent: '' },
  });
}

async function poll(sessionNames: Set<string> = SESSION_NAMES) {
  const result = await detectWorktreeSessionStatus(
    WORKTREE_ID,
    sessionNames,
    mockDb,
    mockGetMessages,
    mockMarkPending,
    mockGetAgentInstances,
  );
  return result.sessionStatusByInstance.claude;
}

/** The dialog only the agent can see: `Notification(permission_prompt)`. */
function openStructuredDialog(at: number): void {
  recordAgentEvent(WORKTREE_ID, 'claude', 'claude', {
    event: 'notification',
    at,
    detail: 'permission_prompt',
    sessionId: 'sess-1',
    message: 'Claude needs your permission to use Bash',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetMessages.mockReturnValue([]);
  mockGetAgentInstances.mockReturnValue([]);
  vi.mocked(captureSessionOutput).mockResolvedValue('$ ');
  // fileParallelism: false — both stores are process-wide.
  clearAgentStopEvents();
  clearWaitingEpisodes();
  clearWaitingTransitionListeners();
});

describe('the structured layer reaches the list API (Issue #1786)', () => {
  it('waits when the scraper says `ready` and the agent reported an open dialog', async () => {
    // The defect, stated as a test: before #1786 this payload said `false`
    // because nothing but `detectSessionStatus` was ever consulted here.
    const at = Date.now() - 2_000;
    mockScraper('ready');
    openStructuredDialog(at);

    const status = await poll();

    expect(status?.isWaitingForResponse).toBe(true);
    expect(status?.waitingKind).toBe('unclassified');
    expect(status?.waitingSince).toBe(at);
  });

  it('folds the structured wait into the per-CLI aggregate and the worktree flag', async () => {
    mockScraper('ready');
    openStructuredDialog(Date.now());

    const result = await detectWorktreeSessionStatus(
      WORKTREE_ID, SESSION_NAMES, mockDb, mockGetMessages, mockMarkPending, mockGetAgentInstances,
    );

    expect(result.sessionStatusByCli.claude?.isWaitingForResponse).toBe(true);
    expect(result.sessionStatusByCli.claude?.waitingKind).toBe('unclassified');
    expect(result.isWaitingForResponse).toBe(true);
  });

  it('does not consult the structured layer for a session that is not running', async () => {
    mockScraper('ready');
    openStructuredDialog(Date.now());

    const status = await poll(new Set());

    expect(status?.isRunning).toBe(false);
    expect(status?.isWaitingForResponse).toBe(false);
    expect(status?.waitingKind).toBeNull();
    expect(status?.waitingSince).toBeNull();
  });

  it('issues no capture beyond the one the status probe already made', async () => {
    mockScraper('ready');
    openStructuredDialog(Date.now());

    await poll();

    // The structured state is an in-memory read; composing it must not cost a
    // second tmux round-trip on a route that runs for every worktree.
    expect(captureSessionOutput).toHaveBeenCalledTimes(1);
  });
});

describe('the OR widens the scraper’s verdict and never narrows it (Issue #1786)', () => {
  // The Issue's text proposed `isWaitingForResponse = resolution.waiting`.
  // Measured against the code, that field is `hasActivePrompt || structured`,
  // while this flag is `status === 'waiting'` — and a selection list reports
  // `waiting` with `hasActivePrompt: false`. Assigning it verbatim would have
  // turned every selection list in the sidebar green. These cases are the guard.
  it.each([
    [STATUS_REASON.CLAUDE_SELECTION_LIST, 'menu'],
    [STATUS_REASON.CODEX_SELECTION_LIST, 'menu'],
    [STATUS_REASON.CODEX_PAGER, 'menu'],
  ])('keeps a %s frame waiting, as kind %s', async (reason, kind) => {
    mockScraper('waiting', reason);

    const status = await poll();

    expect(status?.isWaitingForResponse).toBe(true);
    expect(status?.waitingKind).toBe(kind);
  });

  it('classifies an answerable prompt as `prompt`', async () => {
    mockScraper('waiting', STATUS_REASON.PROMPT_DETECTED, true);

    const status = await poll();

    expect(status?.isWaitingForResponse).toBe(true);
    expect(status?.waitingKind).toBe('prompt');
  });

  it('leaves a session nobody is waiting on alone', async () => {
    mockScraper('running', STATUS_REASON.THINKING_INDICATOR);

    const status = await poll();

    expect(status).toMatchObject({
      isRunning: true,
      isWaitingForResponse: false,
      isProcessing: true,
      waitingKind: null,
      waitingSince: null,
      awaitingInstruction: false,
    });
  });
});

describe('waitingSince (Issue #1786)', () => {
  it('is fixed at the structured episode’s start and does not move while polling', async () => {
    const at = Date.now() - 30_000;
    mockScraper('ready');
    openStructuredDialog(at);

    expect((await poll())?.waitingSince).toBe(at);
    expect((await poll())?.waitingSince).toBe(at);
    expect((await poll())?.waitingSince).toBe(at);
  });

  it('returns to null once the wait is over', async () => {
    mockScraper('waiting', STATUS_REASON.CLAUDE_SELECTION_LIST);
    const waiting = await poll();
    expect(waiting?.waitingSince).toEqual(expect.any(Number));

    mockScraper('ready');
    const released = await poll();

    expect(released?.isWaitingForResponse).toBe(false);
    expect(released?.waitingKind).toBeNull();
    expect(released?.waitingSince).toBeNull();
  });

  it('reports the edge to #1788 / #1790 subscribers exactly once per crossing', async () => {
    const seen: WaitingTransition[] = [];
    onWaitingTransition((t) => seen.push(t));

    mockScraper('waiting', STATUS_REASON.CLAUDE_SELECTION_LIST);
    await poll();
    await poll();
    mockScraper('ready');
    await poll();
    await poll();

    expect(seen.map((t) => t.waiting)).toEqual([true, false]);
    expect(seen[0]).toMatchObject({ worktreeId: WORKTREE_ID, cliToolId: 'claude', kind: 'menu' });
  });
});

describe('the list API reads the structured record without writing to it (Issue #1786)', () => {
  it('does not corroborate, however many times it polls a blocking frame', async () => {
    // The choice this Issue made: the list path detects on a smaller capture
    // window than the detail path, and `blocksSend` reads the same record — a
    // read endpoint polled by every open tab must not be able to retire it.
    openStructuredDialog(Date.now());
    mockScraper('waiting', STATUS_REASON.CLAUDE_SELECTION_LIST);

    await poll();
    await poll();

    expect(getStructuredPromptWaiting(WORKTREE_ID, 'claude', 'claude')).toMatchObject({
      scraperCorroborated: false,
    });
  });

  it('publishes the structured release once the detail path has run the rule (#1160 shape)', async () => {
    // The #1160 failure is a wait that never ends: something keeps reporting
    // `waiting` after the human answered and the dot stays orange forever. The
    // release rule is what stops the structured layer from becoming a second
    // source of exactly that, and this is the whole path — arm it on a frame the
    // scraper saw, fire it on the frame that cleared, and watch the list API
    // follow.
    const at = Date.now();
    openStructuredDialog(at);

    mockScraper('waiting', STATUS_REASON.CLAUDE_SELECTION_LIST);
    expect((await poll())?.isWaitingForResponse).toBe(true);

    // The detail path sees the same blocking frame: the record is now armed.
    resolvePromptWaiting({
      worktreeId: WORKTREE_ID,
      cliToolId: 'claude',
      instanceId: 'claude',
      scraper: { status: 'waiting', reason: STATUS_REASON.CLAUDE_SELECTION_LIST, hasActivePrompt: false },
    });
    expect(getStructuredPromptWaiting(WORKTREE_ID, 'claude', 'claude')).toMatchObject({
      scraperCorroborated: true,
    });

    // …and then sees it cleared, which releases the record.
    resolvePromptWaiting({
      worktreeId: WORKTREE_ID,
      cliToolId: 'claude',
      instanceId: 'claude',
      scraper: { status: 'ready', reason: STATUS_REASON.INPUT_PROMPT, hasActivePrompt: false },
    });
    expect(getStructuredPromptWaiting(WORKTREE_ID, 'claude', 'claude')).toBeNull();

    mockScraper('ready');
    const released = await poll();

    expect(released?.isWaitingForResponse).toBe(false);
    expect(released?.waitingSince).toBeNull();
  });

  it('follows the structured layer’s own release without any scraper involvement', async () => {
    // `post_tool_use` is "the tool call the dialog was gating has finished", so
    // somebody answered it. No scraper frame is needed for this one.
    openStructuredDialog(Date.now());
    mockScraper('ready');
    expect((await poll())?.isWaitingForResponse).toBe(true);

    recordAgentEvent(WORKTREE_ID, 'claude', 'claude', {
      event: 'post_tool_use',
      at: Date.now(),
      detail: 'Bash',
      sessionId: 'sess-1',
    });

    expect((await poll())?.isWaitingForResponse).toBe(false);
  });
});

describe('backward compatibility of the added fields (Issue #1786)', () => {
  it('accepts a payload written before this Issue existed', () => {
    // Every field #1786 adds is optional on the client type, so a fixture, a
    // cached response or an older server that knows none of them still
    // type-checks and still resolves to the same dot.
    const legacy: NonNullable<Worktree['sessionStatusByInstance']> = {
      claude: { isRunning: true, isWaitingForResponse: true, isProcessing: false },
    };

    expect(legacy.claude?.waitingKind).toBeUndefined();
    expect(legacy.claude?.waitingSince).toBeUndefined();
    expect(legacy.claude?.awaitingInstruction).toBeUndefined();
    expect(deriveCliStatus(legacy.claude)).toBe('waiting');
  });

  it('resolves the same dot for a payload that carries them', async () => {
    mockScraper('waiting', STATUS_REASON.CLAUDE_SELECTION_LIST);
    const status = await poll();

    // The status vocabulary is unchanged: the new fields describe the wait, they
    // do not redefine it.
    expect(deriveCliStatus(status)).toBe('waiting');
  });
});

describe('awaitingInstruction on the list API (Issue #1786)', () => {
  it('is true after Notification(idle_prompt) and false once a prompt is submitted', async () => {
    mockScraper('ready');
    recordAgentEvent(WORKTREE_ID, 'claude', 'claude', {
      event: 'notification',
      at: Date.now(),
      detail: 'idle_prompt',
      sessionId: 'sess-1',
      message: 'Claude is waiting for your input',
    });

    const idle = await poll();
    expect(idle?.awaitingInstruction).toBe(true);
    // The four SessionStatus values are untouched: `idle_prompt` is still
    // `ready`, so nothing that reads the boolean triple changes behaviour.
    expect(idle?.isWaitingForResponse).toBe(false);
    expect(idle?.isProcessing).toBe(false);

    recordAgentEvent(WORKTREE_ID, 'claude', 'claude', {
      event: 'user_prompt_submit',
      at: Date.now(),
      detail: null,
      sessionId: 'sess-1',
    });

    expect((await poll())?.awaitingInstruction).toBe(false);
  });

  it('is false for a session that is not running', async () => {
    mockScraper('ready');
    recordAgentEvent(WORKTREE_ID, 'claude', 'claude', {
      event: 'notification',
      at: Date.now(),
      detail: 'idle_prompt',
      sessionId: 'sess-1',
    });

    expect((await poll(new Set()))?.awaitingInstruction).toBe(false);
  });
});
