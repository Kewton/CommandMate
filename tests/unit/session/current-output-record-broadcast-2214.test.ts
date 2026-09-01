/**
 * The two history rows `buildCurrentOutput` writes reach open panes over the
 * socket (Issue #2214).
 *
 * Both are *records*, not questions anyone answers: #1708's "the detection layer
 * could not read this frame" row and #1725's "the agent said a dialog is open
 * and the scraper is blind" row. Nobody is blocked on them, which is why #2214
 * ranks them below the Auto-Yes audit row — but they are the audit trail
 * `capture --prompts` and the history pane print, and until now they appeared
 * only on the next history poll, which #2195 stretched to 15 s while a socket
 * is up.
 *
 * The assertions are on the event type and the payload directly. A
 * "does the client render one card or two" test cannot tell `message` from
 * `message_updated` — `useSplitMessages` upserts both by ID — so it would be
 * green whatever this producer passed.
 *
 * @vitest-environment node
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { ChatMessage } from '@/types/models';

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn().mockReturnThis(),
  },
}));
vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => mockLogger),
  generateRequestId: vi.fn(() => 'test-request-id'),
}));

let createMessageFailure: Error | null = null;
const createMessage = vi.fn((_db: unknown, row: Record<string, unknown>) => {
  if (createMessageFailure) throw createMessageFailure;
  return { id: 'row-2214', ...row, archived: false };
});
vi.mock('@/lib/db', () => ({
  getSessionState: vi.fn(() => null),
  createMessage: (...args: unknown[]) =>
    createMessage(args[0], args[1] as Record<string, unknown>),
}));

const isRunning = vi.fn().mockResolvedValue(true);
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({ getTool: () => ({ isRunning: (...a: unknown[]) => isRunning(...a) }) }),
  },
}));
vi.mock('@/lib/session/cli-session', () => ({ captureSessionOutput: vi.fn() }));
vi.mock('@/lib/polling/auto-yes-manager', () => ({
  getAutoYesState: vi.fn(() => undefined),
  getLastServerResponseTimestamp: vi.fn(() => null),
  isPollerActive: vi.fn(() => true),
  buildCompositeKey: vi.fn(() => 'wt-2214:claude:claude'),
}));

/**
 * The dwell tracker, driven directly.
 *
 * #1708's row is written once per unbroken run at 60 s of dwell; reproducing
 * that through the real tracker would mean a fake clock and several polls to
 * assert one broadcast. The verdict is the only thing the recorder reads, so it
 * is the thing this file sets. Partial mock on purpose — the module's other
 * exports stay real for anything else in the graph that reads them.
 */
let unclassifiedVerdict = { shouldRecord: false, dwellMs: 0 };
vi.mock('@/lib/detection/unclassified-frame-tracker', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/detection/unclassified-frame-tracker')>()),
  observeUnclassifiedFrame: () => unclassifiedVerdict,
}));

const broadcastMessage = vi.fn();
vi.mock('@/lib/ws-server', () => ({
  broadcastMessage: (...args: unknown[]) => broadcastMessage(...args),
}));

import { captureSessionOutput } from '@/lib/session/cli-session';
import { buildCurrentOutput } from '@/lib/session/current-output-builder';
import { clearAgentStopEvents, recordAgentEvent } from '@/lib/session/agent-event-state';
import { UNCLASSIFIED_PROMPT_TYPE } from '@/types/models';

const db = {} as Database.Database;

/** A frame the scraper reads as `running`/`default` — no prompt in it at all. */
const BUSY_FRAME = 'writing files\nediting src/app/page.tsx\n';

function build() {
  return buildCurrentOutput(db, 'wt-2214', 'claude', 'claude-2');
}

/** The `(type, payload)` pairs published so far. */
function pushes(): Array<[string, { worktreeId: string; message: ChatMessage }]> {
  return broadcastMessage.mock.calls as Array<
    [string, { worktreeId: string; message: ChatMessage }]
  >;
}

/** Tell the structured layer a dialog it can see is open. */
function openDialogEvent(): void {
  recordAgentEvent('wt-2214', 'claude', 'claude-2', {
    event: 'notification',
    at: Date.now() - 1_000,
    detail: 'permission_prompt',
    sessionId: 'sess-2214',
    message: 'Claude needs your permission to use Bash',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  clearAgentStopEvents();
  createMessageFailure = null;
  unclassifiedVerdict = { shouldRecord: false, dwellMs: 0 };
  isRunning.mockResolvedValue(true);
  broadcastMessage.mockReset();
  vi.mocked(captureSessionOutput).mockResolvedValue(BUSY_FRAME);
});

describe('the unclassified-frame row (Issue #2214)', () => {
  it('publishes the row it wrote as a new `message`', async () => {
    unclassifiedVerdict = { shouldRecord: true, dwellMs: 90_000 };

    await build();

    await vi.waitFor(() => {
      expect(pushes()).toHaveLength(1);
    });
    const [type, payload] = pushes()[0];
    // A fresh INSERT: no client has been told about this row before.
    expect(type).toBe('message');
    expect(payload.worktreeId).toBe('wt-2214');
    expect(payload.message).toMatchObject({
      id: 'row-2214',
      worktreeId: 'wt-2214',
      messageType: 'prompt',
      cliToolId: 'claude',
      // The alias instance the payload was built for, not the tool default.
      instanceId: 'claude-2',
      promptData: { type: UNCLASSIFIED_PROMPT_TYPE, status: 'unclassified' },
    });
  });

  it('publishes nothing when no row was written', async () => {
    await build();

    await Promise.resolve();
    expect(createMessage).not.toHaveBeenCalled();
    expect(pushes()).toHaveLength(0);
  });

  it('publishes nothing when the insert failed', async () => {
    unclassifiedVerdict = { shouldRecord: true, dwellMs: 90_000 };
    createMessageFailure = new Error('database is locked');

    // Best-effort by contract: the caller is waiting on a payload and gets one.
    await expect(build()).resolves.toBeTruthy();

    await Promise.resolve();
    expect(pushes()).toHaveLength(0);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'unclassified-frame-record-failed',
      expect.anything()
    );
  });
});

describe('the structured-prompt row (Issue #2214)', () => {
  it('publishes the row it wrote as a new `message`', async () => {
    openDialogEvent();

    await build();

    await vi.waitFor(() => {
      expect(pushes()).toHaveLength(1);
    });
    const [type, payload] = pushes()[0];
    expect(type).toBe('message');
    expect(payload.message).toMatchObject({
      id: 'row-2214',
      worktreeId: 'wt-2214',
      messageType: 'prompt',
      cliToolId: 'claude',
      instanceId: 'claude-2',
      promptData: { type: UNCLASSIFIED_PROMPT_TYPE, source: 'notification' },
    });
  });

  it('publishes once per episode, as the row is written once', async () => {
    openDialogEvent();

    await build();
    await build();
    await build();

    await vi.waitFor(() => {
      expect(pushes()).toHaveLength(1);
    });
  });

  it('still returns a payload when the socket throws', async () => {
    broadcastMessage.mockImplementation(() => {
      throw new Error('socket is gone');
    });
    openDialogEvent();

    // The row is committed before the push is attempted, and the push is
    // detached, so a dead socket cannot reach the caller waiting on the payload.
    const payload = await build();
    expect(payload.isPromptWaiting).toBe(true);
    expect(createMessage).toHaveBeenCalledTimes(1);

    await vi.waitFor(() => {
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'history-row-broadcast-failed',
        expect.objectContaining({ worktreeId: 'wt-2214' })
      );
    });
  });
});
