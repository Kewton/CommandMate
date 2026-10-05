/**
 * The two paths to tmux that do not live under `src/app/api/worktrees/[id]/`
 * leave a session another CommandMate server owns alone (Issue #3334).
 *
 * ## Why this file exists next to the #3290 guard
 *
 * `worktree-route-session-ownership-3290.test.ts` enumerates the route handlers
 * under `[id]/` and gives each the same case: the session the request
 * addresses exists, under the right NAME, but was started in another server's
 * directory. Two paths reach a session without being one of those handlers,
 * and the enumeration cannot see them:
 *
 * - **the WebSocket terminal** (`ws-server.ts`): ownership was checked once, at
 *   `terminal_subscribe`, and every later `terminal_input` / `terminal_resize`
 *   addressed the session by its cached name for as long as the socket lived;
 * - **relay delivery** (`relay-delivery.ts` → `relay-readiness.ts`): the send
 *   itself goes through `sendUserMessage`, which refuses the session (#2865),
 *   but the readiness check ran first and read that pane to judge it.
 *
 * Each is given the #3290 case here, judged the same way: by what reaches the
 * process boundary (`fake-tmux-child-process.ts`) or the control-mode
 * transport, not by which functions the code names.
 *
 * ## Why it cannot pass for the wrong reason
 *
 * - Every refusal has a twin with the same session owned, in which the key, the
 *   resize or the pane read is seen arriving.
 * - The WebSocket case starts from a subscription that was legitimately made to
 *   this server's own session, which is exactly the state the one-time check at
 *   subscribe left unguarded.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { WebSocket } from 'ws';

vi.mock('child_process', async (importOriginal) =>
  (await import('@tests/unit/guards/fake-tmux-child-process')).fakeChildProcess(importOriginal)
);

declare module '@/lib/db/db-instance' {
  export function setMockDb(db: Database.Database): void;
}

vi.mock('@/lib/db/db-instance', () => {
  let mockDb: Database.Database | null = null;
  return {
    getDbInstance: () => {
      if (!mockDb) throw new Error('Mock database not initialized');
      return mockDb;
    },
    setMockDb: (db: Database.Database) => {
      mockDb = db;
    },
    closeDbInstance: () => {
      mockDb = null;
    },
  };
});

// The control-mode transport holds a long-lived `tmux -C` client; what matters
// here is whether a key or a resize is handed to it at all.
const transport = vi.hoisted(() => ({
  subscribe: vi.fn(),
  sendInput: vi.fn(),
  resize: vi.fn(),
  getSubscriberCount: vi.fn(() => 0),
  captureSnapshot: vi.fn(),
}));
vi.mock('@/lib/tmux/control-mode-tmux-transport', () => ({
  getControlModeTmuxTransport: () => transport,
}));
vi.mock('@/lib/tmux/tmux-control-mode-flags', () => ({
  isTmuxControlModeEnabled: () => true,
}));

// opencode-v2's `isRunning()` re-subscribes to the event stream of the server in
// the session's directory (fire and forget). Spied, not replaced, so a call is
// seen without anything being dialled.
const opencodeV2Resume = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@/lib/hooks/sources/opencode-v2/runtime', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resumeOpencodeV2EventStream: opencodeV2Resume,
}));

import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import { createRelay, listRelaysWithPendingPayload, stashRelayPayload } from '@/lib/db/relay-db';
import { resolveSessionName } from '@/lib/cli-tools/session-name';
import { resetForeignSessionWarningsForTesting } from '@/lib/tmux/session-ownership';
import type { Worktree } from '@/types/models';
import { fakeTmux } from '@tests/unit/guards/fake-tmux-child-process';

// =============================================================================
// The case
// =============================================================================

const WORKTREE_ID = 'wt-3334';
const WORKTREE_PATH = '/nonexistent-3334/this-server/wt-3334';
const OTHER_SERVER_PATH = '/nonexistent-3334/other-server/wt-3334';
const PEER_ID = 'wt-3334-peer';

/** Same tool on both paths, so one name covers the terminal and the relay. */
const CLI_TOOL = 'codex' as const;
const SESSION = resolveSessionName(CLI_TOOL, WORKTREE_ID);

function worktree(id: string, path: string): Worktree {
  return {
    id,
    name: id,
    path,
    repositoryPath: '/nonexistent-3334/this-server',
    repositoryName: 'this-server',
    cliToolId: CLI_TOOL,
  };
}

