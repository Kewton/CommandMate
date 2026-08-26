/**
 * The restart sweep, over real sockets (Issue #2108).
 *
 * The unit suite stubs `./runtime`, so it proves the *selection* is right and
 * nothing about the recovery. This one runs the whole startup path against real
 * listeners — a persisted port file on disk, a server that speaks opencode's
 * `/global/health`, `/event` and `/session/status`, and the real
 * `recoverOpencodePort` / `attachOpencodeEventStream` behind it — because both
 * of the guards this feature leans on are content checks that a stub cannot
 * exercise: `probeOpencodeHealth` refuses anything that is not opencode's
 * health document, and the recovery refuses an entry recorded for a different
 * worktree.
 *
 * Mirrors the live measurement in
 * `docs/design/opencode-server-live-verification.md` §28, where a CommandMate
 * restarted against a live opencode 1.18.23 pane answered `409 NO_OPENCODE_PORT`
 * before this sweep existed and `200` / `connected: true` / `liveness: live`
 * after it.
 *
 * Only the pane check and the worktree row are stubbed. Creating real tmux
 * sessions from a test would reach the user's own tmux server, and neither
 * which panes are alive nor where the database says a worktree lives is what
 * this file is about — the sockets are.
 *
 * @vitest-environment node
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'http';
import { once } from 'events';
import { writeFileSync } from 'fs';
import { AddressInfo } from 'net';
import { join } from 'path';
import { makeTempDir, removeTempDir } from '@tests/helpers/temp-dir';

const { isRunningMock } = vi.hoisted(() => ({
  isRunningMock: vi.fn<(worktreeId: string, instanceId?: string) => Promise<boolean>>(),
}));

vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: { getInstance: () => ({ getTool: () => ({ isRunning: isRunningMock }) }) },
}));

vi.mock('@/lib/db/db-instance', () => ({
  getDbInstance: vi.fn(() => ({}) as never),
}));

vi.mock('@/lib/db', () => ({
  getWorktreeById: vi.fn(),
}));

import { getWorktreeById } from '@/lib/db';
import { describeAgentEventSource } from '@/lib/hooks/sources/define-source';
import {
  getAssignedOpencodePort,
  resetOpencodePortAssignments,
} from '@/lib/hooks/sources/opencode/ports';
import { reattachOpencodeEventStreams } from '@/lib/hooks/sources/opencode/reattach';
import { opencodeAgentEventSource } from '@/lib/hooks/sources/opencode/source';
import {
  closeOpencodeSubscription,
  getOpencodeLiveness,
  isOpencodeSubscribed,
  resetOpencodeSubscriptions,
} from '@/lib/hooks/sources/opencode/subscription';

const WORKTREE_ID = 'wt-2108-int';
const TARGET = { worktreeId: WORKTREE_ID, cliToolId: 'opencode', instanceId: 'opencode' } as const;

let sandbox: string;
let portFile: string;
let worktreePath: string;
let servers: Server[] = [];

/** How many times each path was asked for, so "never probed" is checkable. */
let hits: Record<string, number> = {};

/**
 * A listener that answers as opencode 1.18.23 does: the health document, an
 * `/event` stream whose first frame moves the subscription to `live`, and the
 * `/session/status` map `probeActivity` reads.
 */
