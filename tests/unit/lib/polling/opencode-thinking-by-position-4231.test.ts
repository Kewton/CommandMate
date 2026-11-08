/**
 * Issue #4231: opencode's `Thinking:` is read by position in the Auto-Yes Enter
 * fallback judge and in the response checker's "working is visible" sweep, not as a
 * word in the tail (the footer's cwd, e.g. `/tmp/Thinking:demo`, holds the word).
 *
 * @vitest-environment node
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

vi.mock('@/lib/polling/auto-yes-dialog-gate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/polling/auto-yes-dialog-gate')>();
  return {
    ...actual,
    assessPromptAnswerability: () => ({ refusal: { reason: actual.UNSUPPORTED_DIALOG_LAYOUT_REASON } }),
  };
});
vi.mock('@/lib/detection/composer-text', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/detection/composer-text')>();
  return { ...actual, extractComposerText: () => ({ state: 'no_composer', text: '' }) };
});
vi.mock('@/lib/detection/tool-liveness', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/detection/tool-liveness')>();
  return { ...actual, judgeToolLiveness: () => ({ alive: true }) };
});

const captureSessionOutput = vi.fn<(...a: unknown[]) => Promise<string>>();
const isSessionRunning = vi.fn<(...a: unknown[]) => Promise<boolean>>();
vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutput: (...a: unknown[]) => captureSessionOutput(...a),
  isSessionRunning: (...a: unknown[]) => isSessionRunning(...a),
}));
const markPendingPromptsAsAnswered = vi.fn(() => 0);
vi.mock('@/lib/db', () => ({
  createMessage: vi.fn((_db: unknown, m: Record<string, unknown>) => ({ id: 'msg-1', ...m })),
  getSessionState: vi.fn(() => ({ lastCapturedLine: 0, inProgressMessageId: null })),
  updateSessionState: vi.fn(),
  getWorktreeById: vi.fn(() => ({ id: 'wt-4231', name: 'wt-4231' })),
  clearInProgressMessageId: vi.fn(),
  markPendingPromptsAsAnswered: (...a: unknown[]) => markPendingPromptsAsAnswered(...(a as [])),
}));
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => ({}) }));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
vi.mock('@/lib/push', () => ({ notifyPushSubscribers: vi.fn(async () => {}) }));
vi.mock('@/lib/conversation-logger', () => ({ recordClaudeConversation: vi.fn(async () => {}) }));
vi.mock('@/lib/realtime/terminal-broadcast', () => ({ broadcastTerminalSnapshot: vi.fn(async () => {}) }));

import { judgeEnterFallback } from '@/lib/polling/auto-yes-enter-fallback';
import { checkForResponse } from '@/lib/polling/response-checker';
import { stopPolling } from '@/lib/polling/response-poller-core';

const fixture = (name: string): string =>
  readFileSync(path.resolve(__dirname, '../../../fixtures', name), 'utf8');

/** Measured finished frame with the footer's cwd rewritten to hold `Thinking:`. */
const DONE_CWD = fixture('opencode-live-4231/turn-done-cwd-thinking.txt');
/** The same measured frame with the original cwd (control). */
const DONE_ORIGINAL = fixture('opencode-live-4134/turn-done-subsecond.txt');

/** The progress row opencode draws under the composer's border while a turn runs. */
function withProgressRowBelowBorder(raw: string): string {
  const lines = raw.split('\n');
  let border = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (/╹.*▀▀▀/.test(lines[i])) { border = i; break; }
  expect(border).toBeGreaterThan(0);
  lines.splice(border + 1, 0, '   ⠦ Thinking: Crafting…');
  return lines.join('\n');
}

const ENABLED = { NODE_ENV: 'test', CM_AUTOYES_ENTER_FALLBACK: 'opencode=enabled' } as NodeJS.ProcessEnv;

describe('judgeEnterFallback reads opencode Thinking: by position (#4231)', () => {
  it('positive: a cwd holding "Thinking:" is not thinking', () => {
    expect(judgeEnterFallback('opencode', DONE_CWD, ENABLED)).toMatchObject({ eligible: true });
  });

  it('control: the original frame is not thinking either', () => {
    expect(judgeEnterFallback('opencode', DONE_ORIGINAL, ENABLED)).toMatchObject({ eligible: true });
  });

  it('negative: a progress row under the border is still thinking', () => {
    expect(judgeEnterFallback('opencode', withProgressRowBelowBorder(DONE_CWD), ENABLED)).toMatchObject({
      eligible: false,
      reason: 'thinking',
    });
  });
});

describe('response checker sweep reads opencode Thinking: by position (#4231)', () => {
  const WT = 'wt-4231';
  /** An unfinished turn (no `▣` marker) so the checker takes the "not complete" branch. */
  const unfinished = (raw: string): string => raw.replace(/^.*▣.*$/m, '  partial reply');

  beforeEach(() => {
    vi.clearAllMocks();
    stopPolling(WT, 'opencode');
    isSessionRunning.mockResolvedValue(true);
  });

  it('positive: a cwd holding "Thinking:" does not mark prompts answered', async () => {
    captureSessionOutput.mockResolvedValue(unfinished(DONE_CWD));
    await checkForResponse(WT, 'opencode');
    expect(markPendingPromptsAsAnswered).not.toHaveBeenCalled();
  });

  it('negative: a progress row under the border still does', async () => {
    captureSessionOutput.mockResolvedValue(withProgressRowBelowBorder(unfinished(DONE_CWD)));
    await checkForResponse(WT, 'opencode');
    expect(markPendingPromptsAsAnswered).toHaveBeenCalled();
  });
});
