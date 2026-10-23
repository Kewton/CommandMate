/**
 * Issue #3798 (PR 1b): the status probe as an observer of the waiting episodes
 * (`docs/design/issue-3798-waiting-episode.md` §2.4 tables O-1 / O-2, I5, I6,
 * §2.5 "status-helper").
 *
 * The probe reads the frame the way the other two observers do
 * (`waiting-screen-reading`), fixes its start before its first `await` — or
 * takes the one the route fixed before `listSessions()` — and is refused when
 * the episode moved meanwhile or the frame predates the close of the
 * confirmation it shows.
 *
 * Scaffolding as in `worktree-status-helper-waiting-1786.test.ts`: a stubbed
 * capture and detector, the real episode store and turn model.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CLIToolType, AgentInstance } from '@/lib/cli-tools/types';
import type { SessionStatus } from '@/lib/detection/status-detector';
import type { PromptData } from '@/types/models';

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
    CLI_TOOL_IDS: ['claude', 'copilot', 'opencode'] as readonly CLIToolType[],
  };
});

vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutput: vi.fn().mockResolvedValue('$ '),
  getCaptureFetchStartedAt: vi.fn().mockReturnValue(null),
}));

vi.mock('@/lib/detection/status-detector', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/detection/status-detector')>()),
  detectSessionStatus: vi.fn(),
}));

vi.mock('@/lib/cli-tools/session-liveness', () => ({
  probeToolSessionLiveness: vi.fn().mockResolvedValue({ alive: true }),
}));

vi.mock('@/lib/cli-tools/opencode', () => ({ OPENCODE_PANE_HEIGHT: 200 }));
vi.mock('@/lib/cli-tools/gemini', () => ({ GEMINI_PANE_HEIGHT: 200 }));

vi.mock('@/lib/polling/auto-yes-manager', () => ({
  getLastServerResponseTimestamp: vi.fn().mockReturnValue(null),
  buildCompositeKey: vi.fn((worktreeId: string, cliToolId: string) => `${worktreeId}:${cliToolId}`),
}));

import { detectWorktreeSessionStatus } from '@/lib/session/worktree-status-helper';
import { detectSessionStatus, STATUS_REASON } from '@/lib/detection/status-detector';
import { captureSessionOutput, getCaptureFetchStartedAt } from '@/lib/session/cli-session';
import { clearAgentStopEvents, recordAgentEvent } from '@/lib/session/agent-event-state';
import { getAgentTurn } from '@/lib/session/agent-event-turn';
import { TURN_STALE_AFTER_MS } from '@/lib/session/provisional-turn';
import {
  startWaitingObservation,
  startWorktreeWaitingObservations,
  type WorktreeObservationStarts,
} from '@/lib/session/waiting-episode-binding';
import { promptScreenKey } from '@/lib/detection/prompt-screen-key';
import {
  clearWaitingEpisodes,
  clearWaitingTransitionListeners,
  closeEpisode,
  getWaitingEpisodeRecord,
  onWaitingEpisodeTransition,
  openEpisode,
  type WaitingEpisodeTransition,
} from '@/lib/session/waiting-episode-state';

const WT = 'wt-3798-sh';
const ALL_SESSIONS = new Set([`claude-${WT}`, `copilot-${WT}`, `opencode-${WT}`]);

const mockDb = {} as ReturnType<typeof import('@/lib/db/db-instance').getDbInstance>;
const mockGetMessages = vi.fn().mockReturnValue([]);
const mockMarkPending = vi.fn();
const mockGetAgentInstances = vi.fn(() => [] as AgentInstance[]);

function yesNo(question: string): PromptData {
  return { type: 'yes_no', question, status: 'pending', options: ['yes', 'no'] };
}
const PROMPT_A = yesNo('Run ls?');
const KEY_A = promptScreenKey(PROMPT_A);

/** The detector's verdict for every probe until changed. */
function frame(
  status: SessionStatus,
  reason: string,
  opts: { isPrompt?: boolean; hasActivePrompt?: boolean; promptData?: PromptData } = {},
): void {
  const isPrompt = opts.isPrompt ?? false;
  vi.mocked(detectSessionStatus).mockReturnValue({
    status,
    confidence: 'high',
    reason,
    hasActivePrompt: opts.hasActivePrompt ?? isPrompt,
    evidence: 'positive',
    promptDetection: { isPrompt, cleanContent: '', ...(opts.promptData ? { promptData: opts.promptData } : {}) },
  });
}
const promptFrame = (promptData: PromptData = PROMPT_A) =>
  frame('waiting', STATUS_REASON.PROMPT_DETECTED, { isPrompt: true, promptData });