async function listenAsOpencode(): Promise<Server> {
  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    hits[path] = (hits[path] ?? 0) + 1;
    if (path === '/global/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ healthy: true, version: '1.18.23' }));
      return;
    }
    if (path === '/session/status') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ses_2108: { type: 'idle' } }));
      return;
    }
    if (path === '/event') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ type: 'server.connected', properties: {} })}\n\n`);
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  servers.push(server);
  return server;
}

/** A listener that is emphatically not opencode — the squatter of #1931. */
async function listenAsSquatter(): Promise<Server> {
  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    hits[path] = (hits[path] ?? 0) + 1;
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body>hello</body></html>');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  servers.push(server);
  return server;
}

const portOf = (server: Server): number => (server.address() as AddressInfo).port;

/** Write the file a previous CommandMate process would have left behind. */
function persistPort(port: number, path = worktreePath, key = `${WORKTREE_ID}:opencode`): void {
  writeFileSync(
    portFile,
    `${JSON.stringify({ [key]: { port, worktreePath: path, updatedAt: 1787757684159 } }, null, 2)}\n`,
    { mode: 0o600 }
  );
}

beforeAll(() => {
  sandbox = makeTempDir('opencode-reattach-int-2108-');
  portFile = join(sandbox, 'opencode-ports.json');
  worktreePath = join(sandbox, 'work');
});

afterAll(() => {
  removeTempDir(sandbox);
});

beforeEach(() => {
  vi.clearAllMocks();
  servers = [];
  hits = {};
  resetOpencodePortAssignments();
  resetOpencodeSubscriptions();
  vi.stubEnv('CM_OPENCODE_PORT_FILE', portFile);
  vi.stubEnv('CM_AGENT_HOOKS_INJECT', '1');
  isRunningMock.mockImplementation(async (worktreeId: string) => worktreeId === WORKTREE_ID);
  // What the database says about this worktree, which is the value
  // `recoverOpencodePort` compares the recorded path against.
  vi.mocked(getWorktreeById).mockImplementation(
    (_db, id: string) =>
      id === WORKTREE_ID ? ({ id, path: worktreePath } as never) : null
  );
  writeFileSync(portFile, '{}\n');
});

afterEach(async () => {
  await closeOpencodeSubscription(TARGET);
  resetOpencodeSubscriptions();
  resetOpencodePortAssignments();
  vi.unstubAllEnvs();
  for (const server of servers) {
    server.closeAllConnections?.();
    server.close();
  }
  servers = [];
});

describe('[#2108] a restart against a pane whose server is still listening', () => {
  it('recovers the port and comes back live without anything being sent', async () => {
    const opencode = await listenAsOpencode();
    persistPort(portOf(opencode));

    // Precondition: this is what every HTTP surface saw after a restart, and it
    // is what `409 NO_OPENCODE_PORT` is derived from.
    expect(getAssignedOpencodePort(TARGET)).toBeNull();

    const report = await reattachOpencodeEventStreams();

    expect(report).toEqual({ persisted: 1, candidates: 1, reattached: 1, skipped: 0 });
    // The 409 is gone: the route's whole test is `port !== null`.
    expect(getAssignedOpencodePort(TARGET)).toBe(portOf(opencode));
    expect(isOpencodeSubscribed(TARGET)).toBe(true);

    // `connected: true` on `GET .../instances/opencode` needs the liveness too,
    // and `structuredEvents.source.liveness` is #2054's published form of it.
    await vi.waitFor(() => expect(getOpencodeLiveness(TARGET).state).toBe('live'));
    expect(
      describeAgentEventSource(
        opencodeAgentEventSource,
        getOpencodeLiveness(TARGET),
        Date.now()
      )
    ).toEqual({ kind: 'sse', liveness: 'live' });
  });

  it('re-reads whether the conversation is working, so a mid-turn restart is not blind', async () => {
    const opencode = await listenAsOpencode();
    persistPort(portOf(opencode));

    await reattachOpencodeEventStreams();

    // #2054's post-attach probe. Without it the next answer to "is this pane
    // busy?" is the turn's own `session.idle`, which on a long turn is minutes.
    expect(hits['/session/status']).toBe(1);
  });
});

describe('[#2108] a restart that must not adopt what it finds', () => {
  it('leaves a port nothing answers on unassigned', async () => {
    const dead = await listenAsOpencode();
    const port = portOf(dead);
    dead.closeAllConnections?.();
    await new Promise((resolve) => dead.close(resolve));
    servers = servers.filter((server) => server !== dead);
    persistPort(port);

    expect(await reattachOpencodeEventStreams()).toEqual({
      persisted: 1,
      candidates: 1,
      reattached: 0,
      skipped: 1,
    });
    expect(getAssignedOpencodePort(TARGET)).toBeNull();
    expect(isOpencodeSubscribed(TARGET)).toBe(false);
  });

  it('leaves a port another process took unassigned', async () => {
    const squatter = await listenAsSquatter();
    persistPort(portOf(squatter));

    expect(await reattachOpencodeEventStreams()).toMatchObject({
      candidates: 1,
      reattached: 0,
      skipped: 1,
    });
    // It answered 200 — but not with opencode's health document, so the port is
    // not this instance's and nothing is written down for it.
    expect(hits['/global/health']).toBeGreaterThanOrEqual(1);
    expect(getAssignedOpencodePort(TARGET)).toBeNull();
    expect(hits['/event']).toBeUndefined();
  });

  it('leaves an entry recorded for a different path unassigned', async () => {
    const opencode = await listenAsOpencode();
    // The worktree id was reused at a new path, or the file came from another
    // machine's home directory. The database says one thing, the file another.
    persistPort(portOf(opencode), join(sandbox, 'somewhere-else'));

    expect(await reattachOpencodeEventStreams()).toMatchObject({
      candidates: 1,
      reattached: 0,
      skipped: 1,
    });
    expect(getAssignedOpencodePort(TARGET)).toBeNull();
    // Refused on the recorded path alone: the server was never even asked.
    expect(hits['/global/health']).toBeUndefined();
  });

  it('never touches a healthy server whose pane is gone', async () => {
    const opencode = await listenAsOpencode();
    persistPort(portOf(opencode), worktreePath, 'wt-alpha:opencode');
    // `wt-alpha` is the shape of the dead rows the file accumulates; only
    // `WORKTREE_ID`'s pane is running.

    expect(await reattachOpencodeEventStreams()).toEqual({
      persisted: 1,
      candidates: 0,
      reattached: 0,
      skipped: 0,
    });
    expect(hits).toEqual({});
  });
});
