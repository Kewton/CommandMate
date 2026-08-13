/**
 * Choosing — and remembering — the port an opencode instance serves on
 * (Issue #1763).
 *
 * Two measurements make this a real module rather than a constant:
 *
 *  - **`--port 0` is not "ask the OS".** #1758 §5.9.1 watched the first server
 *    take 4096 and only the second fall through to an ephemeral port. Several
 *    instances launched with 0 land on unpredictable numbers.
 *  - **The chosen port cannot be read back.** No port file, no lock file, no pid
 *    file anywhere under an isolated `HOME` (§5.9.2). The only sources are one
 *    stdout line behind a stderr warning, inside a tmux pane, and `lsof`.
 *
 * So CommandMate decides, and writes down what it decided — because a restart
 * loses the in-memory assignment while the pane keeps running, and re-deriving
 * from a hash would let two instances whose hashes collided adopt each other's
 * server.
 *
 * @vitest-environment node
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'net';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { makeTempDir, removeTempDir } from '@tests/helpers/temp-dir';

vi.mock('@/lib/hooks/sources/opencode/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/hooks/sources/opencode/client')>();
  return {
    ...actual,
    fetchOpencodeHealth: vi.fn().mockResolvedValue({ healthy: true, version: '1.18.3' }),
  };
});

import { fetchOpencodeHealth, OPENCODE_SERVER_HOST } from '@/lib/hooks/sources/opencode/client';
import {
  allocateOpencodePort,
  forgetOpencodePort,
  getAssignedOpencodePort,
  getOpencodePortFilePath,
  isPortFree,
  OPENCODE_PORT_RANGE,
  opencodePortCandidates,
  readPersistedOpencodePorts,
  recoverOpencodePort,
  rememberOpencodePort,
  resetOpencodePortAssignments,
} from '@/lib/hooks/sources/opencode/ports';

const TARGET = { worktreeId: 'wt-ports', cliToolId: 'opencode', instanceId: 'opencode' } as const;
const OTHER = { worktreeId: 'wt-ports-2', cliToolId: 'opencode', instanceId: 'opencode-2' } as const;
const WORKTREE_PATH = '/tmp/wt-ports';

let sandbox: string;
let portFile: string;
const listeners: Server[] = [];

/** Occupy a port for the duration of one test. */
function occupy(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, OPENCODE_SERVER_HOST, () => {
      listeners.push(server);
      resolve();
    });
  });
}

beforeAll(() => {
  sandbox = makeTempDir('opencode-ports-');
  portFile = join(sandbox, 'opencode-ports.json');
});

afterAll(() => {
  removeTempDir(sandbox);
});

beforeEach(() => {
  vi.clearAllMocks();
  resetOpencodePortAssignments();
  vi.stubEnv('CM_OPENCODE_PORT_FILE', portFile);
  vi.stubEnv('CM_AGENT_HOOKS_INJECT', '1');
  if (existsSync(portFile)) writeFileSync(portFile, '{}\n');
  vi.mocked(fetchOpencodeHealth).mockResolvedValue({ healthy: true, version: '1.18.3' });
});

afterEach(async () => {
  await Promise.all(listeners.splice(0).map((server) => new Promise((r) => server.close(r))));
  vi.unstubAllEnvs();
  resetOpencodePortAssignments();
});

describe('the file path', () => {
  it('is overridable, and defaults under the CommandMate home directory', () => {
    expect(getOpencodePortFilePath()).toBe(portFile);
    vi.stubEnv('CM_OPENCODE_PORT_FILE', '');
    expect(getOpencodePortFilePath()).toMatch(/\.commandmate[/\\]opencode-ports\.json$/);
  });
});

describe('allocation', () => {
  it('assigns a free port inside the range and writes it down', async () => {
    const port = await allocateOpencodePort(TARGET, WORKTREE_PATH);

    expect(port).not.toBeNull();
    expect(port).toBeGreaterThanOrEqual(OPENCODE_PORT_RANGE.min);
    expect(port).toBeLessThanOrEqual(OPENCODE_PORT_RANGE.max);
    // Deliberately not 4096: that is the number opencode's own `--port 0` grabs
    // first, so a hand-started `opencode serve` owns it.
    expect(port).not.toBe(4096);
    expect(getAssignedOpencodePort(TARGET)).toBe(port);
    expect(readPersistedOpencodePorts()[`${TARGET.worktreeId}:opencode`]).toMatchObject({
      port,
      worktreePath: WORKTREE_PATH,
    });
  });

  it('is idempotent within a process', async () => {
    const first = await allocateOpencodePort(TARGET, WORKTREE_PATH);
    const second = await allocateOpencodePort(TARGET, WORKTREE_PATH);
    expect(second).toBe(first);
  });

  it('prefers the number a previous run recorded', async () => {
    const first = await allocateOpencodePort(TARGET, WORKTREE_PATH);
    // A CommandMate restart: the file survives, the map does not.
    resetOpencodePortAssignments();
    expect(await allocateOpencodePort(TARGET, WORKTREE_PATH)).toBe(first);
  });

  it('skips a port something else is already listening on', async () => {
    const [preferred] = opencodePortCandidates(TARGET);
    await occupy(preferred);

    const port = await allocateOpencodePort(TARGET, WORKTREE_PATH);

    expect(port).not.toBeNull();
    expect(port).not.toBe(preferred);
    expect(await isPortFree(preferred)).toBe(false);
  });

  it('gives two instances two ports', async () => {
    const first = await allocateOpencodePort(TARGET, WORKTREE_PATH);
    const second = await allocateOpencodePort(OTHER, '/tmp/wt-ports-2');
    expect(first).not.toBeNull();
    expect(second).not.toBe(first);
  });

  it('assigns nothing when structured events are switched off', async () => {
    // `CM_AGENT_HOOKS_INJECT=0` is the rollback. No port means no `--port`,
    // which means the pre-#1763 bare TUI.
    vi.stubEnv('CM_AGENT_HOOKS_INJECT', '0');
    expect(await allocateOpencodePort(TARGET, WORKTREE_PATH)).toBeNull();
    expect(getAssignedOpencodePort(TARGET)).toBeNull();
  });
});

