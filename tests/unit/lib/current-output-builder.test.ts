/** @vitest-environment node */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { buildClaude1000RowPermissionFrame } from '../../fixtures/claude-1000-row-prompt';

vi.mock('@/lib/db', () => ({ getSessionState: vi.fn(() => null) }));
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({
      getTool: () => ({ isRunning: vi.fn().mockResolvedValue(true) }),
    }),
  },
}));
vi.mock('@/lib/session/cli-session', () => ({ captureSessionOutput: vi.fn() }));
vi.mock('@/lib/polling/auto-yes-manager', () => ({
  getAutoYesState: vi.fn(() => undefined),
  getLastServerResponseTimestamp: vi.fn(() => null),
  isPollerActive: vi.fn(() => true),
  buildCompositeKey: vi.fn(() => 'wt-1:claude'),
}));

import { captureSessionOutput } from '@/lib/session/cli-session';
import { getLastServerResponseTimestamp } from '@/lib/polling/auto-yes-manager';
import { buildCurrentOutput } from '@/lib/session/current-output-builder';
import { buildClaudeHelpOverlayFrame } from '../../fixtures/claude-help-overlay';

describe('buildCurrentOutput Issue #1167 frame', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(captureSessionOutput).mockResolvedValue(buildClaude1000RowPermissionFrame());
  });

  it('surfaces prompt data and never exposes the unclassified fallback', async () => {
    const payload = await buildCurrentOutput(
      {} as Database.Database,
      'wt-1',
      'claude',
      'claude-2',
    );

    expect(payload.isPromptWaiting).toBe(true);
    expect(payload.promptData?.type).toBe('multiple_choice');
    expect(payload.sessionStatus).toBe('waiting');
    expect(payload.sessionStatusReason).toBe('prompt_detected');
    expect(payload.isUnclassifiedActive).toBe(false);
  });
});

describe('buildCurrentOutput Issue #1497 no_recent_output degrade', () => {
  // The stale timestamp is the value the Auto-Yes poller stamps into
  // lastServerResponseTimestamp (auto-yes-poller.ts). Older than
  // STALE_OUTPUT_THRESHOLD_MS (5s) so the time-based heuristic fires.
  const staleTimestamp = Date.now() - 60_000;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getLastServerResponseTimestamp).mockReturnValue(staleTimestamp);
  });

  it('keeps the nav hatch gated open for a static /help overlay that degraded to ready/no_recent_output', async () => {
    // A real unclassified TUI overlay that stopped changing: detection falls
    // through to the time heuristic and, with a stale timestamp, degrades to
    // ready/no_recent_output — the frame that used to hide the nav hatch (#1017).
    vi.mocked(captureSessionOutput).mockResolvedValue(buildClaudeHelpOverlayFrame());

    const payload = await buildCurrentOutput(
      {} as Database.Database,
      'wt-1',
      'claude',
      'claude-2',
    );

    expect(payload.sessionStatus).toBe('ready');
    expect(payload.sessionStatusReason).toBe('no_recent_output');
    // The fix: the timed-out unclassified frame still gates the hatch open.
    expect(payload.isUnclassifiedActive).toBe(true);
  });

  it('does NOT gate the hatch open at a true idle input prompt even with a stale timestamp (non-regression)', async () => {
    // A genuine idle prompt (`❯`) is classified as input_prompt at step 3,
    // before the time heuristic — so it must stay ready/input_prompt and the
    // hatch must remain hidden (Enter/`q` can never reach the composer).
    vi.mocked(captureSessionOutput).mockResolvedValue('Some previous output\n───\n❯\n');

    const payload = await buildCurrentOutput(
      {} as Database.Database,
      'wt-1',
      'claude',
      'claude-2',
    );

    expect(payload.sessionStatus).toBe('ready');
    expect(payload.sessionStatusReason).toBe('input_prompt');
    expect(payload.isUnclassifiedActive).toBe(false);
  });
});
