/**
 * @vitest-environment node
 *
 * Issue #3377: the list (`GET /api/worktrees` → `commandmate ls`, the sidebar)
 * and `capture --json` must give one pane the same answer at the same moment.
 *
 * Measured on 2026-10-06: after the agent's own `Stop`, while the frame still
 * shows the working row, `capture --json` said `ready / hook_stop` and the list
 * kept `isProcessing: true` for ~4 s (codex) / ~2 s (claude). The list now folds
 * the turn record in through `mergeStructuredStatus` — the function the capture
 * calls — so it narrows exactly where the capture does.
 *
 * Each case drives both paths over the same frame and the same turn record.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { AgentInstance, CLIToolType } from '@/lib/cli-tools/types';
import type { ChatMessage } from '@/types/models';

vi.mock('@/lib/db', () => ({ getSessionState: vi.fn(() => null), createMessage: vi.fn() }));
vi.mock('@/lib/db/chat-db', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/db/chat-db')>();
  return { ...original, getLastUserMessageForInstance: vi.fn(() => null) };
});
const isRunning = vi.fn().mockResolvedValue(true);
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({
      getTool: (cliToolId: string) => ({
        getSessionName: (worktreeId: string) => `${cliToolId}-${worktreeId}`,
        name: cliToolId,
        isRunning,
      }),
    }),
  },
}));
vi.mock('@/lib/cli-tools/types', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/cli-tools/types')>();
  return { ...original, CLI_TOOL_IDS: ['claude', 'codex', 'vibe-local'] as never };
});
vi.mock('@/lib/session/cli-session', () => ({ captureSessionOutput: vi.fn() }));
vi.mock('@/lib/cli-tools/session-liveness', () => ({
  probeToolSessionLiveness: vi.fn().mockResolvedValue({ alive: true }),
}));

import { captureSessionOutput } from '@/lib/session/cli-session';
import { getLastUserMessageForInstance } from '@/lib/db/chat-db';
import { buildCurrentOutput } from '@/lib/session/current-output-builder';
import { detectWorktreeSessionStatus } from '@/lib/session/worktree-status-helper';
import { clearAgentStopEvents, getAgentTurn, recordAgentEvent } from '@/lib/session/agent-event-state';
import { SCRAPER_COMPLETION_POLLS, TURN_STALE_AFTER_MS } from '@/lib/session/provisional-turn';
import { clearLastKnownStatuses } from '@/lib/session/status-evidence';
import { detectSessionStatus } from '@/lib/detection/status-detector';

const FIXTURES = path.resolve(__dirname, '../../fixtures');
const frame = (rel: string): string => readFileSync(path.join(FIXTURES, rel), 'utf8');

/** A live codex 0.160.0 turn: `• Working (… esc to interrupt)` above the composer. */
const CODEX_WORKING = frame('codex-mid-turn-3337/codex-0.160.0-working-bullet.txt');
/** A running codex turn whose frame alone reads `ready` (#3365). */
const CODEX_MID_TURN_READ_READY = frame('codex-live-2310/steer-queued-running.txt');
/** codex after Esc: `■ Conversation interrupted` above the composer. */
const CODEX_INTERRUPTED = frame('codex-mid-turn-3337/codex-0.160.0-interrupted-idle.txt');
/** A codex composer after a reply: what a misread mid-turn frame looks like to the scraper. */
const CODEX_IDLE_AFTER_REPLY = frame('startup-screen-3293/codex-0.160.0-first-turn-reply.txt');
/** Claude after Esc: `⎿  Interrupted` above the input box (no policy). */
const CLAUDE_INTERRUPTED = frame('claude-interrupted-3337/claude-2.1.289-interrupted.txt');
/** Claude with its spinner still painted. */
const CLAUDE_WORKING = [
  '> do the thing',
  '',
  '✻ Thinking… (3s · esc to interrupt)',
  '',
  '────────────────────────────────────────',
  '> ',
  '────────────────────────────────────────',
  '',
].join('\n');

const WT = 'wt-3377';
const SESSION = 'ses_3377';
type Tool = Extract<CLIToolType, 'codex' | 'claude' | 'vibe-local'>;

function post(tool: Tool, event: 'user_prompt_submit' | 'stop', at: number): void {
  recordAgentEvent(WT, tool, tool, { event, at, detail: null, sessionId: SESSION });
}

/** A turn opened 5 s ago and closed by the agent's own `Stop` 1 s ago. */
function finishedTurn(tool: Tool): number {
  const stopAt = Date.now() - 1_000;
  post(tool, 'user_prompt_submit', stopAt - 4_000);
  post(tool, 'stop', stopAt);
  return stopAt;
}

const userRow = (at: number): ChatMessage =>
  ({ role: 'user', messageType: 'normal', timestamp: new Date(at) }) as unknown as ChatMessage;
