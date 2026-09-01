/**
 * `sendUserMessage`'s orphan cleanup: correct scope, and a frame that says it
 * happened (Issue #2219).
 *
 * Two defects, one code path.
 *
 * **The scope.** The #379 duplicate guard asks for "the newest row here" and
 * then deletes it if it repeats the text being sent. "Here" was
 * `getMessages(db, worktreeId, { limit: 1, cliToolId, instanceId })`, and that
 * filter is exclusive — instance *or* tool, never both. Every ordinary send
 * omits `instanceId` (the primary instance is implicit in the UI and in the send
 * API), so the query fell through to the tool filter and returned the newest row
 * of **any** instance of that tool. A re-send from `claude` whose text matched
 * `claude-2`'s last user row deleted `claude-2`'s row. That is data loss in
 * another session's history, and it is silent: the delete is best-effort and
 * logs one line.
 *
 * **The frame.** The delete had no wire representation at all. `message` /
 * `message_updated` can only say what a row now looks like, so a second device
 * kept rendering the removed row — next to the new one, i.e. the same sentence
 * twice — until its own poll, which #2195 demoted to a 15s fallback while a
 * socket is up.
 *
 * These tests pin the producer half: which scope the search asks for, and that
 * exactly one `messages_invalidated` goes out per actual deletion, carrying the
 * resolved instance the client matches against. The SQL half — that the scope
 * flag really does exclude a sibling instance and really does include a
 * pre-#868 `instance_id IS NULL` row — is pinned against a real database in
 * `tests/unit/db/get-messages-instance-scope-2219.test.ts` and end to end in
 * `tests/integration/send-user-message-orphan-scope-2219.test.ts`.
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
const mockGetMessages = vi.fn((..._args: unknown[]) => [] as unknown[]);
const mockDeleteMessageById = vi.fn((..._args: unknown[]) => true);
vi.mock('@/lib/db', () => ({
  createMessage: (...args: unknown[]) => mockCreateMessage(...args),
  updateLastUserMessage: vi.fn(),
  clearInProgressMessageId: vi.fn(),
  getMessages: (...args: unknown[]) => mockGetMessages(...args),
  deleteMessageById: (...args: unknown[]) => mockDeleteMessageById(...args),
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
import { MESSAGES_INVALIDATED_EVENT_TYPE } from '@/lib/realtime/types';

const mockDb = {} as never;

/** The frames `broadcastMessage` was called with, in order. */
function broadcastsOfType(type: string) {
  return mockBroadcastMessage.mock.calls
    .filter((call) => call[0] === type)
    .map((call) => call[1] as Record<string, unknown>);
}