describe('recovery after a CommandMate restart', () => {
  it('reads the recorded port back and health-checks it', async () => {
    rememberOpencodePort(TARGET, 4242, WORKTREE_PATH);
    resetOpencodePortAssignments();

    expect(await recoverOpencodePort(TARGET, WORKTREE_PATH)).toBe(4242);
    expect(vi.mocked(fetchOpencodeHealth)).toHaveBeenCalledWith(4242);
    expect(getAssignedOpencodePort(TARGET)).toBe(4242);
  });

  it('refuses a port nothing answers on', async () => {
    // The pane died while CommandMate was down. Subscribing here would spend
    // the session reconnecting to a port with nothing behind it.
    rememberOpencodePort(TARGET, 4242, WORKTREE_PATH);
    resetOpencodePortAssignments();
    vi.mocked(fetchOpencodeHealth).mockResolvedValue(null);

    expect(await recoverOpencodePort(TARGET, WORKTREE_PATH)).toBeNull();
  });

  it('refuses an entry recorded for a different worktree path', async () => {
    // The check that stops a stale or foreign entry from attaching this
    // instance to somebody else's server, which would file its events against
    // the wrong worktree — silently.
    rememberOpencodePort(TARGET, 4242, WORKTREE_PATH);
    resetOpencodePortAssignments();

    expect(await recoverOpencodePort(TARGET, '/tmp/somewhere-else')).toBeNull();
    expect(vi.mocked(fetchOpencodeHealth)).not.toHaveBeenCalled();
  });

  it('recovers nothing when nothing was recorded', async () => {
    expect(await recoverOpencodePort(TARGET, WORKTREE_PATH)).toBeNull();
  });

  it('recovers nothing when structured events are switched off', async () => {
    rememberOpencodePort(TARGET, 4242, WORKTREE_PATH);
    resetOpencodePortAssignments();
    vi.stubEnv('CM_AGENT_HOOKS_INJECT', '0');
    expect(await recoverOpencodePort(TARGET, WORKTREE_PATH)).toBeNull();
  });
});

describe('release', () => {
  it('drops the assignment from memory and from the file', async () => {
    await allocateOpencodePort(TARGET, WORKTREE_PATH);
    forgetOpencodePort(TARGET);

    expect(getAssignedOpencodePort(TARGET)).toBeNull();
    expect(readPersistedOpencodePorts()).toEqual({});
  });
});

describe('robustness', () => {
  it('treats an unreadable file as "nothing recorded"', () => {
    writeFileSync(portFile, 'not json at all');
    expect(readPersistedOpencodePorts()).toEqual({});
  });

  it('ignores entries that are not assignments', () => {
    writeFileSync(portFile, JSON.stringify({ a: 'nope', b: { port: 'x' }, c: { port: 4242, worktreePath: '/w' } }));
    expect(Object.keys(readPersistedOpencodePorts())).toEqual(['c']);
  });

  it('never throws when the file cannot be written', () => {
    // A directory where a file has to go: every platform answers ENOTDIR
    // immediately. Losing the record costs recovery, never the launch.
    vi.stubEnv('CM_OPENCODE_PORT_FILE', join(portFile, 'child.json'));
    expect(() => rememberOpencodePort(TARGET, 4242, WORKTREE_PATH)).not.toThrow();
    expect(getAssignedOpencodePort(TARGET)).toBe(4242);
  });

  it('keeps candidate order stable for one instance', () => {
    // The preference that makes a pane's port look the same across restarts to
    // anybody reading `lsof`.
    expect(opencodePortCandidates(TARGET)).toEqual(opencodePortCandidates(TARGET));
    expect(opencodePortCandidates(TARGET)).toHaveLength(
      OPENCODE_PORT_RANGE.max - OPENCODE_PORT_RANGE.min + 1
    );
  });
});

describe('the persisted-port file itself', () => {
  it('round-trips through the on-disk representation', () => {
    rememberOpencodePort(TARGET, 4242, WORKTREE_PATH, 1_700_000_000_000);
    const parsed = JSON.parse(readFileSync(portFile, 'utf8')) as Record<string, unknown>;
    expect(parsed).toEqual({
      'wt-ports:opencode': {
        port: 4242,
        worktreePath: WORKTREE_PATH,
        updatedAt: 1_700_000_000_000,
      },
    });
  });
});
