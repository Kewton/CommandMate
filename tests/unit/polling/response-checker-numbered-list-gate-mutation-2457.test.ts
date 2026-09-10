/**
 * The mutation control for Issue #2457's numbered-list gate.
 *
 * `response-checker-numbered-list-gate-2457.test.ts` asserts that a Claude reply
 * answering in a Markdown list is stored as a reply and that a half-written one
 * does not end the turn. Every one of those assertions would also pass against a
 * `response-checker` that had never learned to ask, if the corpus had quietly
 * stopped being a candidate — which is the vacuity §11 DR1-020 requires a
 * mutation to rule out.
 *
 * So this file takes the gate back out. `evaluateDialogPresence` is stubbed to
 * the answer it gave before the Issue — "yes, carry on" for everything — and the
 * assertions below are the OPPOSITE of the ones in the sibling suite: the false
 * prompt is stored, and the turn ends on a list claude is still typing. If a
 * refactor ever routes the save path around the gate, this file goes green in
 * the wrong direction and its sibling goes red; if the corpus stops
 * reproducing, BOTH go red.
 *
 * The stub replaces the gate module rather than the whole detection layer on
 * purpose: everything else — the parser, the extraction, the save path, the
 * dedup — is the shipping code, so the only difference between the two files is
 * the one decision under test.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const mockLogger = vi.hoisted(() => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn(),
  };
  logger.withContext.mockReturnValue(logger);
  return logger;
});
vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => mockLogger),
  generateRequestId: vi.fn(() => 'test-request-id'),
}));

// The mutation. `importOriginal` keeps every other export real — the Auto-Yes
// gate, the rollout table and the env var are all still the shipping ones, so
// nothing outside this one decision moves.
vi.mock('@/lib/polling/auto-yes-dialog-gate', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/polling/auto-yes-dialog-gate')>();
  return {
    ...actual,
    evaluateDialogPresence: () => ({
      present: true,
      dialog: null,
      mode: 'legacy' as const,
      gated: false,
    }),
  };
});

const captureSessionOutput = vi.fn<(...a: unknown[]) => Promise<string>>();
const isSessionRunning = vi.fn<(...a: unknown[]) => Promise<boolean>>();
vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutput: (...a: unknown[]) => captureSessionOutput(...a),
  isSessionRunning: (...a: unknown[]) => isSessionRunning(...a),
}));

const createMessage = vi.fn((_db: unknown, m: Record<string, unknown>) => ({ id: 'msg-1', ...m }));
vi.mock('@/lib/db', () => ({
  createMessage: (...a: [unknown, Record<string, unknown>]) => createMessage(...a),
  getSessionState: vi.fn(() => ({ lastCapturedLine: 0, inProgressMessageId: null })),
  updateSessionState: vi.fn(),
  getWorktreeById: () => ({ id: 'wt-2457m', name: 'wt-2457m' }),
  clearInProgressMessageId: vi.fn(),
  markPendingPromptsAsAnswered: vi.fn(() => 0),
}));

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => ({}) }));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
vi.mock('@/lib/conversation-logger', () => ({ recordClaudeConversation: vi.fn(async () => {}) }));
vi.mock('@/lib/realtime/terminal-broadcast', () => ({ broadcastTerminalSnapshot: vi.fn(async () => {}) }));
vi.mock('@/lib/push', () => ({ notifyPushSubscribers: vi.fn(async () => {}) }));

const applyEventToActiveTask = vi.fn();
vi.mock('@/lib/tasks/task-transition-service', () => ({
  applyEventToActiveTask: (...a: unknown[]) => applyEventToActiveTask(...a),
}));

import { checkForResponse, extractResponse } from '@/lib/polling/response-checker';
import { stopPolling } from '@/lib/polling/response-poller-core';
import { clearPromptDedupSkips } from '@/lib/polling/prompt-dedup-state';
import { clearWaitingEpisodes } from '@/lib/session/waiting-episode-state';
import { resetDetectPromptCache } from '@/lib/detection/prompt-detector';

const WT = 'wt-2457m';
const REPLIES = path.resolve(__dirname, '../../fixtures/claude-idle-numbered-list-2457');

function reply(name: string): string {
  return readFileSync(path.join(REPLIES, `${name}.txt`), 'utf8');
}

function savedMessageTypes(): string[] {
  return createMessage.mock.calls.map(([, m]) => String(m.messageType));
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPromptDedupSkips();
  clearWaitingEpisodes();
  resetDetectPromptCache();
  stopPolling(WT, 'claude');
  isSessionRunning.mockResolvedValue(true);
});

describe('[#2457] with the gate removed the defect comes straight back', () => {
  it.each([
    'reply-numbered-list-idle',
    'reply-numbered-list-taskpanel',
    'reply-numbered-list-composer-text',
    'reply-question-paragraph',
    'reply-quotes-dialog-wording',
  ])('%s is stored as a prompt again', async name => {
    captureSessionOutput.mockResolvedValue(reply(name));

    await checkForResponse(WT, 'claude');

    expect(savedMessageTypes()).toEqual(['prompt']);
  });

  it('raises the prompt task event on a reply', async () => {
    captureSessionOutput.mockResolvedValue(reply('reply-question-paragraph'));

    await checkForResponse(WT, 'claude');

    expect(applyEventToActiveTask.mock.calls.map(call => String(call[4]))).toContain('prompt_detected');
  });

  it('ends the turn on a list claude is still writing', async () => {
    // The early prompt check runs before the thinking test, so the ungated
    // extractor calls a half-written option 2 a finished turn.
    const result = extractResponse(reply('reply-numbered-list-generating-repaint'), 0, 'claude', 1000);

    expect(result?.isComplete).toBe(true);
    expect(result?.promptDetection?.isPrompt).toBe(true);
  });

  it('ends the turn on a frame captured before the footer was redrawn', () => {
    const result = extractResponse(reply('reply-numbered-list-repaint'), 0, 'claude', 1000);

    expect(result?.isComplete).toBe(true);
    expect(result?.promptDetection?.isPrompt).toBe(true);
  });

  it('leaves the parser-refused control alone in both directions', () => {
    // `reply-table` is not a candidate at all, so removing the gate changes
    // nothing about it — which is what makes it the control rather than a
    // frame the gate happens to be carrying.
    const result = extractResponse(reply('reply-table'), 0, 'claude', 1000);

    expect(result?.promptDetection).toBeUndefined();
  });
});