const assistantRow = (at: number): ChatMessage =>
  ({ role: 'assistant', messageType: 'normal', timestamp: new Date(at) }) as unknown as ChatMessage;

async function listProcessing(tool: Tool, rows: ChatMessage[] = []): Promise<boolean> {
  return (await listStatus(tool, rows))?.isProcessing === true;
}

async function listStatus(tool: Tool, rows: ChatMessage[] = []) {
  const status = await detectWorktreeSessionStatus(
    WT,
    new Set([`${tool}-${WT}`]),
    {} as ReturnType<typeof import('@/lib/db/db-instance').getDbInstance>,
    vi.fn().mockReturnValue(rows),
    vi.fn(),
    vi.fn(() => [] as AgentInstance[]),
  );
  return status.sessionStatusByCli[tool];
}

async function captureStatus(tool: Tool): Promise<{ status: string; reason: string }> {
  const payload = await buildCurrentOutput({} as Database.Database, WT, tool, tool);
  return { status: payload.sessionStatus as string, reason: payload.sessionStatusReason as string };
}

/** Both answers, list first — the order the measured poll took them in. */
async function both(tool: Tool, pane: string, rows: ChatMessage[] = []) {
  vi.mocked(captureSessionOutput).mockResolvedValue(pane);
  const processing = await listProcessing(tool, rows);
  const capture = await captureStatus(tool);
  return { processing, capture };
}

beforeEach(() => {
  vi.clearAllMocks();
  isRunning.mockResolvedValue(true);
  clearAgentStopEvents();
  clearLastKnownStatuses();
  vi.mocked(getLastUserMessageForInstance).mockReturnValue(null);
});

describe('[#3377] premises', () => {
  it('the working frames read running/thinking_indicator on their own', () => {
    expect(detectSessionStatus(CODEX_WORKING, 'codex')).toMatchObject({
      status: 'running',
      reason: 'thinking_indicator',
    });
    expect(detectSessionStatus(CLAUDE_WORKING, 'claude')).toMatchObject({
      status: 'running',
      reason: 'thinking_indicator',
    });
  });
});

describe('[#3377] after the agent\'s Stop, with the working row still painted', () => {
  it('codex: the list is not processing when capture says ready / hook_stop', async () => {
    finishedTurn('codex');
    const { processing, capture } = await both('codex', CODEX_WORKING);
    expect(capture).toEqual({ status: 'ready', reason: 'hook_stop' });
    expect(processing).toBe(false);
  });

  it('claude: the list is not processing when capture says ready / hook_stop', async () => {
    finishedTurn('claude');
    const { processing, capture } = await both('claude', CLAUDE_WORKING);
    expect(capture).toEqual({ status: 'ready', reason: 'hook_stop' });
    expect(processing).toBe(false);
  });

  it('stays processing, as capture stays running, when the Stop predates the newest prompt (#2429)', async () => {
    const stopAt = finishedTurn('codex');
    const promptAt = stopAt + 500;
    vi.mocked(getLastUserMessageForInstance).mockReturnValue(userRow(promptAt));
    const { processing, capture } = await both('codex', CODEX_WORKING, [userRow(promptAt)]);
    expect(capture.status).toBe('running');
    expect(processing).toBe(true);
  });

  it('stays processing when the newer prompt is pushed out of the newest 10 rows by assistant rows', async () => {
    const stopAt = finishedTurn('codex');
    const promptAt = stopAt + 100;
    vi.mocked(getLastUserMessageForInstance).mockReturnValue(userRow(promptAt));
    // Newest first, as getMessages returns them: 10 assistant rows after the prompt fill its window.
    const rows = Array.from({ length: 10 }, (_, i) => assistantRow(promptAt + 1_000 - i * 10));
    const { processing, capture } = await both('codex', CODEX_WORKING, rows);
    expect(capture.status).toBe('running');
    expect(processing).toBe(true);
  });

  it('latches the published answer: lastKnownStatus is ready once the Stop narrowed it', async () => {
    finishedTurn('codex');
    vi.mocked(captureSessionOutput).mockResolvedValue(CODEX_WORKING);
    const status = await listStatus('codex');
    expect(status?.isProcessing).toBe(false);
    expect(status?.lastKnownStatus).toBe('ready');
    // The reason the list publishes stays the screen's.
    expect(status?.sessionStatusReason).toBe('thinking_indicator');
    const capture = await captureStatus('codex');
    expect(capture.status).toBe(status?.lastKnownStatus);
  });

  it('latches running while the hook turn holds a ready-looking codex frame (#3365)', async () => {
    post('codex', 'user_prompt_submit', Date.now() - 2_000);
    vi.mocked(captureSessionOutput).mockResolvedValue(CODEX_MID_TURN_READ_READY);
    const status = await listStatus('codex');
    expect(status?.isProcessing).toBe(true);
    expect(status?.lastKnownStatus).toBe('running');
  });

  it('is not processing when the newest prompt is older than the Stop', async () => {
    const stopAt = finishedTurn('codex');
    const promptAt = stopAt - 4_500;
    vi.mocked(getLastUserMessageForInstance).mockReturnValue(userRow(promptAt));
    const { processing, capture } = await both('codex', CODEX_WORKING, [userRow(promptAt)]);
    expect(capture).toEqual({ status: 'ready', reason: 'hook_stop' });
    expect(processing).toBe(false);
  });
});

