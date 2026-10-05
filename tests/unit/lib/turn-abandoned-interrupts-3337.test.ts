/** @vitest-environment node */

/**
 * Issue #3337, live check: two interruptions the screen did not read as one.
 *
 *  1. **Claude** (`tests/fixtures/claude-interrupted-3337/`). Esc mid-reply
 *     leaves `⎿  Interrupted · What should Claude do instead?` above the input
 *     box. No `Stop`, and no `idle_prompt` in 2.5 minutes, so with no reader the
 *     turn stayed `running` until the stale bound — worse than before #3337,
 *     when the screen closed it.
 *  2. **codex with a background terminal**. Esc during `sleep 90 && ls` leaves
 *     `1 background terminal running · …` between `■ Conversation interrupted`
 *     and the composer, so "the marker is the last row above the composer" did
 *     not hold.
 *
 * Both are read by `frameShowsAbandonedTurn`, which capture and the relay's
 * readiness check both read through `lib/session/hook-turn-hold`, so both are
 * checked here.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';

vi.mock('@/lib/db', () => ({ getSessionState: vi.fn(() => null), createMessage: vi.fn() }));
const isRunning = vi.fn().mockResolvedValue(true);
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({ getTool: () => ({ getSessionName: () => 'mcbd-test-session', isRunning }) }),
  },
}));
vi.mock('@/lib/cli-tools/worktree-session-ownership', () => ({
  checkWorktreeSessionOwnership: vi.fn(async () => ({ verdict: 'own' })),
}));
vi.mock('@/lib/session/cli-session', () => ({ captureSessionOutput: vi.fn() }));
vi.mock('@/lib/polling/auto-yes-manager', () => ({
  getAutoYesState: vi.fn(() => null),
  buildCompositeKey: (worktreeId: string, cliToolId: string, instanceId?: string) =>
    `${worktreeId}:${cliToolId}:${instanceId ?? cliToolId}`,
  getLastServerResponseTimestamp: vi.fn(() => null),
  isPollerActive: vi.fn(() => false),
}));

import { captureSessionOutput } from '@/lib/session/cli-session';
import { buildCurrentOutput } from '@/lib/session/current-output-builder';
import { findRelayHoldReason } from '@/lib/relay/relay-readiness';
import { clearAgentStopEvents, getAgentTurn, recordAgentEvent } from '@/lib/session/agent-event-state';
import { SCRAPER_COMPLETION_POLLS } from '@/lib/session/provisional-turn';
import { detectSessionStatus } from '@/lib/detection/status-detector';
import { frameShowsAbandonedTurn } from '@/lib/detection/turn-abandoned';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { buildCodexInterruptedBackgroundTerminalPane } from '../../fixtures/codex-mid-turn-3337/codex-0.160.0-interrupted-background-terminal';

const FIXTURES = path.resolve(__dirname, '../../fixtures');
const frame = (rel: string): string => readFileSync(path.join(FIXTURES, rel), 'utf8');

const CLAUDE_INTERRUPTED = frame('claude-interrupted-3337/claude-2.1.289-interrupted.txt');
const CLAUDE_BUSY = readFileSync(
  path.resolve(__dirname, 'tmux/fixtures/capture-claude-busy.txt'),
  'utf8'
);
const CLAUDE_DONE = frame('claude-live-2247/turn-tip.txt');
/** An idle composer whose transcript holds the word `Interrupted` higher up. */
const CLAUDE_IDLE_SCROLLED = frame('claude-model-switch-2361/fullscreen-switch-line-scrolled.txt');
const CODEX_BG_INTERRUPTED = buildCodexInterruptedBackgroundTerminalPane();
const CODEX_WORKING = frame('codex-mid-turn-3337/codex-0.160.0-working-bullet.txt');

const WT = 'wt-3337-int';

