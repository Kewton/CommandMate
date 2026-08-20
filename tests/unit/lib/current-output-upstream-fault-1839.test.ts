/** @vitest-environment node */

/**
 * Issue #1839: the upstream fault has to reach `capture --json`.
 *
 * Matching a frame in `lib/detection/upstream-faults` is not the deliverable —
 * an operator triaging "the agent produced nothing" reads the capture payload,
 * and `wait --fail-on-upstream-fault` branches on the same field. So these run
 * the real detection module through `buildCurrentOutput` against the frames
 * measured on 2026-08-20 (docs/design/upstream-fault-turn-boundary-1839.md).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';

vi.mock('@/lib/db', () => ({ getSessionState: vi.fn(() => null), createMessage: vi.fn() }));
const isRunning = vi.fn().mockResolvedValue(true);
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: { getInstance: () => ({ getTool: () => ({ isRunning }) }) },
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

/** The pane measured 3 s after a send that hit a stub upstream answering 529. */
const FAULTED_FRAME = [
  ' ▐▛███▛█   Claude Code v2.1.236',
  '❯ Say the single word: ping',
  '⏺ API Error: Repeated 529 Overloaded errors. The API is at capacity — this is usually ' +
    'temporary. Try again in a moment.',
  '✻ Sautéed for 1s',
  '────────────────────────────────────────',
  '❯  ',
  '  ⏸ manual mode on · ? for shortcuts',
].join('\n');

/** The same session before the send: composer, no banner. */
const HEALTHY_FRAME = [
  ' ▐▛███▛█   Claude Code v2.1.236',
  '────────────────────────────────────────',
  '❯  ',
  '  ⏸ manual mode on · ? for shortcuts',
].join('\n');

const capture = () => buildCurrentOutput({} as Database.Database, 'wt-1', 'claude');

describe('capture payload exposes the upstream fault (Issue #1839)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isRunning.mockResolvedValue(true);
  });

  it('publishes the fault when the 529 banner is on the frame', async () => {
    vi.mocked(captureSessionOutput).mockResolvedValue(FAULTED_FRAME);

    const payload = await capture();

    expect(payload.upstreamFault).not.toBeNull();
    expect(payload.upstreamFault?.id).toBe('overloaded');
    expect(payload.upstreamFault?.matchedText).toContain('529 Overloaded');
    expect(payload.upstreamFault?.at).toBeGreaterThan(0);
  });

  it('publishes null — explicitly, as a key — when no signature matched', async () => {
    vi.mocked(captureSessionOutput).mockResolvedValue(HEALTHY_FRAME);

    const payload = await capture();

    expect(payload.upstreamFault).toBeNull();
    // A missing key would read as "this server is too old to know", which is a
    // different statement from "this server looked and found nothing".
    const serialized = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
    expect('upstreamFault' in serialized).toBe(true);
  });

  it('publishes null on a session that is not running', async () => {
    isRunning.mockResolvedValue(false);

    const payload = await capture();

    expect(payload.isRunning).toBe(false);
    expect(payload.upstreamFault).toBeNull();
  });

  it('reports the fault next to the very `ready` that misled wait', async () => {
    // The whole point: this is a payload a caller would otherwise read as a
    // completed turn. Both facts have to be on the same object.
    vi.mocked(captureSessionOutput).mockResolvedValue(FAULTED_FRAME);

    const payload = await capture();

    expect(payload.sessionStatus).toBe('ready');
    expect(payload.upstreamFault?.id).toBe('overloaded');
  });
});
