/** @vitest-environment node */

/**
 * Issue #3337: a relay must not type into a turn the agent's hooks opened.
 *
 * `findRelayHoldReason` read the frame alone, and a frame of a live codex turn
 * reads `ready` — `codex-live-2310/steer-queued-running.txt` still does — so a
 * relay reply could be sent into the running turn while `capture --json` said
 * `running`. The readiness check now reads the same rule capture does
 * (`lib/session/hook-turn-hold`): an open hook turn holds, the agent's `Stop`
 * releases, and the interrupted frame and the stale bound release as they do
 * in capture.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const isRunning = vi.fn().mockResolvedValue(true);
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: { getInstance: () => ({ getTool: () => ({ isRunning }) }) },
}));
vi.mock('@/lib/cli-tools/worktree-session-ownership', () => ({
  checkWorktreeSessionOwnership: vi.fn(async () => ({ verdict: 'own' })),
}));
vi.mock('@/lib/session/cli-session', () => ({ captureSessionOutput: vi.fn() }));

import { captureSessionOutput } from '@/lib/session/cli-session';
import { findRelayHoldReason } from '@/lib/relay/relay-readiness';
import { clearAgentStopEvents, recordAgentEvent } from '@/lib/session/agent-event-state';
import { TURN_STALE_AFTER_MS } from '@/lib/session/provisional-turn';
import { detectSessionStatus } from '@/lib/detection/status-detector';
import type { CLIToolType } from '@/lib/cli-tools/types';

const FIXTURES = path.resolve(__dirname, '../../../fixtures');
const frame = (rel: string): string => readFileSync(path.join(FIXTURES, rel), 'utf8');

/** A running codex turn the frame alone reads as `ready`. */
const MID_TURN_READ_READY = frame('codex-live-2310/steer-queued-running.txt');
const INTERRUPTED = frame('codex-mid-turn-3337/codex-0.160.0-interrupted-idle.txt');
const VIBE_IDLE = frame('startup-screen-3293/vibe-local-1.3.3-first-turn-done.txt');

const WT = 'wt-3337-relay';

function post(tool: CLIToolType, event: 'user_prompt_submit' | 'stop', at = Date.now()): void {
  recordAgentEvent(WT, tool, tool, { event, at, detail: null, sessionId: 'ses_3337' });
}

beforeEach(() => {
  vi.clearAllMocks();
  isRunning.mockResolvedValue(true);
  clearAgentStopEvents();
});

describe('[#3337] relay readiness reads the hook turn', () => {
  it('the frame alone reads the running turn as ready (the premise)', () => {
    expect(detectSessionStatus(MID_TURN_READ_READY, 'codex').status).toBe('ready');
  });

  it('holds while a hooks source has a turn open and the frame reads ready', async () => {
    vi.mocked(captureSessionOutput).mockResolvedValue(MID_TURN_READ_READY);
    post('codex', 'user_prompt_submit');

    expect(await findRelayHoldReason(WT, 'codex', 'codex')).toBe('generating');
  });

  it('delivers once the agent reported Stop', async () => {
    vi.mocked(captureSessionOutput).mockResolvedValue(MID_TURN_READ_READY);
    post('codex', 'user_prompt_submit', Date.now() - 1_000);
    post('codex', 'stop');

    expect(await findRelayHoldReason(WT, 'codex', 'codex')).toBeNull();
  });

  it('delivers when the frame shows the turn was interrupted (no Stop comes)', async () => {
    vi.mocked(captureSessionOutput).mockResolvedValue(INTERRUPTED);
    post('codex', 'user_prompt_submit');

    expect(await findRelayHoldReason(WT, 'codex', 'codex')).toBeNull();
  });

  it('delivers once the open turn has gone stale', async () => {
    vi.mocked(captureSessionOutput).mockResolvedValue(MID_TURN_READ_READY);
    post('codex', 'user_prompt_submit', Date.now() - TURN_STALE_AFTER_MS - 1_000);

    expect(await findRelayHoldReason(WT, 'codex', 'codex')).toBeNull();
  });

  it('delivers on a ready frame when no turn is open', async () => {
    vi.mocked(captureSessionOutput).mockResolvedValue(MID_TURN_READ_READY);

    expect(await findRelayHoldReason(WT, 'codex', 'codex')).toBeNull();
  });

  it('leaves a source with no hooks to the frame, as before', async () => {
    vi.mocked(captureSessionOutput).mockResolvedValue(VIBE_IDLE);
    post('vibe-local', 'user_prompt_submit');

    expect(await findRelayHoldReason(WT, 'vibe-local', 'vibe-local')).toBeNull();
  });
});
