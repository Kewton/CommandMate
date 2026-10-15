/**
 * Issue #3707: a cancel that succeeds while executeTimer awaits isRunning()
 * must not be overwritten by 'sending' (and the message must not be sent).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    withContext: vi.fn().mockReturnThis(),
  })),
}));

let db: Database.Database;
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => db }));

let releaseIsRunning: (v: boolean) => void = () => {};
const mockIsRunning = vi.fn();
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({ getTool: () => ({ isRunning: mockIsRunning }) }),
  },
}));

const mockSendUserMessage = vi.fn().mockResolvedValue({ ok: true, message: { id: 'm' } });
vi.mock('@/lib/session/send-user-message', () => ({
  sendUserMessage: (...a: unknown[]) => mockSendUserMessage(...a),
}));

import { scheduleTimer, stopAllTimers } from '@/lib/timer-manager';
import { createTimer, cancelTimer, getTimerById } from '@/lib/db/timer-db';

function statusOf(id: string): string | undefined {
  return getTimerById(db, id)?.status;
}

describe('timer-manager cancel race (#3707)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    db = new Database(':memory:');
    db.exec(`CREATE TABLE timer_messages (
      id TEXT PRIMARY KEY, worktree_id TEXT NOT NULL, cli_tool_id TEXT NOT NULL,
      instance_id TEXT, message TEXT NOT NULL, delay_ms INTEGER NOT NULL,
      scheduled_send_time INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL, sent_at INTEGER, error TEXT)`);
    mockSendUserMessage.mockClear();
    mockIsRunning.mockReset();
  });

  afterEach(() => {
    stopAllTimers();
    vi.useRealTimers();
    db.close();
  });

  function setup(): string {
    const t = createTimer(db, { worktreeId: 'wt', cliToolId: 'claude', message: 'hi', delayMs: 1000 });
    mockIsRunning.mockImplementation(
      () => new Promise<boolean>((r) => { releaseIsRunning = r; })
    );
    scheduleTimer(t.id, 'wt', 1000);
    return t.id;
  }

  it('positive: cancel during the isRunning wait -> not sent, stays cancelled', async () => {
    const id = setup();
    await vi.advanceTimersByTimeAsync(1000);
    expect(cancelTimer(db, id)).toBe(true);
    releaseIsRunning(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(mockSendUserMessage).not.toHaveBeenCalled();
    expect(statusOf(id)).toBe('cancelled');
  });

  it('positive: cancel during the wait with no session stays cancelled (not no_session)', async () => {
    const id = setup();
    await vi.advanceTimersByTimeAsync(1000);
    cancelTimer(db, id);
    releaseIsRunning(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(statusOf(id)).toBe('cancelled');
  });

  it('negative: no cancel -> sent as before', async () => {
    const id = setup();
    await vi.advanceTimersByTimeAsync(1000);
    releaseIsRunning(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(mockSendUserMessage).toHaveBeenCalledTimes(1);
    expect(statusOf(id)).toBe('sent');
  });

  it('negative: cancel after sending started is still rejected', async () => {
    const id = setup();
    await vi.advanceTimersByTimeAsync(1000);
    mockSendUserMessage.mockImplementationOnce(() => new Promise(() => {}));
    releaseIsRunning(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(statusOf(id)).toBe('sending');
    expect(cancelTimer(db, id)).toBe(false);
    expect(statusOf(id)).toBe('sending');
  });
});
