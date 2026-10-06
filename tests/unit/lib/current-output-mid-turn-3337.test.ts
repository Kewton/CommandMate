/** @vitest-environment node */

/**
 * Issue #3337: `capture --json` published `ready` in the middle of a codex turn.
 *
 * Two halves, each with its own controls:
 *
 *  1. **The frame.** codex 0.160.0's live status row blinks between `•` and `◦`,
 *     and its header is not always a verb the detector knew (`Reconnecting...`).
 *     Those frames read `ready` / `input_prompt` with positive evidence — the
 *     frames in `tests/fixtures/codex-mid-turn-3337/`, captured from a live turn.
 *  2. **The turn.** Three such polls in a row closed the turn as
 *     `scraper_evidence`, and the payload went back to the scraper's `ready`.
 *     On a hooks source the screen no longer closes a turn the agent has not
 *     ended — unless the frame shows the turn was interrupted, after which no
 *     `Stop` comes. A source with no hooks closes on the screen as before.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';

vi.mock('@/lib/db', () => ({ getSessionState: vi.fn(() => null), createMessage: vi.fn() }));
const isRunning = vi.fn().mockResolvedValue(true);
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: { getInstance: () => ({ getTool: () => ({ getSessionName: () => 'mcbd-test-session', isRunning }) }) },
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
import {
  clearAgentStopEvents,
  observeScraperCompletionEvidence,
  getAgentTurn,
  recordAgentEvent,
} from '@/lib/session/agent-event-state';
import { SCRAPER_COMPLETION_POLLS } from '@/lib/session/provisional-turn';
import { detectSessionStatus } from '@/lib/detection/status-detector';
import { screenMayCloseHookTurn } from '@/lib/detection/turn-abandoned';
import { isCodexTurnInterruptedFrame } from '@/lib/detection/tools/codex/patterns';
import { stripAnsi } from '@/lib/detection/cli-patterns';
import type { CLIToolType } from '@/lib/cli-tools/types';

const FIXTURES = path.resolve(__dirname, '../../fixtures');
const frame = (rel: string): string => readFileSync(path.join(FIXTURES, rel), 'utf8');

const MID_TURN = {
  workingBullet: frame('codex-mid-turn-3337/codex-0.160.0-working-bullet.txt'),
  workingHollow: frame('codex-mid-turn-3337/codex-0.160.0-working-hollow.txt'),
  reconnectingBullet: frame('codex-mid-turn-3337/codex-0.160.0-reconnecting-bullet.txt'),
  reconnectingHollow: frame('codex-mid-turn-3337/codex-0.160.0-reconnecting-hollow.txt'),
};
const INTERRUPTED = frame('codex-mid-turn-3337/codex-0.160.0-interrupted-idle.txt');
const FIRST_TURN_INTERRUPTED = frame('startup-screen-3293/codex-0.160.0-first-turn-interrupted.txt');
/** A codex composer after a reply — what a misread mid-turn frame looks like to the scraper. */
const IDLE_AFTER_REPLY = frame('startup-screen-3293/codex-0.160.0-first-turn-reply.txt');
const VIBE_IDLE = frame('startup-screen-3293/vibe-local-1.3.3-first-turn-done.txt');

const WT = 'wt-3337';

function openTurn(tool: CLIToolType): void {
  recordAgentEvent(WT, tool, undefined, {
    event: 'user_prompt_submit',
    at: Date.now(),
    detail: null,
    sessionId: 'ses_3337',
  });
}

