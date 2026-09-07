/**
 * "You are talking to a different server than the one that started you"
 * (Issue #2404).
 *
 * The failure this pins is one nobody could name. `whoami` answers from the
 * tmux session name and therefore succeeds; `ls` / `instances` / `peers` answer
 * from the ledger of whichever server the CLI dialled and therefore say the
 * worktree does not exist. Both are right, they contradict each other, and the
 * agent that hit it in #2403 drew the only conclusion available — "I must not
 * be registered" — and sent its work to an unrelated worktree on the other
 * server. Every command involved exited 0.
 *
 * So what is asserted here is not a message but a *contradiction being named*:
 *
 *   - the flag and the URL are on `whoami --json`, which is what a skill reads;
 *   - the warning is on stderr, so `--json` stdout still parses;
 *   - the exit code does NOT change: whoami answered the question it was asked;
 *   - a matching session says nothing at all (the negative control), because a
 *     warning that fires in the ordinary case is a warning nobody reads;
 *   - an unreachable server is NOT a mismatch: a stopped daemon must not be
 *     reported as the wrong daemon.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { mockFetchSequence, restoreFetch } from '../../../helpers/mock-api';

const spawnSync = vi.hoisted(() => vi.fn());
vi.mock('child_process', () => ({ spawnSync }));

/**
 * ~/.commandmate/.env, stubbed empty: the URL these tests assert must come from
 * the test's own CM_PORT, never from the developer's machine (Issue #1743's
 * arrangement in api-client.test.ts, for the same reason).
 */
const dotenvMock = vi.hoisted(() => ({ config: vi.fn(() => ({ parsed: {} })) }));
vi.mock('dotenv', () => ({
  config: dotenvMock.config,
  default: { config: dotenvMock.config },
}));
vi.mock('../../../../src/cli/utils/env-setup', () => ({
  getEnvPath: vi.fn(() => '/mock/.commandmate/.env'),
}));

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

const SAVED_ENV = { ...process.env };

/** The server this CLI is (wrongly) dialling in every test below. */
const SERVER_URL = 'http://127.0.0.1:3011';

beforeEach(() => {
  spawnSync.mockReset();
  dotenvMock.config.mockReturnValue({ parsed: {} });
  for (const key of [
    'TMUX',
    'CM_WORKTREE_ID', 'CM_INSTANCE_ID', 'CM_CLI_TOOL',
    'CM_AGENT_WORKTREE_ID', 'CM_AGENT_INSTANCE_ID', 'CM_AGENT_TOOL',
    'CM_LAUNCHED_BY', 'CM_BIND', 'CM_HTTPS_CERT', 'CM_HTTPS_KEY',
  ]) {
    delete process.env[key];
  }
  process.env.CM_PORT = '3011';
});

afterEach(() => {
  restoreFetch();
  mockExit.mockClear();
  mockConsoleLog.mockClear();
  mockConsoleError.mockClear();
  process.env = { ...SAVED_ENV };
});

/** Make `tmux display-message` answer with `name`. */
function inTmux(name: string): void {
  process.env.TMUX = '/tmp/tmux-501/default,123,0';
  spawnSync.mockReturnValue({ status: 0, stdout: `${name}\n` });
}

function stdout(): string {
  return mockConsoleLog.mock.calls.flat().join('\n');
}

function stderr(): string {
  return mockConsoleError.mock.calls.flat().join('\n');
}

/** A worktree row as GET /api/worktrees sends it. */
function worktree(overrides: Record<string, unknown> = {}) {
  return {
    id: 'anvil-develop',
    name: 'develop',
    branch: 'develop',
    cliToolId: 'claude',
    repositoryPath: '/repos/anvil',
    repositoryName: 'anvil',
    isSessionRunning: true,
    agentInstances: [{ id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 }],
    ...overrides,
  };
}

