/**
 * Tests for the shared user-message send service (Issue #1028).
 *
 * Verifies that sendUserMessage performs the full send + history-recording flow
 * (savePendingAssistantResponse -> orphan detection -> send -> createMessage ->
 * orphan delete -> updateLastUserMessage -> clearInProgressMessageId ->
 * startPolling) and preserves the image / copilot / model-command branches that
 * previously lived inline in POST /api/worktrees/[id]/send.
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
vi.mock('@/lib/polling/response-poller', () => ({
  startPolling: (...args: unknown[]) => mockStartPolling(...args),
}));

// Mock assistant response saver
const mockSavePendingAssistantResponse = vi.fn().mockResolvedValue(null);
vi.mock('@/lib/assistant-response-saver', () => ({
  savePendingAssistantResponse: (...args: unknown[]) => mockSavePendingAssistantResponse(...args),
}));

// Mock tmux (copilot direct-send path)
const mockSendKeys = vi.fn().mockResolvedValue(undefined);
const mockSendSpecialKeys = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/tmux/tmux', () => ({
  sendKeys: (...args: unknown[]) => mockSendKeys(...args),
  sendSpecialKeys: (...args: unknown[]) => mockSendSpecialKeys(...args),
}));

const mockInvalidateCache = vi.fn();
vi.mock('@/lib/tmux/tmux-capture-cache', () => ({
  invalidateCache: (...args: unknown[]) => mockInvalidateCache(...args),
}));

// Keep the copilot inter-key delay effectively instant
vi.mock('@/config/copilot-constants', () => ({
  COPILOT_SEND_ENTER_DELAY_MS: 0,
}));

// Import after mocking
import { sendUserMessage } from '@/lib/session/send-user-message';

// Minimal stand-in for the sqlite Database handle (all DB calls are mocked)
const mockDb = {} as never;

interface ToolMockOptions {
  sendMessage?: ReturnType<typeof vi.fn>;
  sendMessageWithImage?: ReturnType<typeof vi.fn>;
  supportsImage?: boolean;
  sendModelCommand?: ReturnType<typeof vi.fn>;
  getSessionName?: ReturnType<typeof vi.fn>;
}

function makeTool(opts: ToolMockOptions = {}) {
  return {
    name: 'Claude',
    sendMessage: opts.sendMessage ?? vi.fn().mockResolvedValue(undefined),
    sendMessageWithImage: opts.sendMessageWithImage ?? vi.fn().mockResolvedValue(undefined),
    supportsImage: opts.supportsImage !== undefined ? vi.fn(() => opts.supportsImage) : undefined,
    sendModelCommand: opts.sendModelCommand ?? vi.fn().mockResolvedValue(undefined),
    getSessionName: opts.getSessionName ?? vi.fn(() => 'session-name'),
  };
}

describe('sendUserMessage (Issue #1028)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetMessages.mockReturnValue([]);
    mockSavePendingAssistantResponse.mockResolvedValue(null);
    mockDeleteMessageById.mockReturnValue(true);
    mockCreateMessage.mockReturnValue({ id: 'created-msg', role: 'user', content: 'Hello' });
  });

  it('records a normal message in chat_messages and starts response polling', async () => {
    const tool = makeTool();
    mockGetTool.mockReturnValue(tool);

    const result = await sendUserMessage(mockDb, {
      worktreeId: 'wt-1',
      content: 'Hello',
      cliToolId: 'claude',
      instanceId: 'claude',
    });

    // Previous assistant response captured first
    expect(mockSavePendingAssistantResponse).toHaveBeenCalledWith(
      mockDb,
      'wt-1',
      'claude',
      expect.any(Date),
      'claude'
    );
    // Sent via the tool
    expect(tool.sendMessage).toHaveBeenCalledWith('wt-1', 'Hello', 'claude');
    // Recorded as a user message in history (default messageType 'normal')
    expect(mockCreateMessage).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({
        worktreeId: 'wt-1',
        role: 'user',
        content: 'Hello',
        messageType: 'normal',
        cliToolId: 'claude',
        instanceId: 'claude',
        timestamp: expect.any(Date),
      })
    );
    // Response polling started so the assistant reply is recorded too
    expect(mockStartPolling).toHaveBeenCalledWith('wt-1', 'claude', 'claude');
    expect(mockClearInProgressMessageId).toHaveBeenCalledWith(mockDb, 'wt-1', 'claude', 'claude');
    expect(mockUpdateLastUserMessage).toHaveBeenCalledWith(mockDb, 'wt-1', 'Hello', expect.any(Date));

    expect(result).toEqual({ ok: true, message: { id: 'created-msg', role: 'user', content: 'Hello' } });
  });

  it('honors an explicit messageType override', async () => {
    mockGetTool.mockReturnValue(makeTool());

    await sendUserMessage(mockDb, {
      worktreeId: 'wt-1',
      content: 'Hi',
      cliToolId: 'claude',
      messageType: 'prompt',
    });

    expect(mockCreateMessage).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({ messageType: 'prompt' })
    );
  });

  it('deletes an orphaned duplicate user message only after the new message is persisted (Issue #379)', async () => {
    mockGetTool.mockReturnValue(makeTool());
    mockGetMessages.mockReturnValue([{ id: 'orphan-1', role: 'user', content: 'Hello' }]);

    await sendUserMessage(mockDb, {
      worktreeId: 'wt-1',
      content: 'Hello',
      cliToolId: 'claude',
      instanceId: 'claude',
    });

    expect(mockDeleteMessageById).toHaveBeenCalledWith(mockDb, 'orphan-1');
    // Ordering: persist the new message before deleting the orphan
    const createOrder = mockCreateMessage.mock.invocationCallOrder[0];
    const deleteOrder = mockDeleteMessageById.mock.invocationCallOrder[0];
    expect(createOrder).toBeLessThan(deleteOrder);
  });

  it('does not delete the most recent message when it is not a matching duplicate', async () => {
    mockGetTool.mockReturnValue(makeTool());
    mockGetMessages.mockReturnValue([{ id: 'other', role: 'user', content: 'different text' }]);

    await sendUserMessage(mockDb, {
      worktreeId: 'wt-1',
      content: 'Hello',
      cliToolId: 'claude',
    });

    expect(mockDeleteMessageById).not.toHaveBeenCalled();
  });

  it('returns { ok: false, stage: "send" } and skips recording when the CLI send fails', async () => {
    const tool = makeTool({ sendMessage: vi.fn().mockRejectedValue(new Error('tmux session not found')) });
    mockGetTool.mockReturnValue(tool);

    const result = await sendUserMessage(mockDb, {
      worktreeId: 'wt-1',
      content: 'Hello',
      cliToolId: 'claude',
    });

    expect(result).toEqual({ ok: false, stage: 'send', error: 'tmux session not found' });
    expect(mockCreateMessage).not.toHaveBeenCalled();
    expect(mockStartPolling).not.toHaveBeenCalled();
  });

  it('sends the copilot /model command before the message and records history', async () => {
    const sendModelCommand = vi.fn().mockResolvedValue(undefined);
    const tool = makeTool({ sendModelCommand, getSessionName: vi.fn(() => 'copilot-session') });
    mockGetTool.mockReturnValue(tool);

    const result = await sendUserMessage(mockDb, {
      worktreeId: 'wt-1',
      content: 'do it',
      cliToolId: 'copilot',
      instanceId: 'copilot',
      copilotModel: 'gpt-5',
    });

    expect(sendModelCommand).toHaveBeenCalledWith('wt-1', 'gpt-5', 'copilot');
    // Copilot uses the direct sendKeys + separate Enter path (#559), not sendMessage
    expect(mockSendKeys).toHaveBeenCalledWith('copilot-session', 'do it', false);
    expect(mockSendSpecialKeys).toHaveBeenCalledWith('copilot-session', ['Enter']);
    expect(mockInvalidateCache).toHaveBeenCalledWith('copilot-session');
    expect(mockCreateMessage).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({ role: 'user', content: 'do it', cliToolId: 'copilot' })
    );
    expect(result).toMatchObject({ ok: true });
  });

  it('returns { ok: false, stage: "model" } and does not send when the /model command fails', async () => {
    const sendModelCommand = vi.fn().mockRejectedValue(new Error('model switch failed'));
    const tool = makeTool({ sendModelCommand, getSessionName: vi.fn(() => 'copilot-session') });
    mockGetTool.mockReturnValue(tool);

    const result = await sendUserMessage(mockDb, {
      worktreeId: 'wt-1',
      content: 'do it',
      cliToolId: 'copilot',
      copilotModel: 'gpt-5',
    });

    expect(result).toEqual({ ok: false, stage: 'model', error: 'model switch failed' });
    expect(mockSendKeys).not.toHaveBeenCalled();
    expect(mockCreateMessage).not.toHaveBeenCalled();
    expect(mockStartPolling).not.toHaveBeenCalled();
  });

  it('uses native image sending for image-capable tools', async () => {
    const sendMessageWithImage = vi.fn().mockResolvedValue(undefined);
    const tool = makeTool({ sendMessageWithImage, supportsImage: true });
    mockGetTool.mockReturnValue(tool);

    await sendUserMessage(mockDb, {
      worktreeId: 'wt-1',
      content: 'look at this',
      cliToolId: 'claude',
      instanceId: 'claude',
      absoluteImagePath: '/abs/.commandmate/attachments/img.png',
    });

    expect(sendMessageWithImage).toHaveBeenCalledWith(
      'wt-1',
      'look at this',
      '/abs/.commandmate/attachments/img.png',
      'claude'
    );
    expect(mockCreateMessage).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({ content: 'look at this' })
    );
  });

  it('falls back to embedding the image path for non-image-capable tools', async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const tool = makeTool({ sendMessage, supportsImage: false });
    mockGetTool.mockReturnValue(tool);

    await sendUserMessage(mockDb, {
      worktreeId: 'wt-1',
      content: 'look',
      cliToolId: 'claude',
      absoluteImagePath: '/abs/img.png',
    });

    expect(sendMessage).toHaveBeenCalledWith(
      'wt-1',
      'look\n\n[添付画像: /abs/img.png]',
      undefined
    );
  });
});