/** Let fire-and-forget work finish before reading what reached tmux. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

let db: Database.Database;

beforeEach(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);
  upsertWorktree(db, worktree(WORKTREE_ID, WORKTREE_PATH));
  upsertWorktree(db, worktree(PEER_ID, '/nonexistent-3334/this-server/peer'));

  resetForeignSessionWarningsForTesting();
  fakeTmux.reset();
  transport.subscribe.mockReset().mockResolvedValue({ unsubscribe: vi.fn().mockResolvedValue(undefined) });
  transport.sendInput.mockReset().mockResolvedValue(undefined);
  transport.resize.mockReset().mockResolvedValue(undefined);
  transport.captureSnapshot.mockReset().mockResolvedValue('');
  opencodeV2Resume.mockClear();
});

afterEach(async () => {
  await settle();
  const { closeDbInstance } = await import('@/lib/db/db-instance');
  closeDbInstance();
  db.close();
});

// =============================================================================
// WebSocket terminal
// =============================================================================

function socket(): { ws: WebSocket; sent: () => Array<Record<string, unknown>> } {
  const send = vi.fn();
  const ws = { readyState: 1, send } as unknown as WebSocket;
  return { ws, sent: () => send.mock.calls.map((call) => JSON.parse(String(call[0]))) };
}

/** A client subscribed to this server's own session, as the subscribe check allows. */
async function subscribedClient() {
  const { __internal } = await import('@/lib/ws-server');
  __internal.resetStateForTest();
  const client = socket();
  __internal.registerClientForTest(client.ws);
  fakeTmux.addSession(SESSION, WORKTREE_PATH);
  await __internal.handleTerminalSubscribe(client.ws, {
    type: 'terminal_subscribe',
    worktreeId: WORKTREE_ID,
    cliToolId: CLI_TOOL,
  });
  expect(transport.subscribe).toHaveBeenCalledTimes(1);
  return { ...client, internal: __internal };
}

/** The session ended and another CommandMate server started one under the same name. */
function sessionChangesHands(): void {
  fakeTmux.reset();
  fakeTmux.addSession(SESSION, OTHER_SERVER_PATH);
}

describe('[#3334] WebSocket terminal', () => {
  it('refuses to subscribe to a session another server owns', async () => {
    const { __internal } = await import('@/lib/ws-server');
    __internal.resetStateForTest();
    const client = socket();
    __internal.registerClientForTest(client.ws);
    fakeTmux.addSession(SESSION, OTHER_SERVER_PATH);

    await __internal.handleTerminalSubscribe(client.ws, {
      type: 'terminal_subscribe',
      worktreeId: WORKTREE_ID,
      cliToolId: CLI_TOOL,
    });

    expect(transport.subscribe).not.toHaveBeenCalled();
    expect(fakeTmux.touches()).toEqual([]);
    expect(client.sent()).toContainEqual({
      type: 'terminal_error',
      error: 'Session belongs to another CommandMate server',
    });
  });

  it('types nothing into it once the subscribed session has changed hands', async () => {
    const { internal, ws, sent } = await subscribedClient();
    sessionChangesHands();

    await internal.handleTerminalInput(ws, { type: 'terminal_input', data: 'rm -rf build\r' });

    expect(transport.sendInput).not.toHaveBeenCalled();
    expect(fakeTmux.askedSessionPathOf(SESSION)).toBe(true);
    expect(fakeTmux.touches()).toEqual([]);
    expect(sent()).toContainEqual({
      type: 'terminal_error',
      error: 'Session belongs to another CommandMate server',
    });
  });

  it('does not resize it either', async () => {
    const { internal, ws, sent } = await subscribedClient();
    sessionChangesHands();

    await internal.handleTerminalResize(ws, { type: 'terminal_resize', cols: 80, rows: 24 });

    expect(transport.resize).not.toHaveBeenCalled();
    expect(fakeTmux.touches()).toEqual([]);
    expect(sent()).toContainEqual({
      type: 'terminal_error',
      error: 'Session belongs to another CommandMate server',
    });
  });

  it('does not show it through the fallback snapshot', async () => {
    let onError: ((error: Error) => void) | undefined;
    transport.subscribe.mockImplementation(async (_name: string, handlers: { onError: (e: Error) => void }) => {
      onError = handlers.onError;
      return { unsubscribe: vi.fn().mockResolvedValue(undefined) };
    });
    transport.captureSnapshot.mockResolvedValue('the other server\'s pane');
    const { sent } = await subscribedClient();
    sessionChangesHands();

    onError?.(new Error('control mode lost'));
    await settle();

    expect(transport.captureSnapshot).not.toHaveBeenCalled();
    expect(sent().some((event) => event.type === 'terminal_output')).toBe(false);
  });

  describe('with the session still its own (negative control)', () => {
    it('types the key', async () => {
      const { internal, ws } = await subscribedClient();

      await internal.handleTerminalInput(ws, { type: 'terminal_input', data: 'ls\r' });

      expect(transport.sendInput).toHaveBeenCalledWith(SESSION, 'ls\r');
    });

    it('resizes', async () => {
      const { internal, ws } = await subscribedClient();

      await internal.handleTerminalResize(ws, { type: 'terminal_resize', cols: 80, rows: 24 });

      expect(transport.resize).toHaveBeenCalledWith(SESSION, 80, 24);
    });

    it('shows the fallback snapshot', async () => {
      let onError: ((error: Error) => void) | undefined;
      transport.subscribe.mockImplementation(async (_name: string, handlers: { onError: (e: Error) => void }) => {
        onError = handlers.onError;
        return { unsubscribe: vi.fn().mockResolvedValue(undefined) };
      });
      transport.captureSnapshot.mockResolvedValue('own pane');
      const { sent } = await subscribedClient();

      onError?.(new Error('control mode lost'));
      await settle();

      expect(sent()).toContainEqual({ type: 'terminal_output', data: 'own pane', fallback: true });
    });
  });
});