function openTurn(tool: CLIToolType): void {
  recordAgentEvent(WT, tool, tool, {
    event: 'user_prompt_submit',
    at: Date.now(),
    detail: null,
    sessionId: 'ses_3337',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  isRunning.mockResolvedValue(true);
  clearAgentStopEvents();
});

describe('[#3337] frameShowsAbandonedTurn reads both interruptions', () => {
  it('Claude: `⎿  Interrupted` as the last row above the input box', () => {
    expect(frameShowsAbandonedTurn('claude', CLAUDE_INTERRUPTED)).toBe(true);
  });

  it('Claude: not a working pane, a finished turn, or an idle pane with older text', () => {
    expect(frameShowsAbandonedTurn('claude', CLAUDE_BUSY)).toBe(false);
    expect(frameShowsAbandonedTurn('claude', CLAUDE_DONE)).toBe(false);
    expect(frameShowsAbandonedTurn('claude', CLAUDE_IDLE_SCROLLED)).toBe(false);
  });

  it('Claude: an interruption something followed is not the latest one', () => {
    const lines = CLAUDE_INTERRUPTED.split('\n');
    const at = lines.findIndex((l) => l.includes('Interrupted'));
    lines.splice(at + 1, 1, '❯ try again', '', '⏺ Done.');
    expect(frameShowsAbandonedTurn('claude', lines.join('\n'))).toBe(false);
  });

  it('codex: `■ Conversation interrupted` with a background-terminal row before the composer', () => {
    expect(frameShowsAbandonedTurn('codex', CODEX_BG_INTERRUPTED)).toBe(true);
    // The row alone is not an interruption.
    expect(frameShowsAbandonedTurn('codex', CODEX_WORKING)).toBe(false);
  });

  it('the screen reads both frames as ready (what capture feeds the counter)', () => {
    expect(detectSessionStatus(CLAUDE_INTERRUPTED, 'claude')).toMatchObject({
      status: 'ready',
      evidence: 'positive',
    });
    expect(detectSessionStatus(CODEX_BG_INTERRUPTED, 'codex')).toMatchObject({
      status: 'ready',
      evidence: 'positive',
    });
  });
});

describe.each([
  ['claude', CLAUDE_INTERRUPTED],
  ['codex', CODEX_BG_INTERRUPTED],
] as const)('[#3337] %s interrupted: capture and relay release the hook turn', (tool, pane) => {
  it('capture closes the turn as scraper_evidence and publishes ready', async () => {
    openTurn(tool);
    vi.mocked(captureSessionOutput).mockResolvedValue(pane);

    let payload = await buildCurrentOutput({} as Database.Database, WT, tool);
    for (let i = 1; i < SCRAPER_COMPLETION_POLLS; i++) {
      payload = await buildCurrentOutput({} as Database.Database, WT, tool);
    }

    expect(payload.structuredEvents?.source.kind).toBe('hooks');
    expect(getAgentTurn(WT, tool, tool)?.closedBy).toBe('scraper_evidence');
    expect(payload.sessionStatus).toBe('ready');
  });

  it('the relay does not hold', async () => {
    openTurn(tool);
    vi.mocked(captureSessionOutput).mockResolvedValue(pane);

    expect(await findRelayHoldReason(WT, tool, tool)).toBeNull();
  });
});

describe('[#3337] a finished-looking Claude pane with a hook turn open: still held', () => {
  it('relay holds and capture keeps running', async () => {
    openTurn('claude');
    vi.mocked(captureSessionOutput).mockResolvedValue(CLAUDE_DONE);

    expect(await findRelayHoldReason(WT, 'claude', 'claude')).toBe('generating');
    let payload = await buildCurrentOutput({} as Database.Database, WT, 'claude');
    for (let i = 1; i <= SCRAPER_COMPLETION_POLLS; i++) {
      payload = await buildCurrentOutput({} as Database.Database, WT, 'claude');
    }
    expect(payload.sessionStatus).toBe('running');
    expect(getAgentTurn(WT, 'claude', 'claude')?.closedAt).toBeNull();
  });
});
