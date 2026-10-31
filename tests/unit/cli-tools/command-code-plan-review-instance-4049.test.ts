/**
 * Issue #4049 (item 3): the plan review refusal of `send` names the real
 * worktree and, for a non-primary instance, ` --instance <id>`.
 *
 * Before #4049 it was a constant with a `<worktree-id>` placeholder and no
 * instance, so on `command-code-2` the `respond` it showed went to the primary.
 * Negative: the primary (no id, or the tool's own id — #868) gets no
 * `--instance`. The `not-sent (plan-review)` classification (#3772) is
 * unchanged. Fixtures are read, never written; tmux is mocked.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

vi.mock('@/lib/tmux/session-ownership', () => ({
  assertSessionNotForeign: vi.fn(async () => ({ verdict: 'owned', sessionPath: null })),
}));
vi.mock('@/lib/tmux/tmux', () => ({
  hasSession: vi.fn().mockResolvedValue(true),
  createSession: vi.fn().mockResolvedValue(undefined),
  sendKeys: vi.fn().mockResolvedValue(undefined),
  sendSpecialKey: vi.fn().mockResolvedValue(undefined),
  sendSpecialKeys: vi.fn().mockResolvedValue(undefined),
  killSession: vi.fn().mockResolvedValue(true),
  capturePane: vi.fn().mockResolvedValue(''),
  reconcileSessionGeometry: vi.fn().mockResolvedValue(false),
  exactTarget: (name: string) => `=${name}:`,
}));
vi.mock('@/lib/cli-tools/submit-verified-sender', () => ({
  sendMessageWithSubmitVerification: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/tmux/tmux-capture-cache', () => ({ invalidateCache: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { CommandCodeTool, commandCodePlanReviewSendMessage } from '@/lib/cli-tools/command-code';
import { classifySendFailure } from '@/lib/session/send-attempt-state';
import { capturePane } from '@/lib/tmux/tmux';

const FIXTURES = path.resolve(__dirname, '../../fixtures');
const read = (rel: string): string => fs.readFileSync(path.join(FIXTURES, rel), 'utf-8');

beforeEach(() => {
  vi.clearAllMocks();
});

async function refusal(instanceId?: string): Promise<unknown> {
  vi.mocked(capturePane).mockResolvedValue(read('command-code-plan-review-3125/plan-review-1-74-0-initial.txt'));
  return new CommandCodeTool().sendMessage('wt-4049', 'hello', instanceId).then(
    () => null,
    (e: unknown) => e,
  );
}

describe('[#4049] the plan review refusal names the worktree and the instance', () => {
  it('positive: command-code-2 — the real worktree id and `--instance command-code-2`', async () => {
    const error = await refusal('command-code-2');
    expect((error as Error).message).toContain(
      '`commandmate respond wt-4049 "<text>" --instance command-code-2`',
    );
    expect((error as Error).message).not.toContain('<worktree-id>');
    expect(classifySendFailure(error)).toEqual({ state: 'not-sent', reason: 'plan-review' });
  });

  it.each([undefined, 'command-code'])('negative: the primary (%s) — no `--instance`', async (instanceId) => {
    const error = await refusal(instanceId);
    expect((error as Error).message).toContain('`commandmate respond wt-4049 "<text>"`, then');
    expect((error as Error).message).not.toContain('--instance');
    expect(classifySendFailure(error)).toEqual({ state: 'not-sent', reason: 'plan-review' });
  });

  it('the function: the sentence for the primary is the old one with the worktree filled in', () => {
    expect(commandCodePlanReviewSendMessage('wt-4049')).toBe(
      'Command Code is showing a plan review (REVIEW), which takes review comments, not messages. ' +
        'Comment with `commandmate respond wt-4049 "<text>"`, then `--plan-review submit` (ctrl+r), ' +
        '`--plan-review approve` (ctrl+a) or `--plan-review cancel` (esc).',
    );
  });
});
