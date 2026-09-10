/**
 * Issue #2457: a Claude reply that answers in a numbered list is not a prompt.
 *
 * ## What went wrong
 *
 * `buildDetectPromptOptions('claude')` returns `requireDefaultIndicator: false`,
 * so the generic parser can build a `multiple_choice` candidate out of rows with
 * no `❯` cursor on them at all — three Markdown list items under a line that
 * ends in `?` are enough. On a whole pane that candidate usually dies at the
 * composer barrier in `prompt-detect-multiple-choice.ts`. On the SAVE path it
 * does not: `checkForResponse` re-reads `result.response`, which is the
 * transcript with the chrome already cut off, so every positional guard the
 * frame provided is gone. The row went into `chat_messages` as
 * `messageType: 'prompt'` and the chat surface drew a tool-approval chip over an
 * ordinary answer.
 *
 * ## What this suite drives
 *
 * The real `extractResponse` and the real `checkForResponse`, through the real
 * parser and the real `detectDialog` — nothing between them is stubbed. A test
 * that called `evaluateDialogPresence` directly would stay green with the call
 * sites deleted, and the call sites are the entire Issue.
 *
 * Its companion,
 * `response-checker-numbered-list-gate-mutation-2457.test.ts`, is the same
 * frames with the gate stubbed back out. It asserts the OPPOSITE of every
 * expectation below, which is what makes these non-vacuous (§11 DR1-020).
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
  getWorktreeById: () => ({ id: 'wt-2457', name: 'wt-2457' }),
  clearInProgressMessageId: vi.fn(),
  markPendingPromptsAsAnswered: vi.fn(() => 0),
}));

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => ({}) }));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
vi.mock('@/lib/conversation-logger', () => ({ recordClaudeConversation: vi.fn(async () => {}) }));
vi.mock('@/lib/realtime/terminal-broadcast', () => ({ broadcastTerminalSnapshot: vi.fn(async () => {}) }));

const notifyPushSubscribers = vi.fn<(payload: { kind: string }) => Promise<void>>(async () => undefined);
vi.mock('@/lib/push', () => ({
  notifyPushSubscribers: (payload: unknown) => notifyPushSubscribers(payload as { kind: string }),
}));

const applyEventToActiveTask = vi.fn();
vi.mock('@/lib/tasks/task-transition-service', () => ({
  applyEventToActiveTask: (...a: unknown[]) => applyEventToActiveTask(...a),
}));

import { checkForResponse, extractResponse } from '@/lib/polling/response-checker';
import { stopPolling } from '@/lib/polling/response-poller-core';
import { getPromptDedupSkips, clearPromptDedupSkips } from '@/lib/polling/prompt-dedup-state';
import { getWaitingEpisode, clearWaitingEpisodes } from '@/lib/session/waiting-episode-state';
import { detectPrompt, resetDetectPromptCache } from '@/lib/detection/prompt-detector';
import { buildDetectPromptOptions, stripAnsi, stripBoxDrawing } from '@/lib/detection/cli-patterns';
import { AUTO_YES_DIALOG_GATE_ENV_VAR } from '@/lib/polling/auto-yes-dialog-gate';

const WT = 'wt-2457';

const REPLIES = path.resolve(__dirname, '../../fixtures/claude-idle-numbered-list-2457');
const DIALOGS = path.resolve(__dirname, '../lib/detection/fixtures/claude-live-1708');

function reply(name: string): string {
  return readFileSync(path.join(REPLIES, `${name}.txt`), 'utf8');
}

function dialog(name: string): string {
  return readFileSync(path.join(DIALOGS, `${name}.txt`), 'utf8');
}

/** What the generic parser says about a whole pane, before the gate. */
function frameCandidate(pane: string): string {
  const detection = detectPrompt(stripBoxDrawing(stripAnsi(pane)), buildDetectPromptOptions('claude'));
  return detection.isPrompt ? String(detection.promptData?.type) : 'none';
}

/** What it says about the extracted reply, which is what the save path re-reads. */
function responseCandidate(pane: string): string {
  const extracted = extractResponse(pane, 0, 'claude', 1000);
  if (!extracted) return 'none';
  const detection = detectPrompt(extracted.response, buildDetectPromptOptions('claude'));
  return detection.isPrompt ? String(detection.promptData?.type) : 'none';
}

function savedMessageTypes(): string[] {
  return createMessage.mock.calls.map(([, m]) => String(m.messageType));
}