// =============================================================================
// Relay delivery
// =============================================================================

/** A reply from the peer, waiting to be put into this worktree's composer. */
function pendingReply(): string {
  const relay = createRelay(db, {
    from: { worktreeId: WORKTREE_ID, instanceId: CLI_TOOL },
    to: { worktreeId: PEER_ID, instanceId: CLI_TOOL },
    hops: 1,
    expiresAt: Date.now() + 60_000,
  });
  expect(stashRelayPayload(db, relay.id, 'reply', 'the answer')).toBe(true);
  return relay.id;
}

describe('[#3334] relay delivery', () => {
  it('neither reads nor types into a requester session another server owns', async () => {
    const relayId = pendingReply();
    fakeTmux.addSession(SESSION, OTHER_SERVER_PATH);
    const { pumpRelayDeliveries } = await import('@/lib/relay/relay-delivery');

    await pumpRelayDeliveries();
    await settle();

    expect(fakeTmux.askedSessionPathOf(SESSION)).toBe(true);
    expect(fakeTmux.touches()).toEqual([]);
    // Held, not dropped: the payload is still there for this server's own
    // session, should it come back before the deadline.
    expect(listRelaysWithPendingPayload(db).map((item) => item.relay.id)).toEqual([relayId]);
  }, 30_000);

  it('holds it as foreign_session', async () => {
    fakeTmux.addSession(SESSION, OTHER_SERVER_PATH);
    const { findRelayHoldReason } = await import('@/lib/relay/relay-readiness');

    expect(await findRelayHoldReason(WORKTREE_ID, CLI_TOOL, CLI_TOOL, db)).toBe('foreign_session');
    expect(fakeTmux.touches()).toEqual([]);
  });

  it('reads the pane when the session is its own (negative control)', async () => {
    fakeTmux.addSession(SESSION, WORKTREE_PATH);
    const { findRelayHoldReason } = await import('@/lib/relay/relay-readiness');

    // What it then makes of a blank fake pane is the status detector's business;
    // the point is that it got as far as reading it.
    expect(await findRelayHoldReason(WORKTREE_ID, CLI_TOOL, CLI_TOOL, db)).not.toBe('foreign_session');
    expect(fakeTmux.touches().map((touch) => [touch.subcommand, touch.target])).toContainEqual([
      'capture-pane',
      SESSION,
    ]);
  });
});

/**
 * `isRunning()` is not a bare existence test for every tool, so the ownership
 * check has to come before it, not after. Codex's is `has-session`; these two
 * do more with whatever session answers to the name.
 */