const surveyFrame = () => frame('waiting', STATUS_REASON.CLAUDE_SELECTION_LIST);
const readyFrame = () => frame('ready', STATUS_REASON.INPUT_PROMPT);

async function poll(
  sessions: Set<string> = ALL_SESSIONS,
  starts?: WorktreeObservationStarts,
): Promise<Awaited<ReturnType<typeof detectWorktreeSessionStatus>>> {
  return detectWorktreeSessionStatus(
    WT,
    sessions,
    mockDb,
    mockGetMessages,
    mockMarkPending,
    mockGetAgentInstances,
    undefined,
    starts,
  );
}

function event(tool: CLIToolType, e: string, at: number, detail: string | null = null): void {
  recordAgentEvent(WT, tool, tool, { event: e as never, at, detail, sessionId: 's-1' });
}

const record = (tool: CLIToolType = 'claude') => getWaitingEpisodeRecord(WT, tool, tool);

let edges: WaitingEpisodeTransition[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  mockGetMessages.mockReturnValue([]);
  mockGetAgentInstances.mockReturnValue([]);
  vi.mocked(captureSessionOutput).mockResolvedValue('$ ');
  vi.mocked(getCaptureFetchStartedAt).mockReturnValue(null);
  readyFrame();
  clearAgentStopEvents();
  clearWaitingEpisodes();
  clearWaitingTransitionListeners();
  edges = [];
  onWaitingEpisodeTransition((t) => {
    if (t.cliToolId === 'claude') edges.push(t);
  });
});

afterEach(() => {
  vi.useRealTimers();
  clearAgentStopEvents();
  clearWaitingEpisodes();
  clearWaitingTransitionListeners();
});

describe('[#3798] the start the route fixes before listSessions()', () => {
  it('start taken before listSessions: a session started after the list keeps its wait', async () => {
    const starts = startWorktreeWaitingObservations(WT);
    // After the list: the session starts and its first prompt opens a wait.
    promptFrame();
    await poll(ALL_SESSIONS);
    const opened = record();
    expect(opened).not.toBeNull();

    // The probe with the list taken before that: claude is not in it.
    await poll(new Set([`copilot-${WT}`, `opencode-${WT}`]), starts);
    expect(record()?.episodeId).toBe(opened!.episodeId);
    expect(edges.map((e) => e.cause)).toEqual(['opened']);
  });

  it('control: a list taken after the wait opened ends it as gone', async () => {
    promptFrame();
    await poll(ALL_SESSIONS);
    const starts = startWorktreeWaitingObservations(WT);
    await poll(new Set([`copilot-${WT}`, `opencode-${WT}`]), starts);
    expect(record()).toBeNull();
    expect(edges.map((e) => [e.cause, e.closeReason])).toEqual([
      ['opened', null],
      ['closed', 'session-gone'],
    ]);
  });
});

