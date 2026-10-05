/**
 * Issue #3334 — `commandmate attach` to a session another CommandMate server
 * owns.
 *
 * `attach` found its session with `tmux has-session` — by NAME, which is all
 * two servers on one tmux socket share (#2865) — and attached with keys
 * enabled. A key typed there went to the other server's agent; `--live`
 * re-laid that agent's pane out.
 *
 * It now asks its server first (the capture route's ownership 409). The
 * operator named the session, and looking at it may be what they came for, so
 * the plain attach is not refused: it is made read-only. The two forms that
 * have no read-only shape — `--live`, and `switch-client` from inside tmux —
 * are refused before tmux is touched. An owned session, and a server that
 * cannot answer, attach exactly as before.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockFetchSequence, restoreFetch } from '../../../helpers/mock-api';
import { ExitCode } from '@/cli/types';
import { FOREIGN_SESSION_ERROR_CODE } from '@/cli/utils/api-client';

/** Every tmux argv the command runs, in order. */
const tmuxCalls: string[][] = [];

vi.mock('child_process', () => ({
  spawnSync: (_cmd: string, argv: string[]) => {
    tmuxCalls.push(argv);
    return { status: 0 };
  },
}));

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {
  throw new Error('process.exit');
}) as never);
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

const SESSION = 'mcbd-claude-wt1';
const TARGET = `=${SESSION}:`;
/**
 * The body `foreignSessionErrorBody` builds. Written out because importing the
 * server module would load the tmux gateway into this `child_process` mock;
 * the api-client suite pins the code to the server's constant.
 */
const FOREIGN = {
  data: {
    error: `tmux session "${SESSION}" belongs to another CommandMate server`,
    code: FOREIGN_SESSION_ERROR_CODE,
    sessionName: SESSION,
    sessionPath: '/other-server/wt1',
  },
  status: 409,
};

function resolveTarget(cliToolId = 'claude') {
  return { data: { cliToolId, instanceId: cliToolId, resolvedBy: 'worktree-default', conflict: null } };
}

/** The roster read `attach` makes for the session name: unreadable, so the legacy name is used. */
const NO_ROSTER = { data: {}, status: 200 };

/** The namespaced name (Issue #2866) the server's routes address for the same session. */
const NAMESPACED = 'mcbd-0a1b2c3d-claude-wt1';
const NAMESPACED_TARGET = `=${NAMESPACED}:`;

/** A roster that publishes the name the server uses (Issue #2867). */
function rosterPublishing(sessionName: string) {
  return { data: { agentInstances: [{ id: 'claude', cliToolId: 'claude', sessionName }] }, status: 200 };
}

/** The ownership 409, reporting the name the server checked. */
function foreignFor(sessionName: string) {
  return { data: { ...FOREIGN.data, error: `tmux session "${sessionName}" belongs to another CommandMate server`, sessionName }, status: 409 };
}

const OWN_CAPTURE = { data: { output: '' }, status: 200 };

async function runAttach(argv: string[]): Promise<void> {
  const { createAttachCommand } = await import('@/cli/commands/attach');
  try {
    await createAttachCommand().parseAsync(['node', 'attach', ...argv]);
  } catch (error) {
    if ((error as Error).message !== 'process.exit') throw error;
  }
}

function stderr(): string {
  return mockConsoleError.mock.calls.map((call) => String(call[0])).join('\n');
}

/** tmux commands that could put a key or a geometry change into the session. */
function writes(): string[][] {
  return tmuxCalls.filter((argv) => argv[0] !== 'has-session' && !(argv[0] === 'attach-session' && argv.includes('-r')));
}

function captureRequests(): Array<{ url: string; body: unknown }> {
  const calls = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls as Array<[unknown, RequestInit?]>;
  return calls
    .filter(([url]) => String(url).includes('/capture'))
    .map(([url, init]) => ({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined }));
}

beforeEach(() => {
  tmuxCalls.length = 0;
  delete process.env.TMUX;
});

afterEach(() => {
  restoreFetch();
  mockExit.mockClear();
  mockConsoleError.mockClear();
});