describe('[#3377] mid-turn, unchanged (#3337 / #3365)', () => {
  it('codex with an open turn and the working row: both running', async () => {
    post('codex', 'user_prompt_submit', Date.now() - 2_000);
    const { processing, capture } = await both('codex', CODEX_WORKING);
    expect(capture.status).toBe('running');
    expect(processing).toBe(true);
  });

  it('codex with an open turn and a frame that reads ready: both running', async () => {
    post('codex', 'user_prompt_submit', Date.now() - 2_000);
    const { processing, capture } = await both('codex', CODEX_MID_TURN_READ_READY);
    expect(capture.status).toBe('running');
    expect(processing).toBe(true);
  });

  it('claude with an open turn and its spinner: both running', async () => {
    post('claude', 'user_prompt_submit', Date.now() - 2_000);
    const { processing, capture } = await both('claude', CLAUDE_WORKING);
    expect(capture.status).toBe('running');
    expect(processing).toBe(true);
  });
});

describe('[#3377] controls the structured layer does not reach', () => {
  it('a stale turn hands the pane back to the frame: both running on the working row', async () => {
    const at = Date.now() - TURN_STALE_AFTER_MS - 1_000;
    post('codex', 'user_prompt_submit', at - 1_000);
    post('codex', 'stop', at);
    const { processing, capture } = await both('codex', CODEX_WORKING);
    expect(capture.status).toBe('running');
    expect(processing).toBe(true);
  });

  it('no hook events at all (screen only): both running on the working row', async () => {
    const { processing, capture } = await both('codex', CODEX_WORKING);
    expect(capture.status).toBe('running');
    expect(processing).toBe(true);
  });

  it('a source with no hooks keeps the screen\'s answer', async () => {
    const { processing, capture } = await both('vibe-local', CLAUDE_WORKING);
    expect(processing).toBe(capture.status === 'running');
  });

});

describe('[#3377] Esc: the interrupted codex frame', () => {
  it('one poll: the list is not processing and capture says ready / input_prompt', async () => {
    post('codex', 'user_prompt_submit', Date.now() - 2_000);
    const { processing, capture } = await both('codex', CODEX_INTERRUPTED);
    expect(processing).toBe(false);
    expect(capture).toEqual({ status: 'ready', reason: 'input_prompt' });
  });

  it('the record still closes on the SCRAPER_COMPLETION_POLLS-th frame, not before', async () => {
    post('codex', 'user_prompt_submit', Date.now() - 2_000);
    vi.mocked(captureSessionOutput).mockResolvedValue(CODEX_INTERRUPTED);
    for (let i = 1; i < SCRAPER_COMPLETION_POLLS; i++) await captureStatus('codex');
    expect(getAgentTurn(WT, 'codex', 'codex')?.closedAt).toBeNull();
    await captureStatus('codex');
    expect(getAgentTurn(WT, 'codex', 'codex')?.closedBy).toBe('scraper_evidence');
  });

  it.each([
    ['the working row', CODEX_WORKING],
    ['a frame that reads ready (#3365)', CODEX_MID_TURN_READ_READY],
    ['an idle-looking composer (#3337)', CODEX_IDLE_AFTER_REPLY],
  ])('not interrupted, %s: both stay running for N polls, so wait does not complete before Stop', async (_name, pane) => {
    post('codex', 'user_prompt_submit', Date.now() - 2_000);
    for (let i = 0; i < SCRAPER_COMPLETION_POLLS + 2; i++) {
      const { processing, capture } = await both('codex', pane);
      expect(processing).toBe(true);
      expect(capture.status).toBe('running');
    }
    expect(getAgentTurn(WT, 'codex', 'codex')?.closedAt).toBeNull();
  });

  it('claude (no policy) is unchanged: its interrupted frame stays running in capture until the record closes', async () => {
    post('claude', 'user_prompt_submit', Date.now() - 2_000);
    const { processing, capture } = await both('claude', CLAUDE_INTERRUPTED);
    expect(processing).toBe(false);
    expect(capture.status).toBe('running');
  });
});