function taskEvents(): string[] {
  return applyEventToActiveTask.mock.calls.map(call => String(call[4]));
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPromptDedupSkips();
  clearWaitingEpisodes();
  resetDetectPromptCache();
  stopPolling(WT, 'claude');
  isSessionRunning.mockResolvedValue(true);
  delete process.env[AUTO_YES_DIALOG_GATE_ENV_VAR];
});

afterEach(() => {
  delete process.env[AUTO_YES_DIALOG_GATE_ENV_VAR];
});

// ---------------------------------------------------------------------------
// The premise
// ---------------------------------------------------------------------------

describe('[#2457] the corpus really does reproduce the defect', () => {
  /**
   * The table in the fixture README, as an assertion.
   *
   * Without this, every expectation below could be satisfied by a corpus the
   * parser had quietly stopped flagging — the suite would go green because
   * nothing was ever a candidate, not because the gate refused one.
   */
  it.each([
    ['reply-numbered-list-idle', 'none', 'multiple_choice'],
    ['reply-numbered-list-taskpanel', 'none', 'multiple_choice'],
    ['reply-numbered-list-composer-text', 'none', 'multiple_choice'],
    ['reply-numbered-list-repaint', 'multiple_choice', 'multiple_choice'],
    ['reply-numbered-list-generating-repaint', 'multiple_choice', 'multiple_choice'],
    ['reply-question-paragraph', 'none', 'multiple_choice'],
    ['reply-quotes-dialog-wording', 'none', 'multiple_choice'],
    // The control: refused by the parser itself, so the gate is not what saves
    // this one and the suite says so.
    ['reply-table', 'none', 'none'],
  ])('%s: frame=%s response=%s', (name, onFrame, onResponse) => {
    expect(frameCandidate(reply(name))).toBe(onFrame);
    expect(responseCandidate(reply(name))).toBe(onResponse);
  });

  it('the live dialogs are candidates on the frame itself', () => {
    // The other half of the premise: these two must reach the gate, or the
    // "still saved" assertions below would be about frames nothing gated.
    expect(frameCandidate(dialog('bash-approval-taskpanel'))).toBe('multiple_choice');
    expect(frameCandidate(dialog('askuserquestion-submit-taskpanel'))).toBe('multiple_choice');
  });
});

// ---------------------------------------------------------------------------
// extractResponse
// ---------------------------------------------------------------------------

