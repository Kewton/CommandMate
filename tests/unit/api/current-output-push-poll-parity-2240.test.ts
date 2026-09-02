/**
 * Push and poll answer with the same verdict (Issue #2240).
 *
 * `/current-output` (the HTTP poll) and `terminal_snapshot` (the WebSocket push)
 * are two transports for one payload — `buildCurrentOutput` is called by both,
 * and #1120 says so in a comment on the route. `sessionStatus` was the field
 * where that stopped being true: the route returned the payload whole, the
 * emitter copied a hand-written list of members, and the verdict was not on the
 * list. A pane fed by push therefore had no verdict at all, and #2238's chat gate
 * (`sessionStatus === 'running'`) could only be satisfied by the fallback poll.
 *
 * So the property is not "the emitter sets a field" — that is asserted in
 * `terminal-broadcast.test.ts`. It is: **for one worktree and one instance, over
 * one screen, the two transports report the same `sessionStatus`.** Both paths
 * are driven for real here, against the same seeded worktree and the same
 * captured frame, through the same detector — the only thing stubbed is the
 * tmux read itself. Asserting the two against each other rather than against a
 * literal is deliberate: a change that moved BOTH paths to a new verdict is not
 * the defect this guards, and pinning a literal would report it as one.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { NextRequest } from 'next/server';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import { CLI_TOOL_IDS, type CLIToolType } from '@/lib/cli-tools/types';
import type { Worktree } from '@/types/models';

const fixture = (name: string): string =>
  fs.readFileSync(path.resolve(__dirname, '../lib/detection/fixtures', name), 'utf-8');

/** Swapped per test; the capture mock below reads it at call time. */
let paneFrame = '';

vi.mock('@/lib/session/cli-session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/session/cli-session')>();
  return {
    ...actual,
    captureSessionOutput: vi.fn(async () => paneFrame),
  };
});

/**
 * The socket. Mocked rather than opened — `broadcastTerminalSnapshot` bails out
 * on an empty room, and `hasRoomSubscribers` is how it asks.
 *
 * `buildCurrentOutput` reaches the same two exports through a dynamic import
 * (its own chat-progress publisher, #2199), so this mock catches those frames
 * too. Every read below filters on `type` for that reason.
 */
vi.mock('@/lib/ws-server', () => ({
  broadcast: vi.fn(),
  hasRoomSubscribers: vi.fn(() => true),
}));

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
    setMockDb: (db: Database.Database) => { mockDb = db; },
    closeDbInstance: () => { mockDb?.close(); mockDb = null; },
  };
});

import { GET } from '@/app/api/worktrees/[id]/current-output/route';
import { broadcast } from '@/lib/ws-server';
import {
  broadcastTerminalSnapshot,
  __resetTerminalBroadcastState,
} from '@/lib/realtime/terminal-broadcast';
import { CLIToolManager } from '@/lib/cli-tools/manager';

const WORKTREE_ID = 'wt-2240';
const CLI_TOOL: CLIToolType = 'opencode';

const mockBroadcast = vi.mocked(broadcast);

/** What the HTTP poll publishes for this pane. */
async function pollSessionStatus(): Promise<string> {
  const request = new NextRequest(
    `http://localhost:3000/api/worktrees/${WORKTREE_ID}/current-output`,
    { method: 'GET' },
  );
  const response = await (GET(request, {
    params: Promise.resolve({ id: WORKTREE_ID }),
  }) as Promise<Response>);
  expect(response.status).toBe(200);
  const body = (await response.json()) as { sessionStatus?: string };
  return body.sessionStatus ?? '<absent>';
}

/** What the WebSocket push publishes for the same pane. */
async function pushSessionStatus(): Promise<string> {
  mockBroadcast.mockClear();
  await broadcastTerminalSnapshot(WORKTREE_ID, CLI_TOOL, CLI_TOOL);

  const frames = mockBroadcast.mock.calls
    .map(call => call[1] as { type?: string; sessionStatus?: string })
    .filter(frame => frame.type === 'terminal_snapshot');
  expect(frames).toHaveLength(1);
  return frames[0].sessionStatus ?? '<absent>';
}

function everythingRunning(): void {
  const manager = CLIToolManager.getInstance();
  for (const tool of CLI_TOOL_IDS) {
    vi.spyOn(manager.getTool(tool), 'isRunning').mockResolvedValue(true);
  }
}

async function setUpDb(): Promise<void> {
  const db = new Database(':memory:');
  runMigrations(db);
  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);

  const worktree: Worktree = {
    id: WORKTREE_ID,
    name: 'push/poll parity',
    path: '/path/to/wt',
    repositoryPath: '/path/to/repo',
    repositoryName: 'repo',
    cliToolId: CLI_TOOL,
  };
  upsertWorktree(db, worktree);
}

describe('[#2240] /current-output and terminal_snapshot report one sessionStatus', () => {
  beforeEach(async () => {
    await setUpDb();
    __resetTerminalBroadcastState();
    everythingRunning();
  });

  afterEach(async () => {
    const { closeDbInstance } = await import('@/lib/db/db-instance');
    closeDbInstance();
    vi.restoreAllMocks();
  });

  it.each([
    ['a live turn', 'opencode-live-1883/turn-running.txt', 'running'],
    ['a finished turn', 'opencode-live-1883/turn-complete.txt', 'ready'],
    ['an open permission dialog', 'opencode-live-1893/permission-bash.txt', 'waiting'],
  ])('agrees on %s', async (_label, fixtureName, expected) => {
    paneFrame = fixture(fixtureName);

    const polled = await pollSessionStatus();
    const pushed = await pushSessionStatus();

    // The parity claim, in both directions: neither transport may be the one
    // that answers `<absent>`.
    expect(pushed).toBe(polled);
    // And the shared answer is the verdict the detector reads off this screen,
    // so a test that agreed on the wrong value cannot pass.
    expect(polled).toBe(expected);
  });

  it('agrees after the verdict moves, without a poll in between', async () => {
    // A turn ending is the transition the chat surface has to see. Push is the
    // path that carries it while push is healthy — the poll is throttled to 15s
    // there — so this reads the push twice across the change and the poll only
    // at the end, as confirmation that the two ended up in the same place.
    paneFrame = fixture('opencode-live-1883/turn-running.txt');
    expect(await pushSessionStatus()).toBe('running');

    paneFrame = fixture('opencode-live-1883/turn-complete.txt');
    const pushedAfter = await pushSessionStatus();

    expect(pushedAfter).toBe('ready');
    expect(await pollSessionStatus()).toBe(pushedAfter);
  });
});