describe('sendUserMessage orphan cleanup scope + notification (Issue #2219)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // `clearAllMocks` keeps implementations, and two tests below install a
    // throwing one — reset it so a leak cannot make a later test pass for the
    // wrong reason.
    mockBroadcastMessage.mockReset();
    mockGetTool.mockReturnValue({ sendMessage: vi.fn().mockResolvedValue(undefined) });
    mockGetMessages.mockReturnValue([]);
    mockDeleteMessageById.mockReturnValue(true);
    mockCreateMessage.mockImplementation((_db: unknown, msg: Record<string, unknown>) => ({
      id: 'new-row',
      ...msg,
      archived: false,
    }));
  });

  describe('the orphan search is scoped to one instance', () => {
    it('resolves an omitted instanceId to the primary instance instead of scanning the tool', async () => {
      // The whole defect in one assertion: with `instanceId` left off, the old
      // call passed `undefined` through and `getMessages` fell back to
      // `cli_tool_id = 'claude'`, i.e. every instance of the tool.
      await sendUserMessage(mockDb, {
        worktreeId: 'w-1',
        content: 'retry me',
        cliToolId: 'claude',
      });

      expect(mockGetMessages).toHaveBeenCalledTimes(1);
      const [, worktreeId, options] = mockGetMessages.mock.calls[0] as [
        unknown,
        string,
        Record<string, unknown>,
      ];
      expect(worktreeId).toBe('w-1');
      expect(options).toMatchObject({
        limit: 1,
        cliToolId: 'claude',
        instanceId: 'claude',
        // Without this the query would be a bare `instance_id = ?`, which hides
        // pre-#868 rows (NULL column, read back as the primary instance) and
        // would leave their duplicate on screen.
        matchResolvedInstance: true,
      });
    });

    it('keeps an explicit alias instance as the scope', async () => {
      await sendUserMessage(mockDb, {
        worktreeId: 'w-1',
        content: 'retry me',
        cliToolId: 'claude',
        instanceId: 'claude-2',
      });

      const [, , options] = mockGetMessages.mock.calls[0] as [
        unknown,
        string,
        Record<string, unknown>,
      ];
      expect(options).toMatchObject({
        cliToolId: 'claude',
        instanceId: 'claude-2',
        matchResolvedInstance: true,
      });
    });
  });

  describe('the deletion is announced', () => {
    it('emits one messages_invalidated for the resolved scope after a successful delete', async () => {
      mockGetMessages.mockReturnValue([{ id: 'orphan-1', role: 'user', content: 'retry me' }]);

      const result = await sendUserMessage(mockDb, {
        worktreeId: 'w-1',
        content: 'retry me',
        cliToolId: 'claude',
      });

      expect(result.ok).toBe(true);
      expect(mockDeleteMessageById).toHaveBeenCalledWith(mockDb, 'orphan-1');

      const frames = broadcastsOfType(MESSAGES_INVALIDATED_EVENT_TYPE);
      expect(frames).toHaveLength(1);
      expect(frames[0]).toEqual({
        worktreeId: 'w-1',
        cliToolId: 'claude',
        // Resolved, because `useSplitMessages` matches this against its own
        // pane's `instanceId ?? cliToolId`; `undefined` would never match.
        instanceId: 'claude',
        reason: 'orphan_cleanup',
      });
    });

    it('carries the alias instance when the send named one', async () => {
      mockGetMessages.mockReturnValue([{ id: 'orphan-2', role: 'user', content: 'retry me' }]);

      await sendUserMessage(mockDb, {
        worktreeId: 'w-1',
        content: 'retry me',
        cliToolId: 'codex',
        instanceId: 'codex-3',
      });

      expect(broadcastsOfType(MESSAGES_INVALIDATED_EVENT_TYPE)[0]).toMatchObject({
        cliToolId: 'codex',
        instanceId: 'codex-3',
      });
    });

    it('announces the delete after the new row, so a re-fetch sees the settled state', async () => {
      // Order matters on the wire as much as it does in the DB: the receiver
      // answers this frame with a GET, and a GET issued before the delete
      // committed would return the row it is meant to remove.
      mockGetMessages.mockReturnValue([{ id: 'orphan-1', role: 'user', content: 'retry me' }]);

      await sendUserMessage(mockDb, {
        worktreeId: 'w-1',
        content: 'retry me',
        cliToolId: 'claude',
      });

      const types = mockBroadcastMessage.mock.calls.map((call) => call[0] as string);
      expect(types).toEqual(['message', MESSAGES_INVALIDATED_EVENT_TYPE]);
      const deleteOrder = mockDeleteMessageById.mock.invocationCallOrder[0];
      const invalidateOrder = mockBroadcastMessage.mock.invocationCallOrder[1];
      expect(deleteOrder).toBeLessThan(invalidateOrder);
    });
  });

  describe('it stays silent when nothing was removed', () => {
    it('does not announce when the newest row is a different message', async () => {
      mockGetMessages.mockReturnValue([{ id: 'other', role: 'user', content: 'something else' }]);

      await sendUserMessage(mockDb, {
        worktreeId: 'w-1',
        content: 'retry me',
        cliToolId: 'claude',
      });

      expect(mockDeleteMessageById).not.toHaveBeenCalled();
      expect(broadcastsOfType(MESSAGES_INVALIDATED_EVENT_TYPE)).toHaveLength(0);
    });

    it('does not announce when the row was already gone (delete matched nothing)', async () => {
      // A concurrent re-send of the same text can take the row first. Telling
      // every pane to re-read for a delete this call did not perform is a GET
      // per racer for no change.
      mockGetMessages.mockReturnValue([{ id: 'orphan-1', role: 'user', content: 'retry me' }]);
      mockDeleteMessageById.mockReturnValue(false);

      await sendUserMessage(mockDb, {
        worktreeId: 'w-1',
        content: 'retry me',
        cliToolId: 'claude',
      });

      expect(broadcastsOfType(MESSAGES_INVALIDATED_EVENT_TYPE)).toHaveLength(0);
    });

    it('does not delete or announce when the CLI send failed', async () => {
      // `aaf497ca`'s intent: a failed send must not cost the operator the row
      // they already had. Nothing is written, so nothing is removed either.
      mockGetMessages.mockReturnValue([{ id: 'orphan-1', role: 'user', content: 'retry me' }]);
      mockGetTool.mockReturnValue({
        sendMessage: vi.fn().mockRejectedValue(new Error('tmux is gone')),
      });

      const result = await sendUserMessage(mockDb, {
        worktreeId: 'w-1',
        content: 'retry me',
        cliToolId: 'claude',
      });

      expect(result.ok).toBe(false);
      expect(mockCreateMessage).not.toHaveBeenCalled();
      expect(mockDeleteMessageById).not.toHaveBeenCalled();
      expect(mockBroadcastMessage).not.toHaveBeenCalled();
    });
  });

  describe('the notification never turns a completed send into a failure', () => {
    it('reports success when the invalidation broadcast throws', async () => {
      mockGetMessages.mockReturnValue([{ id: 'orphan-1', role: 'user', content: 'retry me' }]);
      mockBroadcastMessage.mockImplementation((type: string) => {
        if (type === MESSAGES_INVALIDATED_EVENT_TYPE) throw new Error('socket closed');
      });

      const result = await sendUserMessage(mockDb, {
        worktreeId: 'w-1',
        content: 'retry me',
        cliToolId: 'claude',
      });

      expect(result.ok).toBe(true);
      expect(mockDeleteMessageById).toHaveBeenCalledTimes(1);
    });

    it('still deletes the orphan when the row broadcast throws', async () => {
      mockGetMessages.mockReturnValue([{ id: 'orphan-1', role: 'user', content: 'retry me' }]);
      mockBroadcastMessage.mockImplementationOnce(() => {
        throw new Error('socket closed');
      });

      const result = await sendUserMessage(mockDb, {
        worktreeId: 'w-1',
        content: 'retry me',
        cliToolId: 'claude',
      });

      expect(result.ok).toBe(true);
      expect(mockDeleteMessageById).toHaveBeenCalledWith(mockDb, 'orphan-1');
      expect(broadcastsOfType(MESSAGES_INVALIDATED_EVENT_TYPE)).toHaveLength(1);
    });
  });
});