describe('[#3334] relay readiness asks ownership before isRunning()', () => {
  const CLAUDE_SESSION = resolveSessionName('claude', WORKTREE_ID);
  const OPENCODE_V2_SESSION = resolveSessionName('opencode-v2', WORKTREE_ID);

  it('claude: does not read the pane of a session another server owns', async () => {
    fakeTmux.addSession(CLAUDE_SESSION, OTHER_SERVER_PATH);
    const { findRelayHoldReason } = await import('@/lib/relay/relay-readiness');

    expect(await findRelayHoldReason(WORKTREE_ID, 'claude', 'claude', db)).toBe('foreign_session');
    await settle();

    expect(fakeTmux.askedSessionPathOf(CLAUDE_SESSION)).toBe(true);
    expect(fakeTmux.touches()).toEqual([]);
  });

  it('claude: reads the pane of its own session (negative control)', async () => {
    fakeTmux.addSession(CLAUDE_SESSION, WORKTREE_PATH);
    const { findRelayHoldReason } = await import('@/lib/relay/relay-readiness');

    expect(await findRelayHoldReason(WORKTREE_ID, 'claude', 'claude', db)).not.toBe('foreign_session');
    await settle();

    expect(fakeTmux.touches().map((touch) => [touch.subcommand, touch.target])).toContainEqual([
      'capture-pane',
      CLAUDE_SESSION,
    ]);
  });

  it('opencode-v2: does not resume the event stream of a session another server owns', async () => {
    fakeTmux.addSession(OPENCODE_V2_SESSION, OTHER_SERVER_PATH);
    const { findRelayHoldReason } = await import('@/lib/relay/relay-readiness');

    expect(await findRelayHoldReason(WORKTREE_ID, 'opencode-v2', 'opencode-v2', db)).toBe('foreign_session');
    await settle();

    expect(opencodeV2Resume).not.toHaveBeenCalled();
    expect(fakeTmux.touches()).toEqual([]);
  });

  it('opencode-v2: resumes the event stream of its own session (negative control)', async () => {
    // A worktree of its own: the tool throttles resume attempts per session
    // name for the life of the process, and the case above may have used it.
    const ownId = 'wt-3334-v2-own';
    const ownPath = '/nonexistent-3334/this-server/wt-3334-v2-own';
    upsertWorktree(db, worktree(ownId, ownPath));
    fakeTmux.addSession(resolveSessionName('opencode-v2', ownId), ownPath);
    const { findRelayHoldReason } = await import('@/lib/relay/relay-readiness');

    expect(await findRelayHoldReason(ownId, 'opencode-v2', 'opencode-v2', db)).not.toBe('foreign_session');
    await settle();

    expect(opencodeV2Resume).toHaveBeenCalledWith(expect.anything(), ownPath);
  });
});

// =============================================================================
// Terminal snapshot push
// =============================================================================

/**
 * The push the response poller drives while a session generates. The poller
 * was started by a send the route checked, but it keeps reading by name; when
 * the session changes hands mid-poll, the next tick must neither read the
 * other server's pane nor push it.
 */
describe('[#3334] terminal snapshot push', () => {
  /** A tab watching the worktree room; returns the frames it received. */
  async function watchingTab(): Promise<() => Array<Record<string, unknown>>> {
    const { __internal } = await import('@/lib/ws-server');
    __internal.resetStateForTest();
    const tab = socket();
    __internal.registerClientForTest(tab.ws);
    __internal.handleMessage(tab.ws, { type: 'subscribe', worktreeId: WORKTREE_ID });
    // Room frames arrive wrapped: `{ type: 'broadcast', worktreeId, data }`.
    return () =>
      tab
        .sent()
        .filter((event) => (event.data as { type?: unknown } | undefined)?.type === 'terminal_snapshot');
  }

  it('neither reads nor pushes it after an interaction either', async () => {
    const frames = await watchingTab();
    fakeTmux.addSession(SESSION, OTHER_SERVER_PATH);
    const { broadcastTerminalSnapshotAfterInteraction } = await import('@/lib/realtime/terminal-broadcast');

    await broadcastTerminalSnapshotAfterInteraction(WORKTREE_ID, CLI_TOOL, undefined, [0]);
    await settle();

    expect(fakeTmux.touches()).toEqual([]);
    expect(frames()).toEqual([]);
  }, 30_000);

  it('reads and pushes its own session (negative control)', async () => {
    const frames = await watchingTab();
    fakeTmux.addSession(SESSION, WORKTREE_PATH);
    const { broadcastTerminalSnapshot } = await import('@/lib/realtime/terminal-broadcast');

    await broadcastTerminalSnapshot(WORKTREE_ID, CLI_TOOL);
    await settle();

    expect(fakeTmux.touches().map((touch) => [touch.subcommand, touch.target])).toContainEqual([
      'capture-pane',
      SESSION,
    ]);
    expect(frames()).toHaveLength(1);
  }, 30_000);
});