describe('whoami: the session belongs to another server (Issue #2404)', () => {
  it('flags the mismatch and names the server it asked, in --json', async () => {
    // The exact shape of #2403: the pane is `rag-document`, and the ledger this
    // CLI can reach has never heard of it.
    inTmux('mcbd-command-code-rag-document');
    mockFetchSequence([
      { data: { worktrees: [worktree()], repositories: [] } },
      { data: { error: 'Worktree not found' }, status: 404 },
    ]);

    const { createWhoamiCommand } = await import('../../../../src/cli/commands/whoami');
    await createWhoamiCommand().parseAsync(['node', 'whoami', '--json']);

    const payload = JSON.parse(stdout());
    expect(payload).toMatchObject({
      worktreeId: 'rag-document',
      instanceId: 'command-code',
      source: 'tmux-session',
      serverMismatch: true,
      serverUrl: SERVER_URL,
    });
  });

  it('warns on stderr and still exits 0', async () => {
    inTmux('mcbd-command-code-rag-document');
    mockFetchSequence([
      { data: { worktrees: [worktree()], repositories: [] } },
      { data: { error: 'Worktree not found' }, status: 404 },
    ]);

    const { createWhoamiCommand } = await import('../../../../src/cli/commands/whoami');
    await createWhoamiCommand().parseAsync(['node', 'whoami']);

    const warning = stderr();
    expect(warning).toContain("worktree 'rag-document'");
    expect(warning).toContain(SERVER_URL);
    expect(warning).toContain('DIFFERENT CommandMate server');
    // The answer is still printed, and the command still succeeded: whoami knew
    // who it was. Changing the exit code here would break every caller that
    // uses `whoami` as the "am I in a session" probe.
    expect(stdout()).toContain('worktree:  rag-document');
    expect(stdout()).toContain(`server:    ${SERVER_URL}`);
    expect(mockExit).not.toHaveBeenCalled();
  });

  it('says nothing when the worktree IS on the server (negative control)', async () => {
    inTmux('mcbd-claude-anvil-develop');
    mockFetchSequence([
      { data: { worktrees: [worktree()], repositories: [] } },
      { data: { agentInstances: worktree().agentInstances } },
    ]);

    const { createWhoamiCommand } = await import('../../../../src/cli/commands/whoami');
    await createWhoamiCommand().parseAsync(['node', 'whoami', '--json']);

    const payload = JSON.parse(stdout());
    // Absent, not `false`: an ordinary session's output carries no trace of the
    // check having run.
    expect('serverMismatch' in payload).toBe(false);
    // The URL is not a warning, so it is always there — it is the evidence for
    // whichever answer this is.
    expect(payload.serverUrl).toBe(SERVER_URL);
    expect(stderr()).toBe('');
  });

  it('does not call a stopped server a wrong server', async () => {
    // readWorktreeIds() returns null when the list cannot be read, and null is
    // "no evidence", not "no worktree".
    inTmux('mcbd-command-code-rag-document');
    mockFetchSequence([
      { data: { error: 'boom' }, status: 500 },
      { data: { error: 'boom' }, status: 500 },
    ]);

    const { createWhoamiCommand } = await import('../../../../src/cli/commands/whoami');
    await createWhoamiCommand().parseAsync(['node', 'whoami', '--json']);

    const payload = JSON.parse(stdout());
    expect('serverMismatch' in payload).toBe(false);
    expect(payload.worktreeId).toBe('rag-document');
    expect(stderr()).toBe('');
  });

  it('cannot flag an identity that came from the launch environment, which reads no list', async () => {
    // The env path asks the server nothing, so it has no evidence either way —
    // and inventing a request to get some would slow the common case down for a
    // check that `peers` performs for free.
    process.env.CM_AGENT_WORKTREE_ID = 'rag-document';
    process.env.CM_AGENT_INSTANCE_ID = 'command-code';
    process.env.CM_AGENT_TOOL = 'command-code';
    mockFetchSequence([{ data: { agentInstances: [] } }]);

    const { createWhoamiCommand } = await import('../../../../src/cli/commands/whoami');
    await createWhoamiCommand().parseAsync(['node', 'whoami', '--json']);

    const payload = JSON.parse(stdout());
    expect(payload.source).toBe('env');
    expect('serverMismatch' in payload).toBe(false);
    expect(payload.serverUrl).toBe(SERVER_URL);
  });
});