describe('[#3334] attach to a session another CommandMate server owns', () => {
  it('asks its server whose session it is, without reading more than a line', async () => {
    mockFetchSequence([resolveTarget(), NO_ROSTER, FOREIGN]);

    await runAttach(['wt1']);

    expect(captureRequests()).toEqual([
      { url: expect.stringContaining('/api/worktrees/wt1/capture'), body: { cliToolId: 'claude', lines: 1 } },
    ]);
  });

  it('attaches read-only, and says why', async () => {
    mockFetchSequence([resolveTarget(), NO_ROSTER, FOREIGN]);

    await runAttach(['wt1']);

    expect(tmuxCalls).toContainEqual(['attach-session', '-r', '-t', TARGET]);
    expect(writes()).toEqual([]);
    expect(stderr()).toContain(`"${SESSION}" belongs to another CommandMate server`);
    expect(stderr()).toContain('/other-server/wt1');
    expect(stderr()).toContain('READ-ONLY');
  });

  it('refuses --live before touching tmux beyond the name check', async () => {
    mockFetchSequence([resolveTarget(), NO_ROSTER, FOREIGN]);

    await runAttach(['wt1', '--live']);

    expect(mockExit).toHaveBeenCalledWith(ExitCode.UNEXPECTED_ERROR);
    expect(tmuxCalls.map((argv) => argv[0])).toEqual(['has-session']);
    expect(stderr()).toContain('belongs to another CommandMate server');
    expect(stderr()).toContain('--live would re-lay that session out');
  });

  it('refuses to switch-client from inside tmux, and prints the read-only attach instead', async () => {
    process.env.TMUX = '/tmp/tmux-501/default,123,0';
    mockFetchSequence([resolveTarget(), NO_ROSTER, FOREIGN]);

    await runAttach(['wt1']);

    expect(mockExit).toHaveBeenCalledWith(ExitCode.UNEXPECTED_ERROR);
    expect(tmuxCalls.some((argv) => argv[0] === 'switch-client')).toBe(false);
    expect(stderr()).toContain(`tmux attach -r -t '${TARGET}'`);
  });

  it('attaches with keys enabled when the server vouches for the name it published (control)', async () => {
    mockFetchSequence([resolveTarget(), rosterPublishing(NAMESPACED), OWN_CAPTURE]);

    await runAttach(['wt1']);

    expect(tmuxCalls).toContainEqual(['attach-session', '-t', NAMESPACED_TARGET]);
    expect(stderr()).not.toContain('another CommandMate server');
    expect(stderr()).not.toContain('READ-ONLY');
  });

  it('attaches read-only when the published name is another server\'s', async () => {
    mockFetchSequence([resolveTarget(), rosterPublishing(NAMESPACED), foreignFor(NAMESPACED)]);

    await runAttach(['wt1']);

    expect(tmuxCalls).toContainEqual(['attach-session', '-r', '-t', NAMESPACED_TARGET]);
    expect(writes()).toEqual([]);
    expect(stderr()).toContain('belongs to another CommandMate server');
  });

  it('attaches as before when the server cannot say (control)', async () => {
    // A server older than #2865 has no ownership 409; one that is down cannot
    // answer at all. Neither is a reason to stop an attach `has-session` allowed.
    mockFetchSequence([resolveTarget(), NO_ROSTER, { data: { error: 'Failed' }, status: 500 }]);

    await runAttach(['wt1']);

    expect(tmuxCalls).toContainEqual(['attach-session', '-t', TARGET]);
  });

  it('switches with keys enabled from inside tmux when the session is its own (control)', async () => {
    process.env.TMUX = '/tmp/tmux-501/default,123,0';
    mockFetchSequence([resolveTarget(), rosterPublishing(NAMESPACED), OWN_CAPTURE]);

    await runAttach(['wt1']);

    expect(tmuxCalls).toContainEqual(['switch-client', '-t', NAMESPACED_TARGET]);
  });
});

/**
 * The namespaced name and the legacy name can both exist on one tmux socket —
 * one this server's, the other another server's. When the roster cannot be
 * read, `attach` connects to the legacy name, while the server's `capture`
 * checks the namespaced one. Its answer is then about a different session and
 * must not be read as "yours".
 */
describe('[#3334] the server checked a different name than the one attach opens', () => {
  it('does not take a 200 about the namespaced name as owning the legacy one: read-only', async () => {
    mockFetchSequence([resolveTarget(), NO_ROSTER, OWN_CAPTURE]);

    await runAttach(['wt1']);

    expect(tmuxCalls).toContainEqual(['attach-session', '-r', '-t', TARGET]);
    expect(writes()).toEqual([]);
    expect(stderr()).toContain(`Could not confirm that tmux session "${SESSION}" is this CommandMate server's`);
    expect(stderr()).toContain('READ-ONLY');
  });

  it('refuses --live when the name could not be confirmed', async () => {
    mockFetchSequence([resolveTarget(), NO_ROSTER, OWN_CAPTURE]);

    await runAttach(['wt1', '--live']);

    expect(mockExit).toHaveBeenCalledWith(ExitCode.UNEXPECTED_ERROR);
    expect(tmuxCalls.map((argv) => argv[0])).toEqual(['has-session']);
    expect(stderr()).toContain('--live would re-lay that session out');
  });

  it('refuses switch-client from inside tmux when the name could not be confirmed', async () => {
    process.env.TMUX = '/tmp/tmux-501/default,123,0';
    mockFetchSequence([resolveTarget(), NO_ROSTER, OWN_CAPTURE]);

    await runAttach(['wt1']);

    expect(mockExit).toHaveBeenCalledWith(ExitCode.UNEXPECTED_ERROR);
    expect(tmuxCalls.some((argv) => argv[0] === 'switch-client')).toBe(false);
    expect(stderr()).toContain(`tmux attach -r -t '${TARGET}'`);
  });

  it('does not take a 409 about the namespaced name as being about the legacy one either: read-only, saying which name was checked', async () => {
    mockFetchSequence([resolveTarget(), NO_ROSTER, foreignFor(NAMESPACED)]);

    await runAttach(['wt1']);

    expect(tmuxCalls).toContainEqual(['attach-session', '-r', '-t', TARGET]);
    expect(stderr()).toContain(`the server checked "${NAMESPACED}"`);
  });
});