describe('[#3798] the probe started before the episode moved (I5, I6)', () => {
  it('ABA: no wait at start, opened and closed during the capture, stale frame does not reopen', async () => {
    promptFrame();
    const fetchedAt = Date.now() - 1;
    vi.mocked(captureSessionOutput).mockImplementationOnce(async () => {
      // During the capture: the prompt opened a wait and its stop closed it.
      const e = openEpisode(
        { worktreeId: WT, cliToolId: 'claude', instanceId: 'claude' },
        {
          since: Date.now(),
          kind: 'prompt',
          binding: { kind: 'unattributed', generation: { kind: 'none' }, lastClosedTurnId: null },
          openedBy: 'response-checker',
          promptScreenKey: KEY_A,
        },
        Date.now(),
      );
      closeEpisode({ worktreeId: WT, cliToolId: 'claude', instanceId: 'claude' }, e.episodeId, 'turn-stop', Date.now());
      return 'frame';
    });
    // The frame was a cached one, fetched before all that.
    vi.mocked(getCaptureFetchStartedAt).mockReturnValueOnce(fetchedAt);

    const status = await poll();
    expect(status.sessionStatusByInstance.claude?.isWaitingForResponse).toBe(true);
    expect(record()).toBeNull();
    expect(edges.map((e) => e.cause)).toEqual(['opened', 'closed']);

    // The next probe, on a frame fetched after the close, opens it again.
    await poll();
    expect(record()).not.toBeNull();
  });

  it('stale cached frame after a stop (human answered in tmux) does not reopen the same prompt', async () => {
    event('claude', 'session_start', Date.now() - 10_000);
    event('claude', 'user_prompt_submit', Date.now() - 9_000);
    promptFrame();
    await poll();
    const opened = record()!;
    expect(opened.binding.kind).toBe('turn');
    const beforeStop = Date.now() - 1;

    // The person answered in tmux; the agent finished the turn.
    event('claude', 'stop', Date.now());
    expect(record()).toBeNull();

    // The cache still serves the frame fetched before the stop.
    vi.mocked(getCaptureFetchStartedAt).mockReturnValue(beforeStop);
    await poll();
    expect(record()).toBeNull();

    // Control: a frame fetched after the stop showing the same prompt is a wait.
    vi.mocked(getCaptureFetchStartedAt).mockReturnValue(null);
    await new Promise((r) => setTimeout(r, 2));
    await poll();
    expect(record()).not.toBeNull();
  });

  it('a frame fetched before the close but showing another confirmation still opens (R3-2)', async () => {
    event('claude', 'session_start', Date.now() - 10_000);
    event('claude', 'user_prompt_submit', Date.now() - 9_000);
    promptFrame();
    await poll();
    const beforeStop = Date.now() - 1;
    event('claude', 'stop', Date.now());

    promptFrame(yesNo('Run rm?'));
    vi.mocked(getCaptureFetchStartedAt).mockReturnValue(beforeStop);
    await poll();
    expect(record()).not.toBeNull();
  });
});

describe('[#3798] waits the turn model no longer explains', () => {
  it('a wait past the 30-minute stale bound keeps id, since and push count', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.now();
    event('claude', 'session_start', t0 - 1_000);
    event('claude', 'user_prompt_submit', t0);
    promptFrame();
    await poll();
    const opened = record()!;
    expect(opened.binding).toMatchObject({ kind: 'turn' });

    vi.setSystemTime(t0 + TURN_STALE_AFTER_MS + 60_000);
    expect(getAgentTurn(WT, 'claude', 'claude')?.closedBy).toBe('stale');
    await poll();
    await poll();
    expect(record()).toMatchObject({ episodeId: opened.episodeId, since: opened.since });
    expect(edges.map((e) => e.cause)).toEqual(['opened']);
  });

  it('a turn(T) left after its stop is closed by not-waiting', async () => {
    event('claude', 'session_start', Date.now() - 10_000);
    event('claude', 'user_prompt_submit', Date.now() - 9_000);
    const t = getAgentTurn(WT, 'claude', 'claude')!.turnId;
    event('claude', 'stop', Date.now() - 8_000);
    // The stop's own close was lost (a throw in the T table, design §2.6).
    openEpisode(
      { worktreeId: WT, cliToolId: 'claude', instanceId: 'claude' },
      {
        since: Date.now() - 8_500,
        kind: 'prompt',
        binding: { kind: 'turn', generation: startWaitingObservation(WT, 'claude', 'claude').generation, turnId: t },
        openedBy: 'status-probe',
      },
      Date.now() - 8_500,
    );
    readyFrame();
    await poll();
    expect(record()).toBeNull();
    expect(edges.at(-1)).toMatchObject({ cause: 'closed', closeReason: 'screen-cleared' });
  });

  it('three polls on the same wait open one edge', async () => {
    promptFrame();
    await poll();
    await poll();
    await poll();
    expect(edges.map((e) => e.cause)).toEqual(['opened']);
  });
});