describe('detectServerMismatch (Issue #2404)', () => {
  const identity = {
    worktreeId: 'rag-document',
    instanceId: 'command-code',
    cliToolId: 'command-code',
    source: 'tmux-session' as const,
    sessionName: 'mcbd-command-code-rag-document',
  };

  it('fires when the id is absent from the list', async () => {
    const { detectServerMismatch } =
      await import('../../../../src/cli/commands/whoami');

    expect(detectServerMismatch(identity, new Set(['anvil-develop']), SERVER_URL))
      .toEqual({ worktreeId: 'rag-document', serverUrl: SERVER_URL, source: 'tmux-session' });
  });

  it('does not fire when the id is present, nor when there is no list', async () => {
    const { detectServerMismatch } =
      await import('../../../../src/cli/commands/whoami');

    expect(detectServerMismatch(identity, new Set(['rag-document']), SERVER_URL)).toBeNull();
    expect(detectServerMismatch(identity, null, SERVER_URL)).toBeNull();
    expect(detectServerMismatch(identity, undefined, SERVER_URL)).toBeNull();
  });

  it('fires on an EMPTY list, which is a server that has no such worktree', async () => {
    const { detectServerMismatch } =
      await import('../../../../src/cli/commands/whoami');

    // Distinct from null above: the server answered, and its answer was "none".
    expect(detectServerMismatch(identity, new Set(), SERVER_URL)).not.toBeNull();
  });
});

describe('instances: a 404 that is not a typo (Issue #2404)', () => {
  it('names the server and says the id is not the problem', async () => {
    inTmux('mcbd-command-code-rag-document');
    mockFetchSequence([
      // GET /api/worktrees/rag-document — the roster this server does not have
      { data: { error: 'Worktree not found' }, status: 404 },
      // the diagnosis: GET /api/worktrees, which does not list rag-document
      { data: { worktrees: [worktree()], repositories: [] } },
    ]);

    const { createInstancesCommand } = await import('../../../../src/cli/commands/instances');
    await createInstancesCommand().parseAsync(['node', 'instances', 'rag-document']);

    const errors = stderr();
    // The URL rides on the generic message itself, so every command's 404 says
    // which server answered — not only the ones that can diagnose further.
    expect(errors).toContain(`Resource not found. Check the worktree ID. (server: ${SERVER_URL})`);
    expect(errors).toContain("Hint: this session is worktree 'rag-document'");
    expect(errors).toContain('different CommandMate server');
    // Unchanged: this is still a failed lookup.
    expect(mockExit).toHaveBeenCalledWith(99);
  });

  it('adds no hint when the caller is not inside a session at all', async () => {
    // An orchestrator shell mistyping an id must still be told to check the id.
    mockFetchSequence([{ data: { error: 'Worktree not found' }, status: 404 }]);

    const { createInstancesCommand } = await import('../../../../src/cli/commands/instances');
    await createInstancesCommand().parseAsync(['node', 'instances', 'no-such-worktree']);

    const errors = stderr();
    expect(errors).toContain('Resource not found. Check the worktree ID.');
    expect(errors).not.toContain('Hint:');
  });
});

describe('peers: an empty listing that is really a wrong server (Issue #2404)', () => {
  it('warns, flags and names the server instead of reporting no siblings', async () => {
    // `peers` has the whole worktree list in hand, so it can check an identity
    // the environment named — which whoami's env path cannot do for free.
    process.env.CM_WORKTREE_ID = 'rag-document';
    process.env.CM_INSTANCE_ID = 'command-code';
    process.env.CM_CLI_TOOL = 'command-code';
    mockFetchSequence([{ data: { worktrees: [worktree()], repositories: [] } }]);

    const { createPeersCommand } = await import('../../../../src/cli/commands/peers');
    await createPeersCommand().parseAsync(['node', 'peers', '--json']);

    const payload = JSON.parse(stdout());
    expect(payload.peers).toEqual([]);
    expect(payload.serverMismatch).toBe(true);
    expect(payload.serverUrl).toBe(SERVER_URL);
    // `self` keeps answering only "who is asking" — the connection target is
    // its own field, so nothing that reads `self` has to change.
    expect(payload.self).toEqual({
      worktreeId: 'rag-document',
      instanceId: 'command-code',
      cliToolId: 'command-code',
    });
    expect(stderr()).toContain('does not list it');
    expect(mockExit).not.toHaveBeenCalled();
  });

  it('says nothing when the caller is in the listing (negative control)', async () => {
    process.env.CM_WORKTREE_ID = 'anvil-develop';
    process.env.CM_INSTANCE_ID = 'claude';
    process.env.CM_CLI_TOOL = 'claude';
    mockFetchSequence([{ data: { worktrees: [worktree()], repositories: [] } }]);

    const { createPeersCommand } = await import('../../../../src/cli/commands/peers');
    await createPeersCommand().parseAsync(['node', 'peers', '--json']);

    const payload = JSON.parse(stdout());
    expect('serverMismatch' in payload).toBe(false);
    expect(payload.serverUrl).toBe(SERVER_URL);
    expect(stderr()).toBe('');
  });
});
