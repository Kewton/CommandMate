/**
 * Re-subscribing to opencode panes that outlived the process (Issue #2108).
 *
 * The measured defect: `~/.commandmate/opencode-ports.json` held the right port
 * and the server on it answered `/global/health`, but nothing read the file at
 * startup — `recoverOpencodePort`'s only caller was a *launch*, and a restart
 * does not launch anything. So `POST /api/worktrees/<id>/opencode/session`
 * answered `409 NO_OPENCODE_PORT` for the rest of the process's life while the
 * terminal view kept working, because the scraper never needed the port
 * (measured 2026-08-26, opencode 1.18.23 — design doc §28).
 *
 * These tests pin the *selection*: which persisted entries become candidates,
 * which are refused before anything is probed, and that a sweep costs nothing
 * when there is nothing to sweep. The recovery itself belongs to
 * `opencode-ports.test.ts`, and the whole path over real sockets belongs to
 * `tests/integration/opencode-reattach-startup-2108.test.ts`.
 *
 * @vitest-environment node
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { makeTempDir, removeTempDir } from '@tests/helpers/temp-dir';

const { isRunningMock, getToolMock } = vi.hoisted(() => {
  const isRunning = vi.fn<(worktreeId: string, instanceId?: string) => Promise<boolean>>();
  return { isRunningMock: isRunning, getToolMock: vi.fn(() => ({ isRunning })) };
});

vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: { getInstance: () => ({ getTool: getToolMock }) },
}));

vi.mock('@/lib/hooks/sources/opencode/runtime', () => ({
  resumeOpencodeEventStream: vi.fn(),
}));

vi.mock('@/lib/db/db-instance', () => ({
  getDbInstance: vi.fn(() => ({}) as never),
}));

vi.mock('@/lib/db', () => ({
  getWorktreeById: vi.fn(),
}));

import { getWorktreeById } from '@/lib/db';
import { resumeOpencodeEventStream } from '@/lib/hooks/sources/opencode/runtime';
import type { OpencodePortAssignment } from '@/lib/hooks/sources/opencode/ports';
import { reattachOpencodeEventStreams } from '@/lib/hooks/sources/opencode/reattach';

const resumeMock = vi.mocked(resumeOpencodeEventStream);
const getWorktreeByIdMock = vi.mocked(getWorktreeById);

const LIVE_PATH = '/repos/live';

/** The database's answer for `worktreeId`, which is what the guard compares to. */
function worktreeAt(paths: Record<string, string>): void {
  getWorktreeByIdMock.mockImplementation(
    (_db, id: string) => (paths[id] ? ({ id, path: paths[id] } as never) : null)
  );
}

let sandbox: string;
let portFile: string;

