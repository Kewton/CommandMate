/**
 * The gate is where a relay learns a turn ended (Issue #2377).
 *
 * The announcement is made HERE and not in the two callers because this is the
 * single point both of them pass through — the poller's save path and the Stop
 * hook receiver (#2246) — and a relay that had to be told twice would either be
 * told twice or, once somebody added a third trigger, not at all.
 *
 * Three properties, and each is written so the obvious wrong version fails:
 *
 *  - it announces when a capture actually WROTE something;
 *  - it stays silent when the capture answered false, because then the scraper
 *    is still the writer for this turn and the poller announces it itself;
 *  - it announces `settled: true`, which is what tells the delivery it may skip
 *    the quiet window.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const onRelayTurnCompleted = vi.fn();

vi.mock('@/lib/relay/relay-triggers', () => ({
  onRelayTurnCompleted: (...args: unknown[]) => onRelayTurnCompleted(...args),
}));
vi.mock('@/lib/hooks/sources/opencode/subscription', () => ({
  isOpencodeStructuredHistoryLive: vi.fn(() => false),
}));
vi.mock('@/lib/hooks/sources/claude/history', () => ({
  captureClaudeTranscriptTurn: vi.fn(async () => true),
  resolveClaudeTranscriptPath: vi.fn(async () => '/transcripts/claude.jsonl'),
}));
vi.mock('@/lib/hooks/sources/codex/history', () => ({
  captureCodexTranscriptTurn: vi.fn(async () => false),
  resolveCodexTranscriptPath: vi.fn(async () => null),
}));
vi.mock('@/lib/hooks/sources/antigravity/history', () => ({
  captureAntigravityTranscriptTurn: vi.fn(async () => false),
  resolveAntigravityTranscriptPath: vi.fn(async () => null),
}));
vi.mock('@/lib/hooks/sources/command-code/history', () => ({
  captureCommandCodeTranscriptTurn: vi.fn(async () => false),
  resolveCommandCodeTranscriptPath: vi.fn(async () => null),
}));

import { captureClaudeTranscriptTurn } from '@/lib/hooks/sources/claude/history';
import {
  captureStructuredHistoryTurn,
  resetStructuredHistoryCaptureQueue,
} from '@/lib/polling/structured-history-gate';

const CAPTURE = { worktreePath: '/repos/wt-2377', transcriptPathHint: null } as const;

beforeEach(() => {
  vi.clearAllMocks();
  resetStructuredHistoryCaptureQueue();
  vi.mocked(captureClaudeTranscriptTurn).mockResolvedValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the relay announcement', () => {
  it('fires when the transcript reader wrote the turn', async () => {
    await captureStructuredHistoryTurn('wt-2377', 'claude', 'claude', CAPTURE);

    expect(onRelayTurnCompleted).toHaveBeenCalledTimes(1);
    expect(onRelayTurnCompleted).toHaveBeenCalledWith('wt-2377', 'claude', 'claude', true);
  });

  it('does not fire when the capture wrote nothing', async () => {
    vi.mocked(captureClaudeTranscriptTurn).mockResolvedValue(false);

    await captureStructuredHistoryTurn('wt-2377', 'claude', 'claude', CAPTURE);

    expect(onRelayTurnCompleted).not.toHaveBeenCalled();
  });

  it('does not fire for a tool that keeps no transcript', async () => {
    await captureStructuredHistoryTurn('wt-2377', 'copilot', 'copilot', CAPTURE);

    expect(onRelayTurnCompleted).not.toHaveBeenCalled();
  });

  it('resolves the instance the way every other reader does', async () => {
    // An omitted instance is the PRIMARY one, whose id is the tool's id (#868).
    await captureStructuredHistoryTurn('wt-2377', 'claude', undefined, CAPTURE);

    expect(onRelayTurnCompleted).toHaveBeenCalledWith('wt-2377', 'claude', 'claude', true);
  });

  it('names a secondary instance as itself', async () => {
    await captureStructuredHistoryTurn('wt-2377', 'claude', 'claude-2', CAPTURE);

    expect(onRelayTurnCompleted).toHaveBeenCalledWith('wt-2377', 'claude', 'claude-2', true);
  });

  it('does not fire when the reader threw', async () => {
    vi.mocked(captureClaudeTranscriptTurn).mockRejectedValue(new Error('unreadable'));

    await expect(
      captureStructuredHistoryTurn('wt-2377', 'claude', 'claude', CAPTURE)
    ).resolves.toBe(false);
    expect(onRelayTurnCompleted).not.toHaveBeenCalled();
  });
});