// =============================================================================
// Response poller tick
// =============================================================================

/**
 * The tick that drives the push above runs `checkForResponse` first: it
 * captures the pane and saves a reply or a prompt into this worktree's chat and
 * history, then announces it (`broadcastMessage`). Driven here through the
 * poller itself — `startPolling` and one `POLLING_INTERVAL` — not by calling
 * the functions it calls, so the order inside the tick is what is judged.
 *
 * The screen is a live codex approval dialog: something the tick saves (a
 * prompt row) and announces when the session is this server's.
 */
describe('[#3334] response poller tick', () => {
  /** A live codex 0.157 approval dialog (tests/fixtures/codex-dialogs-0157). */
  const APPROVAL = readFileSync(
    join(__dirname, '../../fixtures/codex-dialogs-0157/approval.txt'),
    'utf-8'
  );

  function savedRows(worktreeId: string): number {
    return (
      db.prepare('SELECT COUNT(*) AS n FROM chat_messages WHERE worktree_id = ?').get(worktreeId) as { n: number }
    ).n;
  }

  /** Every room frame the tab received, unwrapped. */
  async function roomFrames(worktreeId: string): Promise<() => Array<Record<string, unknown>>> {
    const { __internal } = await import('@/lib/ws-server');
    __internal.resetStateForTest();
    const tab = socket();
    __internal.registerClientForTest(tab.ws);
    __internal.handleMessage(tab.ws, { type: 'subscribe', worktreeId });
    return () =>
      tab
        .sent()
        .filter((event) => event.type === 'broadcast')
        .map((event) => event.data as Record<string, unknown>);
  }

  /** Start a poller and let exactly one tick run. */
  async function runOneTick(worktreeId: string): Promise<void> {
    const poller = await import('@/lib/polling/response-poller-core');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      poller.startPolling(worktreeId, CLI_TOOL);
      await vi.advanceTimersByTimeAsync(poller.POLLING_INTERVAL);
    } finally {
      poller.stopAllPolling();
      vi.useRealTimers();
    }
    await settle();
  }

  it('neither reads, saves nor announces a session another server owns, and ends the chain', async () => {
    const frames = await roomFrames(WORKTREE_ID);
    fakeTmux.addSession(SESSION, OTHER_SERVER_PATH);
    fakeTmux.setPane(SESSION, APPROVAL);
    const poller = await import('@/lib/polling/response-poller-core');
    const ended: string[][] = [];

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      poller.startPolling(WORKTREE_ID, CLI_TOOL);
      await vi.advanceTimersByTimeAsync(poller.POLLING_INTERVAL);
      ended.push(poller.getActivePollers());
    } finally {
      poller.stopAllPolling();
      vi.useRealTimers();
    }
    await settle();

    expect(fakeTmux.askedSessionPathOf(SESSION)).toBe(true);
    expect(fakeTmux.touches()).toEqual([]);
    expect(savedRows(WORKTREE_ID)).toBe(0);
    expect(frames()).toEqual([]);
    // Ended the way a session that is not running ends it: no next tick armed.
    expect(ended).toEqual([[]]);
  }, 30_000);

  it('reads, saves and announces its own session (negative control)', async () => {
    // A worktree of its own: the capture cache and the prompt dedup are keyed
    // by session / poller, and must not carry anything over from the case above.
    const ownId = 'wt-3334-poll-own';
    const ownPath = '/nonexistent-3334/this-server/wt-3334-poll-own';
    const ownSession = resolveSessionName(CLI_TOOL, ownId);
    upsertWorktree(db, worktree(ownId, ownPath));
    const frames = await roomFrames(ownId);
    fakeTmux.addSession(ownSession, ownPath);
    fakeTmux.setPane(ownSession, APPROVAL);

    await runOneTick(ownId);

    expect(fakeTmux.touches().map((touch) => [touch.subcommand, touch.target])).toContainEqual([
      'capture-pane',
      ownSession,
    ]);
    expect(savedRows(ownId)).toBeGreaterThan(0);
    expect(frames().length).toBeGreaterThan(0);
  }, 30_000);
});
