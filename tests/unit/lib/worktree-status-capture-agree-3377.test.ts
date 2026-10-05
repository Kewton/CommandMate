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
import { clearAgentStopEvents, recordAgentEvent } from '@/lib/session/agent-event-state';
import { TURN_STALE_AFTER_MS } from '@/lib/session/provisional-turn';
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

async function listProcessing(tool: Tool, rows: ChatMessage[] = []): Promise<boolean> {
  const status = await detectWorktreeSessionStatus(
    WT,
    new Set([`${tool}-${WT}`]),
    {} as ReturnType<typeof import('@/lib/db/db-instance').getDbInstance>,
    vi.fn().mockReturnValue(rows),
    vi.fn(),
    vi.fn(() => [] as AgentInstance[]),
  );
  return status.sessionStatusByCli[tool]?.isProcessing === true;
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

  it('the interrupted codex frame: the list still reads it at once (unchanged; see the commit)', async () => {
    post('codex', 'user_prompt_submit', Date.now() - 2_000);
    vi.mocked(captureSessionOutput).mockResolvedValue(CODEX_INTERRUPTED);
    expect(await listProcessing('codex')).toBe(false);
  });
});
