/**
 * Issue #4049 (item 1), at the send service: the three PROMPT_WAITING refusals
 * of `sendUserMessage` (the guard, the copilot `/model` re-check and the
 * re-check under the input lock) name `respondAgent` — the tool an
 * `--agent`-only request named, set by the send route — through the same
 * `promptWaitingMessage`. Without it (the default, and every non-route caller)
 * the sentence is exactly as before.
 *
 * Nothing here touches the repository's files or tmux: the tool, the capture
 * and the DB are mocked.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn().mockReturnThis(),
  })),
}));

vi.mock('@/lib/cli-tools/worktree-session-ownership', () => ({
  checkWorktreeSessionOwnership: vi.fn(async () => ({ verdict: 'owned', sessionPath: null })),
}));

const mockIsPromptWaiting = vi.fn();
vi.mock('@/lib/session/prompt-waiting-guard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/session/prompt-waiting-guard')>()),
  isPromptWaiting: (...args: unknown[]) => mockIsPromptWaiting(...args),
}));

const mockCreateMessage = vi.fn();
vi.mock('@/lib/db', () => ({
  createMessage: (...args: unknown[]) => mockCreateMessage(...args),
  updateLastUserMessage: vi.fn(),
  clearInProgressMessageId: vi.fn(),
  getMessages: vi.fn(() => []),
  deleteMessageById: vi.fn(() => true),
}));

const mockGetTool = vi.fn();
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: vi.fn(() => ({ getTool: (...args: unknown[]) => mockGetTool(...args) })),
  },
}));

vi.mock('@/lib/polling/response-poller', () => ({ startPolling: vi.fn(), getActivePollers: () => [] }));
vi.mock('@/lib/assistant-response-saver', () => ({
  savePendingAssistantResponse: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));

const mockCaptureFresh = vi.fn();
vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutputFresh: (...args: unknown[]) => mockCaptureFresh(...args),
  captureSessionOutput: vi.fn(),
}));

const mockExtractComposerText = vi.fn();
vi.mock('@/lib/detection/composer-text', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/detection/composer-text')>()),
  extractComposerText: (...args: unknown[]) => mockExtractComposerText(...args),
}));

import { sendUserMessage } from '@/lib/session/send-user-message';
import { clearSendAttempts } from '@/lib/session/send-attempt-state';
import { INPUT_RECHECK_PROMPT_WAITING_CODE } from '@/lib/session/send-attempt-types';

const mockDb = {} as never;

function tool(overrides: Record<string, unknown> = {}) {
  return { name: 'Tool', sendMessage: vi.fn(), sendMessageWithImage: vi.fn(), sendModelCommand: vi.fn(), ...overrides };
}

const RESPOND_CODEX = '`commandmate respond wt-1 <answer> --agent codex`';
const RESPOND_BARE = 'Answer the prompt first: `commandmate respond wt-1 <answer>`.';

beforeEach(() => {
  vi.clearAllMocks();
  clearSendAttempts();
  mockIsPromptWaiting.mockResolvedValue({ waiting: false });
  mockCreateMessage.mockImplementation((_db: unknown, msg: Record<string, unknown>) => ({ id: 'row-1', ...msg }));
  mockCaptureFresh.mockResolvedValue('raw frame');
  mockExtractComposerText.mockReturnValue({ text: '', state: 'empty' });
});

afterEach(() => {
  vi.restoreAllMocks();
  clearSendAttempts();
});

type Refusal = [string, (respondAgent?: 'codex' | 'copilot') => Promise<unknown>];

const REFUSALS: Refusal[] = [
  [
    'the prompt guard (structured)',
    (respondAgent) => {
      mockIsPromptWaiting.mockResolvedValue({ waiting: true, blockedBy: 'structured', reason: 'hook_permission_prompt' });
      mockGetTool.mockReturnValue(tool());
      return sendUserMessage(mockDb, { worktreeId: 'wt-1', content: 'hello', cliToolId: 'codex', respondAgent });
    },
  ],
  [
    'the re-check under the input lock',
    (respondAgent) => {
      const refused = new Error(
        'Failed to send message to Codex: Session x is waiting on a prompt (re-checked under the input lock); nothing was typed',
      );
      mockGetTool.mockReturnValue(tool({ sendMessage: vi.fn().mockRejectedValue(refused) }));
      return sendUserMessage(mockDb, { worktreeId: 'wt-1', content: 'hello', cliToolId: 'codex', respondAgent });
    },
  ],
  [
    'the copilot /model re-check',
    (respondAgent) => {
      const refused = Object.assign(new Error('re-check refused /model'), { code: INPUT_RECHECK_PROMPT_WAITING_CODE });
      mockGetTool.mockReturnValue(tool({ sendModelCommand: vi.fn().mockRejectedValue(refused) }));
      return sendUserMessage(mockDb, {
        worktreeId: 'wt-1',
        content: 'hello',
        cliToolId: 'copilot',
        copilotModel: 'gpt-5',
        respondAgent: respondAgent === undefined ? undefined : 'codex',
      });
    },
  ],
];

describe('[#4049] sendUserMessage: the PROMPT_WAITING refusals name the requested tool', () => {
  it.each(REFUSALS)('positive: %s — `--agent codex`', async (_name, refuse) => {
    const result = await refuse('codex');
    expect(result).toMatchObject({ ok: false, stage: 'prompt_waiting' });
    expect((result as { error: string }).error).toContain(RESPOND_CODEX);
  });

  it.each(REFUSALS)('negative: %s — no respondAgent, the sentence as before', async (_name, refuse) => {
    const result = await refuse(undefined);
    expect(result).toMatchObject({ ok: false, stage: 'prompt_waiting' });
    const error = (result as { error: string }).error;
    expect(error).toContain(RESPOND_BARE);
    expect(error).not.toContain('--agent');
  });
});