describe('[#2457] extractResponse does not end a turn on a numbered reply', () => {
  it('carries no prompt off an idle pane whose reply is a list', () => {
    const result = extractResponse(reply('reply-numbered-list-idle'), 0, 'claude', 1000);

    expect(result?.isComplete).toBe(true);
    expect(result?.promptDetection).toBeUndefined();
    // The reply itself survives — this is a save, not a suppression.
    expect(result?.response).toContain('検出層の gate を保存経路へつなぐ');
  });

  it('refuses the candidate on a frame captured before the footer was redrawn', () => {
    // `reply-numbered-list-repaint` is the one frame where the candidate reaches
    // extractResponse's own prompt site: with no composer row there is no
    // user-input barrier to stop the reverse scan.
    const result = extractResponse(reply('reply-numbered-list-repaint'), 0, 'claude', 1000);

    expect(result?.promptDetection).toBeUndefined();
    // No footer means no `hasSeparator`, so the ordinary reading says "not
    // finished" — the pane is re-captured 2 s later with its chrome back.
    expect(result?.isComplete).toBe(false);
  });

  it('does not complete a turn on a half-written list', () => {
    // The early prompt check runs BEFORE the thinking test, so a candidate
    // accepted there ends the turn while claude is still typing into it.
    const result = extractResponse(reply('reply-numbered-list-generating-repaint'), 0, 'claude', 1000);

    expect(result?.isComplete).toBe(false);
    expect(result?.promptDetection).toBeUndefined();
  });

  it('still carries the prompt off a real permission dialog', () => {
    const result = extractResponse(dialog('bash-approval-taskpanel'), 0, 'claude', 1000);

    expect(result?.isComplete).toBe(true);
    expect(result?.promptDetection?.isPrompt).toBe(true);
    expect(result?.promptDetection?.promptData?.type).toBe('multiple_choice');
  });

  it('still carries the prompt off the AskUserQuestion screen that has no footer', () => {
    const result = extractResponse(dialog('askuserquestion-submit-taskpanel'), 0, 'claude', 1000);

    expect(result?.promptDetection?.isPrompt).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// checkForResponse — the save path
// ---------------------------------------------------------------------------

describe('[#2457] checkForResponse saves a numbered reply as a reply', () => {
  it.each([
    'reply-numbered-list-idle',
    'reply-numbered-list-taskpanel',
    'reply-numbered-list-composer-text',
    'reply-question-paragraph',
    'reply-quotes-dialog-wording',
  ])('%s is stored as an assistant message, not a prompt', async name => {
    captureSessionOutput.mockResolvedValue(reply(name));

    expect(await checkForResponse(WT, 'claude')).toBe(true);
    expect(savedMessageTypes()).toEqual(['normal']);
    expect(createMessage.mock.calls[0][1].promptData).toBeUndefined();
  });

  it('raises none of a prompt\'s side effects', async () => {
    captureSessionOutput.mockResolvedValue(reply('reply-question-paragraph'));

    await checkForResponse(WT, 'claude');

    // No `prompt_detected` in the contract's task log …
    expect(taskEvents()).not.toContain('prompt_detected');
    // … no phone ringing for a wait that is not happening. The completion
    // notification the reply itself raises is a different `kind` and is exactly
    // what should still fire: a numbered answer is an answer.
    expect(notifyPushSubscribers.mock.calls.map(([payload]) => payload.kind)).toEqual(['completion']);
    // … no waiting episode for the WebSocket frame and the status API to
    // publish …
    expect(getWaitingEpisode(WT, 'claude', undefined)).toBeNull();
    // … and nothing in the prompt dedup, which only a saved prompt populates.
    expect(getPromptDedupSkips(WT, 'claude')).toEqual({ skippedCount: 0, lastSkippedAt: null });
  });

  it('keeps saving the reply when the same pane is polled again', async () => {
    // A refused candidate must not become a permanent silence either: the reply
    // is stored once and the content dedup suppresses the re-reads, exactly as
    // it does for a reply with no list in it.
    captureSessionOutput.mockResolvedValue(reply('reply-numbered-list-idle'));

    expect(await checkForResponse(WT, 'claude')).toBe(true);
    expect(await checkForResponse(WT, 'claude')).toBe(false);
    expect(savedMessageTypes()).toEqual(['normal']);
  });

  it('still saves a real permission dialog as a prompt', async () => {
    captureSessionOutput.mockResolvedValue(dialog('bash-approval-taskpanel'));

    expect(await checkForResponse(WT, 'claude')).toBe(true);
    expect(savedMessageTypes()).toEqual(['prompt']);
    expect(taskEvents()).toContain('prompt_detected');
  });

  it('still saves the footer-less AskUserQuestion confirmation as a prompt', async () => {
    captureSessionOutput.mockResolvedValue(dialog('askuserquestion-submit-taskpanel'));

    expect(await checkForResponse(WT, 'claude')).toBe(true);
    expect(savedMessageTypes()).toEqual(['prompt']);
  });

  it('saves nothing at all while the list is still being written', async () => {
    captureSessionOutput.mockResolvedValue(reply('reply-numbered-list-generating-repaint'));

    expect(await checkForResponse(WT, 'claude')).toBe(false);
    expect(savedMessageTypes()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The gate is not an Auto-Yes setting
// ---------------------------------------------------------------------------

describe('[#2457] the save gate is independent of Auto-Yes', () => {
  it('refuses the candidate with Auto-Yes off, which is the default here', async () => {
    // Nothing in this file ever enables Auto-Yes — `auto-yes-poller` is not even
    // imported. The assertion is the whole describe block above; this one names
    // it so the acceptance condition has a test of its own.
    captureSessionOutput.mockResolvedValue(reply('reply-numbered-list-idle'));

    await checkForResponse(WT, 'claude');

    expect(savedMessageTypes()).toEqual(['normal']);
  });

  it('is not widened by CM_AUTOYES_DIALOG_GATE', async () => {
    // The kill switch exists so an operator whose unattended pipeline stopped
    // answering prompts can undo the Auto-Yes gate without a redeploy. What
    // belongs in History is not a thing they are saying anything about, so the
    // save path must not read it — in either direction.
    process.env[AUTO_YES_DIALOG_GATE_ENV_VAR] = '*=legacy';
    captureSessionOutput.mockResolvedValue(reply('reply-numbered-list-idle'));

    await checkForResponse(WT, 'claude');

    expect(savedMessageTypes()).toEqual(['normal']);
  });
});