async function pollWith(tool: CLIToolType, pane: string, times: number) {
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

describe('[#3337] codex 0.160.0 mid-turn frames read as running', () => {
  it.each(Object.entries(MID_TURN))('%s → running/thinking_indicator', (_name, pane) => {
    for (const input of [pane, stripAnsi(pane)]) {
      const result = detectSessionStatus(input, 'codex');
      expect(result.status).toBe('running');
      expect(result.reason).toBe('thinking_indicator');
    }
  });

  it('keeps the interrupted composer and the idle composer at ready (negative controls)', () => {
    expect(detectSessionStatus(INTERRUPTED, 'codex').status).toBe('ready');
    expect(detectSessionStatus(IDLE_AFTER_REPLY, 'codex').status).toBe('ready');
  });
});

describe('[#3337] which codex frame says the turn was interrupted', () => {
  const rows = (pane: string) => stripAnsi(pane).split('\n');

  it('reads `■ Conversation interrupted` as the last row above the composer', () => {
    expect(isCodexTurnInterruptedFrame(rows(INTERRUPTED))).toBe(true);
    expect(isCodexTurnInterruptedFrame(rows(FIRST_TURN_INTERRUPTED))).toBe(true);
    expect(screenMayCloseHookTurn('codex', INTERRUPTED)).toBe(true);
    expect(screenMayCloseHookTurn('codex', MID_TURN.workingHollow)).toBe(false);
  });

  it('does not read a live turn, a finished reply, or a marker something followed', () => {
    for (const pane of [...Object.values(MID_TURN), IDLE_AFTER_REPLY]) {
      expect(isCodexTurnInterruptedFrame(rows(pane))).toBe(false);
    }
    const laterTurn = [
      '› first prompt',
      '■ Conversation interrupted - use /feedback if something went wrong',
      '› second prompt',
      '• Here is the answer.',
      '',
      '› Ask Codex to do anything',
    ];
    expect(isCodexTurnInterruptedFrame(laterTurn)).toBe(false);
  });

  it('lets the screen close the turn of a tool with no policy', () => {
    expect(screenMayCloseHookTurn('claude', INTERRUPTED)).toBe(true);
  });
});

describe('[#3337] a hooks source keeps its turn open through a finished-looking screen', () => {
  it('stays running, with the turn open, past SCRAPER_COMPLETION_POLLS ready polls', async () => {
    openTurn('codex');

    const payload = await pollWith('codex', IDLE_AFTER_REPLY, SCRAPER_COMPLETION_POLLS + 2);

    expect(payload.structuredEvents?.source.kind).toBe('hooks');
    expect(payload.structuredEvents?.closedBy).toBeNull();
    expect(payload.sessionStatus).toBe('running');
    expect(getAgentTurn(WT, 'codex', undefined)?.closedAt).toBeNull();
  });

  it('ends at the agent\'s own Stop, as before', async () => {
    openTurn('codex');
    await pollWith('codex', IDLE_AFTER_REPLY, SCRAPER_COMPLETION_POLLS);
    recordAgentEvent(WT, 'codex', undefined, {
      event: 'stop',
      at: Date.now(),
      detail: null,
      sessionId: 'ses_3337',
    });

    const payload = await pollWith('codex', IDLE_AFTER_REPLY, 1);

    expect(payload.structuredEvents?.closedBy).toBe('stop');
    expect(payload.sessionStatus).toBe('ready');
  });

  it('closes on the screen when the frame shows the turn was interrupted', async () => {
    openTurn('codex');

    const payload = await pollWith('codex', INTERRUPTED, SCRAPER_COMPLETION_POLLS);

    // The turn fields on the payload are read before the poll is fed, so the
    // closing poll reports the close through the status and the record.
    expect(getAgentTurn(WT, 'codex', undefined)?.closedBy).toBe('scraper_evidence');
    expect(payload.sessionStatus).toBe('ready');
  });

  it('still needs SCRAPER_COMPLETION_POLLS interrupted frames', async () => {
    openTurn('codex');

    const payload = await pollWith('codex', INTERRUPTED, SCRAPER_COMPLETION_POLLS - 1);

    expect(getAgentTurn(WT, 'codex', undefined)?.closedAt).toBeNull();
    // #3377: the record still needs 3 frames to close, but the interrupted frame publishes the screen's ready, as the list does.
    expect(payload.sessionStatus).toBe('ready');
    expect(payload.sessionStatusReason).toBe('input_prompt');
  });
});

describe('[#3337] a source with no hooks closes on the screen, unchanged', () => {
  it('closes as scraper_evidence after SCRAPER_COMPLETION_POLLS ready polls', async () => {
    expect(detectSessionStatus(VIBE_IDLE, 'vibe-local')).toMatchObject({
      status: 'ready',
      evidence: 'positive',
    });
    openTurn('vibe-local');

    const payload = await pollWith('vibe-local', VIBE_IDLE, SCRAPER_COMPLETION_POLLS);

    expect(payload.structuredEvents?.source.kind).toBe('scraper');
    expect(getAgentTurn(WT, 'vibe-local', undefined)?.closedBy).toBe('scraper_evidence');
    expect(payload.sessionStatus).toBe('ready');
  });
});

describe('[#3337] observeScraperCompletionEvidence(mayClose)', () => {
  it('counts but does not close while mayClose is false, and closes once it is true', () => {
    openTurn('codex');
    const t = Date.now();
    for (let i = 0; i < SCRAPER_COMPLETION_POLLS + 1; i++) {
      expect(observeScraperCompletionEvidence(WT, 'codex', undefined, true, t + i, false)).toBe(false);
    }
    expect(getAgentTurn(WT, 'codex', undefined, t + 10)?.closedAt).toBeNull();

    expect(observeScraperCompletionEvidence(WT, 'codex', undefined, true, t + 20, true)).toBe(true);
    expect(getAgentTurn(WT, 'codex', undefined, t + 21)?.closedBy).toBe('scraper_evidence');
  });
});