/** Write the persisted port file the sweep will read. */
function writePorts(entries: Record<string, Partial<OpencodePortAssignment>>): void {
  const all: Record<string, OpencodePortAssignment> = {};
  for (const [key, value] of Object.entries(entries)) {
    all[key] = {
      port: value.port ?? 4255,
      worktreePath: value.worktreePath ?? LIVE_PATH,
      updatedAt: value.updatedAt ?? 1787757684159,
    };
  }
  writeFileSync(portFile, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
}

/**
 * The gateway's answer: these `(worktreeId, instanceId)` pairs are running.
 *
 * `ICLITool.isRunning` is the only sanctioned way to ask (Issue #1922 §4 D4),
 * so it is what the sweep calls and what this stubs. Pairs are spelled
 * `worktreeId/instanceId` because that is the whole of the tool's input.
 */
function panesAlive(...pairs: string[]): void {
  const alive = new Set(pairs);
  isRunningMock.mockImplementation(async (worktreeId: string, instanceId?: string) =>
    alive.has(`${worktreeId}/${instanceId ?? 'opencode'}`)
  );
}

beforeAll(() => {
  sandbox = makeTempDir('opencode-reattach-2108-');
  portFile = join(sandbox, 'opencode-ports.json');
});

afterAll(() => {
  removeTempDir(sandbox);
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('CM_OPENCODE_PORT_FILE', portFile);
  vi.stubEnv('CM_AGENT_HOOKS_INJECT', '1');
  if (existsSync(portFile)) writeFileSync(portFile, '{}\n');
  resumeMock.mockResolvedValue(true);
  panesAlive();
  worktreeAt({
    'live-wt': LIVE_PATH,
    'wt-a': '/repos/a',
    'wt-b': '/repos/b',
    'wt-c': '/repos/c',
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('[#2108] the entries a restart re-subscribes to', () => {
  it('resumes the stream of a pane that is still alive, with its recorded path', async () => {
    writePorts({ 'live-wt:opencode': { port: 4255, worktreePath: LIVE_PATH } });
    panesAlive('live-wt/opencode');

    const report = await reattachOpencodeEventStreams();

    expect(resumeMock).toHaveBeenCalledTimes(1);
    expect(resumeMock).toHaveBeenCalledWith(
      { worktreeId: 'live-wt', cliToolId: 'opencode', instanceId: 'opencode' },
      LIVE_PATH
    );
    expect(report).toEqual({ persisted: 1, candidates: 1, reattached: 1, skipped: 0 });
  });

  it('derives the alias instance’s own session name rather than the primary’s', async () => {
    writePorts({ 'live-wt:opencode:opencode-2': { port: 4343 } });
    // The primary's name is alive; the alias's is not. Deriving the wrong one
    // would adopt a pane that belongs to a different instance.
    panesAlive('live-wt/opencode');

    expect(await reattachOpencodeEventStreams()).toEqual({
      persisted: 1,
      candidates: 0,
      reattached: 0,
      skipped: 0,
    });
    expect(resumeMock).not.toHaveBeenCalled();

    panesAlive('live-wt/opencode-2');
    expect(await reattachOpencodeEventStreams()).toMatchObject({ candidates: 1, reattached: 1 });
    expect(resumeMock).toHaveBeenCalledWith(
      { worktreeId: 'live-wt', cliToolId: 'opencode', instanceId: 'opencode-2' },
      LIVE_PATH
    );
  });

  it('never probes an entry whose pane is gone, however many of them there are', async () => {
    // The shape measured on the author's machine: 8 entries, 7 of them dead
    // leftovers from tests. Probing those would be 7 health-check timeouts on
    // every start.
    writePorts({
      'live-wt:opencode': { port: 4255, worktreePath: LIVE_PATH },
      'wt-alpha:opencode': { port: 4242, worktreePath: '/tmp/wt-alpha' },
      'wt-alpha:opencode:opencode-2': { port: 4343, worktreePath: '/tmp/wt-alpha' },
      'wt-beta:opencode': { port: 4444, worktreePath: '/tmp/wt-beta' },
    });
    panesAlive('live-wt/opencode');

    const report = await reattachOpencodeEventStreams();

    expect(resumeMock).toHaveBeenCalledTimes(1);
    expect(resumeMock.mock.calls[0][0].worktreeId).toBe('live-wt');
    expect(report).toEqual({ persisted: 4, candidates: 1, reattached: 1, skipped: 0 });
  });

  it('hands `recoverOpencodePort` the database’s path, not the file’s own', async () => {
    // The guard inside `recoverOpencodePort` compares the caller's path against
    // the recorded one. Passing the recorded value back would make that
    // comparison trivially true — the guard would be present and inert — so the
    // worktree id is resolved against the database instead.
    writePorts({ 'live-wt:opencode': { port: 4255, worktreePath: '/repos/where-it-used-to-be' } });
    panesAlive('live-wt/opencode');

    await reattachOpencodeEventStreams();

    expect(resumeMock).toHaveBeenCalledWith(expect.anything(), LIVE_PATH);
  });

  it('skips a pane whose worktree the database no longer knows', async () => {
    writePorts({ 'ghost-wt:opencode': { port: 4255 } });
    panesAlive('ghost-wt/opencode');

    expect(await reattachOpencodeEventStreams()).toEqual({
      persisted: 1,
      candidates: 1,
      reattached: 0,
      skipped: 1,
    });
    expect(resumeMock).not.toHaveBeenCalled();
  });

  it('counts a live pane whose server did not answer as skipped, not reattached', async () => {
    writePorts({ 'live-wt:opencode': { port: 4255 } });
    panesAlive('live-wt/opencode');
    resumeMock.mockResolvedValue(false);

    expect(await reattachOpencodeEventStreams()).toEqual({
      persisted: 1,
      candidates: 1,
      reattached: 0,
      skipped: 1,
    });
  });

  it('sweeps candidates concurrently so one dead port cannot delay the others', async () => {
    writePorts({
      'wt-a:opencode': { port: 4201 },
      'wt-b:opencode': { port: 4202 },
      'wt-c:opencode': { port: 4203 },
    });
    panesAlive('wt-a/opencode', 'wt-b/opencode', 'wt-c/opencode');

    let inFlight = 0;
    let peak = 0;
    const release: Array<() => void> = [];
    resumeMock.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((resolve) => release.push(resolve));
      inFlight -= 1;
      return true;
    });

    const sweep = reattachOpencodeEventStreams();
    // All three must be in flight before any of them is allowed to finish.
    await vi.waitFor(() => expect(release).toHaveLength(3));
    release.forEach((resolve) => resolve());

    expect(await sweep).toMatchObject({ candidates: 3, reattached: 3 });
    expect(peak).toBe(3);
  });
});

describe('[#2108] what the sweep refuses to touch', () => {
  it('leaves every other tool alone', async () => {
    // The acceptance condition "claude / codex / copilot / gemini / antigravity
    // / vibe-local の起動シーケンスが不変". None of them has a port, and a key
    // naming one must not be turned into an opencode target.
    writePorts({
      'live-wt:claude': { port: 4255 },
      'live-wt:codex': { port: 4256 },
      'live-wt:copilot': { port: 4257 },
    });
    panesAlive('live-wt/claude', 'live-wt/codex', 'live-wt/copilot');

    expect(await reattachOpencodeEventStreams()).toEqual({
      persisted: 0,
      candidates: 0,
      reattached: 0,
      skipped: 0,
    });
    expect(isRunningMock).not.toHaveBeenCalled();
    expect(resumeMock).not.toHaveBeenCalled();
  });

  it('asks tmux nothing when hook injection is off', async () => {
    writePorts({ 'live-wt:opencode': { port: 4255 } });
    panesAlive('live-wt/opencode');
    vi.stubEnv('CM_AGENT_HOOKS_INJECT', '0');

    expect(await reattachOpencodeEventStreams()).toEqual({
      persisted: 0,
      candidates: 0,
      reattached: 0,
      skipped: 0,
    });
    expect(isRunningMock).not.toHaveBeenCalled();
    expect(resumeMock).not.toHaveBeenCalled();
  });

  it('asks tmux nothing when the port file is absent or empty', async () => {
    writeFileSync(portFile, '{}\n');

    expect(await reattachOpencodeEventStreams()).toEqual({
      persisted: 0,
      candidates: 0,
      reattached: 0,
      skipped: 0,
    });
    expect(isRunningMock).not.toHaveBeenCalled();
  });

  it('carries on past a row the gateway refuses to answer for', async () => {
    // The file is writable by anything running as the user, and
    // `OpenCodeTool.getSessionName` throws on a worktree id with shell
    // metacharacters in it rather than building a tmux target out of it. One
    // bad row must not abandon the sweep.
    writePorts({
      'wt bad;rm:opencode': { port: 4258 },
      'live-wt:opencode': { port: 4255 },
    });
    isRunningMock.mockImplementation(async (worktreeId: string) => {
      if (worktreeId !== 'live-wt') throw new Error('Invalid session name');
      return true;
    });

    expect(await reattachOpencodeEventStreams()).toEqual({
      persisted: 2,
      candidates: 1,
      reattached: 1,
      skipped: 0,
    });
    expect(resumeMock).toHaveBeenCalledTimes(1);
    expect(resumeMock.mock.calls[0][0].worktreeId).toBe('live-wt');
  });

  it('returns an empty report rather than throwing when the gateway is unusable', async () => {
    writePorts({ 'live-wt:opencode': { port: 4255 } });
    getToolMock.mockImplementationOnce(() => {
      throw new Error('CLIToolManager is not available');
    });

    await expect(reattachOpencodeEventStreams()).resolves.toEqual({
      persisted: 0,
      candidates: 0,
      reattached: 0,
      skipped: 0,
    });
    expect(resumeMock).not.toHaveBeenCalled();
  });
});
