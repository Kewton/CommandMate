/**
 * `sendUserMessage` broadcasts the user row it writes (Issue #2195).
 *
 * Every other history writer in the codebase already calls
 * `broadcastMessage('message', …)` right after its `createMessage` — the two
 * transcript readers, the screen scraper, the claude-done hook route, the
 * pending-response saver. This one did not, which is why a phone and a laptop
 * open on the same worktree disagreed about what had been sent until whichever
 * one had not sent it polled again. #2195 stretches that poll to 15s while a
 * socket is up, so the gap had to be closed in the same change.
 *
 * The assertions below are about *what the client needs to route the frame*:
 * the payload has to carry `cliToolId` and a resolved `instanceId`, because
 * `useSplitMessages` accepts a row only when both match its own pane. That is
 * not automatic — `createMessage` hands back the caller's object rather than
 * re-reading the stored row, so `instanceId` is whatever the caller passed,
 * `undefined` included.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn().mockReturnThis(),
  })),
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

vi.mock('@/lib/polling/response-poller', () => ({ startPolling: vi.fn() }));
vi.mock('@/lib/assistant-response-saver', () => ({
  savePendingAssistantResponse: vi.fn().mockResolvedValue(null),
}));

const mockBroadcastMessage = vi.fn();
vi.mock('@/lib/ws-server', () => ({
  broadcastMessage: (...args: unknown[]) => mockBroadcastMessage(...args),
}));

import { sendUserMessage } from '@/lib/session/send-user-message';

const mockDb = {} as never;

function toolThatAccepts() {
  return { sendMessage: vi.fn().mockResolvedValue(undefined) };
}

describe('sendUserMessage broadcasts the user row (Issue #2195)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetTool.mockReturnValue(toolThatAccepts());
    mockCreateMessage.mockImplementation((_db: unknown, msg: Record<string, unknown>) => ({
      id: 'user-row-1',
      ...msg,
      archived: false,
    }));
  });

  it("broadcasts 'message' with the created user row", async () => {
    const result = await sendUserMessage(mockDb, {
      worktreeId: 'w-1',
      content: 'hello there',
      cliToolId: 'codex',
      instanceId: 'codex-2',
    });

    expect(result.ok).toBe(true);
    expect(mockBroadcastMessage).toHaveBeenCalledTimes(1);
    const [type, payload] = mockBroadcastMessage.mock.calls[0] as [
      string,
      { worktreeId: string; message: Record<string, unknown> },
    ];
    expect(type).toBe('message');
    expect(payload.worktreeId).toBe('w-1');
    expect(payload.message).toMatchObject({
      id: 'user-row-1',
      role: 'user',
      content: 'hello there',
      cliToolId: 'codex',
      instanceId: 'codex-2',
    });
  });

  it('resolves instanceId to the primary instance when the caller omitted it', async () => {
    // Without this, the payload would carry `instanceId: undefined` and the
    // primary pane's (cliToolId, instanceId) match would reject its own row.
    await sendUserMessage(mockDb, {
      worktreeId: 'w-1',
      content: 'hello',
      cliToolId: 'claude',
    });

    const [, payload] = mockBroadcastMessage.mock.calls[0] as [
      string,
      { message: Record<string, unknown> },
    ];
    expect(payload.message.instanceId).toBe('claude');
    expect(payload.message.cliToolId).toBe('claude');
  });

  it('does not broadcast when the send to the CLI tool failed', async () => {
    // No row was written, so there is nothing to publish — and publishing a
    // message the user never actually sent would put it in every open pane.
    mockGetTool.mockReturnValue({
      sendMessage: vi.fn().mockRejectedValue(new Error('tmux is gone')),
    });

    const result = await sendUserMessage(mockDb, {
      worktreeId: 'w-1',
      content: 'hello',
      cliToolId: 'claude',
    });

    expect(result.ok).toBe(false);
    expect(mockCreateMessage).not.toHaveBeenCalled();
    expect(mockBroadcastMessage).not.toHaveBeenCalled();
  });

  it('still reports success when the broadcast throws', async () => {
    // The message has reached the terminal and the row is committed by the time
    // the socket is touched. A failed socket write is not a failed send.
    mockBroadcastMessage.mockImplementation(() => {
      throw new Error('socket closed');
    });

    const result = await sendUserMessage(mockDb, {
      worktreeId: 'w-1',
      content: 'hello',
      cliToolId: 'claude',
    });

    expect(result.ok).toBe(true);
    expect(mockCreateMessage).toHaveBeenCalledTimes(1);
  });
});
