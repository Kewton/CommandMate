/** @vitest-environment node */

/**
 * Issue #3337, live checks: interruptions the screen has to end a turn on.
 *
 *  1. **Claude** (`tests/fixtures/claude-interrupted-3337/`). An Esc leaves
 *     either `⎿  Interrupted · What should Claude do instead?` above the input
 *     box, or — early in the turn — the prompt put back in the composer with no
 *     marker at all. Neither sends a `Stop`. Reading each form proved
 *     open-ended, so Claude has no policy: its hook turns are closed by the
 *     screen, as before #3337.
 *  2. **codex with a background terminal**. Esc during `sleep 90 && ls` leaves
 *     `1 background terminal running · …` between `■ Conversation interrupted`
 *     and the composer. codex keeps its policy (the screen does not end its
 *     hook turns) and reads this frame as the interruption it is.
 *
 * Capture and the relay's readiness check both read the policy through
 * `lib/session/hook-turn-hold`, so both are checked.
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
import { screenMayCloseHookTurn } from '@/lib/detection/turn-abandoned';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { buildCodexInterruptedBackgroundTerminalPane } from '../../fixtures/codex-mid-turn-3337/codex-0.160.0-interrupted-background-terminal';

const FIXTURES = path.resolve(__dirname, '../../fixtures');
const frame = (rel: string): string => readFileSync(path.join(FIXTURES, rel), 'utf8');

const CLAUDE_INTERRUPTED = frame('claude-interrupted-3337/claude-2.1.289-interrupted.txt');
/** Esc ~8 s into the turn: the prompt is back in the composer, no `Interrupted` row. */
const CLAUDE_ESC_RESTORED = frame('claude-interrupted-3337/claude-2.1.289-esc-restored.txt');
const CODEX_BG_INTERRUPTED = buildCodexInterruptedBackgroundTerminalPane();
const CODEX_WORKING_HOLLOW = frame('codex-mid-turn-3337/codex-0.160.0-working-hollow.txt');
/** A codex composer after a reply: what a misread mid-turn frame looks like to the scraper. */
const CODEX_IDLE_AFTER_REPLY = frame('startup-screen-3293/codex-0.160.0-first-turn-reply.txt');

const WT = 'wt-3337-int';

function openTurn(tool: CLIToolType): void {
  recordAgentEvent(WT, tool, tool, {
    event: 'user_prompt_submit',
    at: Date.now(),
    detail: null,
    sessionId: 'ses_3337',
  });
}

async function pollTimes(tool: CLIToolType, pane: string, times: number) {
  vi.mocked(captureSessionOutput).mockResolvedValue(pane);
  let payload = await buildCurrentOutput({} as Database.Database, WT, tool);
  for (let i = 1; i < times; i++) {
    payload = await buildCurrentOutput({} as Database.Database, WT, tool);
  }
  return payload;
}

beforeEach(() => {
  vi.clearAllMocks();
  isRunning.mockResolvedValue(true);
  clearAgentStopEvents();
});

describe('[#3337] screenMayCloseHookTurn: the policy table', () => {
  it('codex: not on a live turn or a finished-looking composer', () => {
    expect(screenMayCloseHookTurn('codex', CODEX_WORKING_HOLLOW)).toBe(false);
    expect(screenMayCloseHookTurn('codex', CODEX_IDLE_AFTER_REPLY)).toBe(false);
  });

  it('codex: yes on an interruption, also with a background-terminal row before the composer', () => {
    expect(screenMayCloseHookTurn('codex', CODEX_BG_INTERRUPTED)).toBe(true);
  });

  it('claude has no policy: the screen may close its hook turns', () => {
    expect(screenMayCloseHookTurn('claude', CLAUDE_INTERRUPTED)).toBe(true);
    expect(screenMayCloseHookTurn('claude', CLAUDE_ESC_RESTORED)).toBe(true);
  });

  it('the screen reads every interrupted frame as ready / positive (what capture counts)', () => {
    for (const [tool, pane] of [
      ['claude', CLAUDE_INTERRUPTED],
      ['claude', CLAUDE_ESC_RESTORED],
      ['codex', CODEX_BG_INTERRUPTED],
    ] as const) {
      expect(detectSessionStatus(pane, tool)).toMatchObject({ status: 'ready', evidence: 'positive' });
    }
  });
});

describe.each([
  ['claude', 'Interrupted row', CLAUDE_INTERRUPTED],
  ['claude', 'prompt restored to the composer', CLAUDE_ESC_RESTORED],
  ['codex', 'interrupted with a background terminal', CODEX_BG_INTERRUPTED],
] as const)('[#3337] %s, %s: capture and relay release the hook turn', (tool, _form, pane) => {
  it('capture closes the turn as scraper_evidence and publishes ready', async () => {
    openTurn(tool);

    const payload = await pollTimes(tool, pane, SCRAPER_COMPLETION_POLLS);

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

describe('[#3337] codex, finished-looking frame with a hook turn open: still held', () => {
  it('capture keeps running and the relay holds', async () => {
    openTurn('codex');

    const payload = await pollTimes('codex', CODEX_IDLE_AFTER_REPLY, SCRAPER_COMPLETION_POLLS + 1);

    expect(payload.sessionStatus).toBe('running');
    expect(getAgentTurn(WT, 'codex', 'codex')?.closedAt).toBeNull();
    expect(await findRelayHoldReason(WT, 'codex', 'codex')).toBe('generating');
  });
});
