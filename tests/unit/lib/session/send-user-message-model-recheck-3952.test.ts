/**
 * A copilot `--model` switch refused by the re-check right before `/model`
 * (Issue #3952) is recorded as what it was: a dialog is `prompt-waiting` (and
 * answered as the prompt guard's refusal), an unreadable pane `recheck-failed`.
 * Read by the error's `code`, never its wording: the switch's other errors
 * quote the pane's bottom row. Any other switch failure is
 * `model-switch-failed`, as before.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger (inline to avoid hoisting issues)
vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn().mockReturnThis(),
  })),
}));

// Mock DB layer
const mockCreateMessage = vi.fn();
const mockUpdateLastUserMessage = vi.fn();
const mockClearInProgressMessageId = vi.fn();
const mockGetMessages = vi.fn().mockReturnValue([]);
const mockDeleteMessageById = vi.fn().mockReturnValue(true);
vi.mock('@/lib/db', () => ({
  createMessage: (...args: unknown[]) => mockCreateMessage(...args),
  updateLastUserMessage: (...args: unknown[]) => mockUpdateLastUserMessage(...args),
  clearInProgressMessageId: (...args: unknown[]) => mockClearInProgressMessageId(...args),
  getMessages: (...args: unknown[]) => mockGetMessages(...args),
  deleteMessageById: (...args: unknown[]) => mockDeleteMessageById(...args),
}));

// Mock CLIToolManager
const mockGetTool = vi.fn();
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: vi.fn(() => ({
      getTool: (...args: unknown[]) => mockGetTool(...args),
    })),
  },
}));

// Mock polling
const mockStartPolling = vi.fn();
// Issue #2630: the poller registry, as `getActivePollers` reports it (keys are
// `<worktreeId>:<instanceId>`). Empty unless a test registers a chain.
const mockGetActivePollers = vi.fn((): string[] => []);
vi.mock('@/lib/polling/response-poller', () => ({
  startPolling: (...args: unknown[]) => mockStartPolling(...args),
  getActivePollers: () => mockGetActivePollers(),
}));

// Mock assistant response saver
const mockSavePendingAssistantResponse = vi.fn().mockResolvedValue(null);
vi.mock('@/lib/assistant-response-saver', () => ({
  savePendingAssistantResponse: (...args: unknown[]) => mockSavePendingAssistantResponse(...args),
}));

// Issue #1906: these exist only as negative controls. Nothing in
// send-user-message.ts imports them any more (the tmux import allowlist pins
// that), so any call here would mean the bypass came back.
const mockSendKeys = vi.fn().mockResolvedValue(undefined);
const mockSendSpecialKeys = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/tmux/tmux', () => ({
  sendKeys: (...args: unknown[]) => mockSendKeys(...args),
  sendSpecialKeys: (...args: unknown[]) => mockSendSpecialKeys(...args),
}));

// Issue #2865: the ownership check the timer / relay sends reach only through
// this service. Owned unless a case says otherwise.
const mockCheckWorktreeSessionOwnership = vi.fn();
vi.mock('@/lib/cli-tools/worktree-session-ownership', () => ({
  checkWorktreeSessionOwnership: (...args: unknown[]) => mockCheckWorktreeSessionOwnership(...args),
}));

const mockInvalidateCache = vi.fn();
vi.mock('@/lib/tmux/tmux-capture-cache', () => ({
  invalidateCache: (...args: unknown[]) => mockInvalidateCache(...args),
}));

import { sendUserMessage } from '@/lib/session/send-user-message';
import {
  INPUT_RECHECK_FAILED_CODE,
  INPUT_RECHECK_PROMPT_WAITING_CODE,
} from '@/lib/session/send-attempt-types';

const mockDb = {} as never;

function copilotTool(sendModelCommand: ReturnType<typeof vi.fn>) {
  return {
    name: 'Copilot',
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendMessageWithImage: vi.fn().mockResolvedValue(undefined),
    supportsImage: undefined,
    sendModelCommand,
    getSessionName: vi.fn(() => 'copilot-session'),
  };
}

const failure = (message: string, code?: string): Error =>
  Object.assign(new Error(message), code === undefined ? {} : { code });

async function sendWithModel(error: Error) {
  const tool = copilotTool(vi.fn().mockRejectedValue(error));
  mockGetTool.mockReturnValue(tool);
  const attempts: Array<{ state: string; reason: string }> = [];
  const result = await sendUserMessage(mockDb, {
    worktreeId: 'wt-1',
    content: 'do it',
    cliToolId: 'copilot',
    copilotModel: 'gpt-5',
    onAttempt: (attempt) => attempts.push(attempt),
  });
  return { result, attempts, tool };
}

describe('[#3952] the --model switch refused by the input re-check', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetMessages.mockReturnValue([]);
    mockCheckWorktreeSessionOwnership.mockResolvedValue({ verdict: 'owned', sessionPath: '/wt-1' });
  });

  it('a dialog by the time of /model: not-sent prompt-waiting, answered as the prompt guard does', async () => {
    const { result, attempts, tool } = await sendWithModel(
      failure(
        'Failed to switch Copilot model to gpt-5: A prompt dialog is open in session copilot-session ' +
          '(re-checked under the input lock); nothing was typed (Issue #3945).',
        INPUT_RECHECK_PROMPT_WAITING_CODE
      )
    );
    expect(result).toMatchObject({ ok: false, stage: 'prompt_waiting' });
    expect(attempts).toEqual([{ state: 'not-sent', reason: 'prompt-waiting' }]);
    expect(tool.sendMessage).not.toHaveBeenCalled();
  });

  it('an unreadable pane by then: not-sent recheck-failed', async () => {
    const { result, attempts, tool } = await sendWithModel(
      failure(
        'Failed to switch Copilot model to gpt-5: Could not re-read session copilot-session before typing ' +
          '(no server running); nothing was typed (Issue #3945).',
        INPUT_RECHECK_FAILED_CODE
      )
    );
    expect(result).toMatchObject({ ok: false, stage: 'model' });
    expect(attempts).toEqual([{ state: 'not-sent', reason: 'recheck-failed' }]);
    expect(tool.sendMessage).not.toHaveBeenCalled();
  });

  it('negative: the same wording without the code (a bottom row quoting it) stays model-switch-failed', async () => {
    const { result, attempts } = await sendWithModel(
      failure(
        'Failed to switch Copilot model to gpt-5: copilot did not become idle within 30000ms, so /model was not sent ' +
          '(bottom row: "A prompt dialog is open in session x (re-checked under the input lock); nothing was typed")'
      )
    );
    expect(result).toMatchObject({ ok: false, stage: 'model' });
    expect(attempts).toEqual([{ state: 'not-sent', reason: 'model-switch-failed' }]);
  });

  it.each([
    'copilot did not become idle within 30000ms, so /model was not sent',
    'copilot printed no answer to /model within 30000ms; the switch may still take effect, and nothing further was typed',
  ])('Issue #3954: the wording without a quoted screen stays model-switch-failed: %s', async (wording) => {
    const { result, attempts } = await sendWithModel(failure(`Failed to switch Copilot model to gpt-5: ${wording}`));
    expect(result).toMatchObject({ ok: false, stage: 'model' });
    expect(attempts).toEqual([{ state: 'not-sent', reason: 'model-switch-failed' }]);
  });
});