describe('[#3798] whose screen it is (規則 1 humanHeld)', () => {
  it('copilot 4+ option ask_user and opencode permission strip with a decision are not screen', async () => {
    // copilot: a prompt the detector reads (`isPrompt`) without `hasActivePrompt`.
    frame('waiting', STATUS_REASON.COPILOT_SELECTION_LIST, { isPrompt: true, hasActivePrompt: false });
    await poll(new Set([`copilot-${WT}`]));
    expect(record('copilot')?.binding.kind).toBe('unattributed');

    // opencode: the strip has no prompt reading, but the agent reported the decision.
    clearWaitingEpisodes();
    recordAgentEvent(WT, 'opencode', 'opencode', {
      event: 'notification',
      at: Date.now(),
      detail: 'permission_prompt',
      sessionId: 's-1',
      message: 'permission',
    });
    frame('waiting', STATUS_REASON.OPENCODE_PERMISSION_PROMPT);
    await poll(new Set([`opencode-${WT}`]));
    expect(record('opencode')?.binding.kind).toBe('dialog-only');
  });

  it('control: the same strip with no decision is a person\'s screen', async () => {
    frame('waiting', STATUS_REASON.OPENCODE_PERMISSION_PROMPT);
    await poll(new Set([`opencode-${WT}`]));
    expect(record('opencode')?.binding.kind).toBe('screen');
  });

  it('#2: answer → survey → stop: the survey outlives the stop and ends when the screen clears', async () => {
    event('claude', 'session_start', Date.now() - 10_000);
    event('claude', 'user_prompt_submit', Date.now() - 9_000);
    const t = getAgentTurn(WT, 'claude', 'claude')!.turnId;
    promptFrame();
    await poll();
    const opened = record()!;

    surveyFrame();
    await poll();
    expect(record()).toMatchObject({ episodeId: opened.episodeId, binding: { kind: 'screen', originTurnId: t } });

    event('claude', 'stop', Date.now());
    expect(record()?.episodeId).toBe(opened.episodeId);
    await poll();
    expect(record()?.episodeId).toBe(opened.episodeId);

    readyFrame();
    await poll();
    expect(record()).toBeNull();
    expect(edges.map((e) => e.cause)).toEqual(['opened', 'closed']);
  });

  it('a menu after a stop opens a screen the next stop does not close', async () => {
    event('claude', 'session_start', Date.now() - 10_000);
    event('claude', 'user_prompt_submit', Date.now() - 9_000);
    event('claude', 'stop', Date.now() - 8_000);
    surveyFrame();
    await poll();
    expect(record()?.binding.kind).toBe('screen');
    event('claude', 'user_prompt_submit', Date.now() - 1);
    event('claude', 'stop', Date.now());
    expect(record()?.binding.kind).toBe('screen');
  });
});

describe('[#3798] a confirmation seen before its turn (破れ #6)', () => {
  it('structured confirmation → late start hook → repeated reads: one wait, rebound, same id', async () => {
    event('claude', 'session_start', Date.now() - 10_000);
    recordAgentEvent(WT, 'claude', 'claude', {
      event: 'notification',
      at: Date.now() - 5_000,
      detail: 'permission_prompt',
      sessionId: 's-1',
      message: 'Claude needs your permission to use Bash',
    });
    readyFrame();
    await poll();
    const opened = record()!;
    expect(opened.binding.kind).toBe('dialog-only');

    event('claude', 'post_tool_use', Date.now() - 1);
    expect(record()).toMatchObject({ episodeId: opened.episodeId, binding: { kind: 'turn' } });
    promptFrame();
    await poll();
    await poll();
    await poll();
    expect(record()?.episodeId).toBe(opened.episodeId);
    expect(edges.map((e) => e.cause)).toEqual(['opened']);
  });

  it('a screen-read confirmation with no turn → late post_tool_use → repeated reads: one wait', async () => {
    event('claude', 'session_start', Date.now() - 10_000);
    promptFrame();
    await poll();
    const opened = record()!;
    expect(opened.binding.kind).toBe('unattributed');

    event('claude', 'post_tool_use', Date.now());
    expect(record()).toMatchObject({ episodeId: opened.episodeId, binding: { kind: 'turn' } });
    await poll();
    await poll();
    expect(record()?.episodeId).toBe(opened.episodeId);
    expect(edges.map((e) => e.cause)).toEqual(['opened']);
  });
});
