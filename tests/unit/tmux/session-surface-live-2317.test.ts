/**
 * Issue #2317 — the tmux surface against a REAL tmux server.
 *
 * `session-status-options-2317.test.ts` and `session-hooks-2317.test.ts` assert
 * the argv against a mock. A mock cannot answer the two questions this Issue's
 * acceptance conditions actually ask:
 *
 *  - does `tmux ls -F '#{@cm_status}'` come back with the new state (Phase B 1)?
 *  - do the GLOBAL `status-right` / `status-left` / prefix key table survive
 *    untouched (Phase B 3)?
 *
 * and neither can it show that Phase D's hand-over and hand-back actually move a
 * window. So this file drives a real server and reads the state back.
 *
 * ## Safety — read before touching any tmux invocation here
 *
 * The rules are `tests/unit/tmux-history-limit.live.test.ts`'s, for the reason
 * given there in full: on 2026-08-02 a live tmux test isolated itself with
 * `TMUX_TMPDIR`, which is inert whenever `$TMUX` is set — and every CommandMate
 * agent runs inside a tmux pane — so every call landed on the user's real server
 * and the teardown destroyed every `mcbd-*` session on the machine.
 *
 * 1. **Every tmux call this file makes itself is pinned with `-L`.** An explicit
 *    `-L` beats `$TMUX` (measured on 3.5a).
 * 2. **`process.env.TMUX` is repointed at that private server**, because the
 *    modules under test take no socket argument. `expectIsolated()` asserts the
 *    redirect held, so a regression fails the test instead of leaking.
 * 3. **Nothing here writes a server-global option or a key binding**, on the
 *    private server or anywhere else. The global state is only ever READ, before
 *    and after, which is the assertion.
 *
 * Skipped automatically when tmux is not installed (e.g. minimal CI images).
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { TUI_PANE_HEIGHT, TUI_PANE_WIDTH } from '@/config/tmux-pane-config';
import { CM_STATUS_RIGHT_FORMAT } from '@/lib/session/tmux-session-surface';
import { removeTempDir } from '@tests/helpers/temp-dir';

const execFileAsync = promisify(execFile);

/** Socket name of this file's private tmux server. Never `default`. */
const SOCKET = 'cm2317-live-test';

/** Keeps the private server alive between tests so `-L` never races startup. */
const HOLDER_SESSION = 'cm2317-holder';

/** Sessions the modules under test are pointed at, listed so strays are swept. */
const TEST_SESSIONS = ['mcbd-claude-cm2317b', 'mcbd-claude-cm2317d', 'mcbd-claude-cm2317off'];

let tmuxAvailable = false;
let workDir: string | undefined;
let previousTmux: string | undefined;

/** Runs tmux against THIS FILE'S server. Never resolves to the ambient one. */
async function tmuxctl(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('tmux', ['-L', SOCKET, ...args], { timeout: 5000 });
  return stdout.trim();
}

/**
 * A user option's value, or '' when it is not set.
 *
 * MEASURED, and it is why every reader of `@cm_*` in `src/` is wrapped in a
 * try/catch: `show-options -v -t <session> @cm_x` on a session that does not
 * carry the option exits NON-ZERO with `invalid option: @cm_x` on stdout's
 * sibling. It is not an empty string and it is not exit 0.
 */
async function userOption(sessionName: string, option: string): Promise<string> {
  return tmuxctl(['show-options', '-v', '-t', `=${sessionName}:`, option]).catch(() => '');
}

async function sessionExistsOn(socketName: string, sessionName: string): Promise<boolean> {
  return execFileAsync('tmux', ['-L', socketName, 'has-session', '-t', `=${sessionName}:`], {
    timeout: 5000,
  })
    .then(() => true)
    .catch(() => false);
}

/** Proves the `process.env.TMUX` redirect held for this session. */
async function expectIsolated(sessionName: string): Promise<void> {
  expect(await sessionExistsOn(SOCKET, sessionName)).toBe(true);
  expect(await sessionExistsOn('default', sessionName)).toBe(false);
}

/** The server-global state Phase B is not allowed to disturb. */
async function globalSnapshot(): Promise<string> {
  const statusRight = await tmuxctl(['show-options', '-g', 'status-right']);
  const statusLeft = await tmuxctl(['show-options', '-g', 'status-left']);
  const prefixKeys = await tmuxctl(['list-keys', '-T', 'prefix']);
  return [statusRight, statusLeft, prefixKeys].join('\n');
}

async function makeSession(sessionName: string): Promise<void> {
  await tmuxctl([
    'new-session', '-d', '-s', sessionName, '-c', workDir!,
    '-x', String(TUI_PANE_WIDTH), '-y', String(TUI_PANE_HEIGHT),
  ]);
  await tmuxctl(['set-window-option', '-t', `=${sessionName}:`, 'window-size', 'manual']);
}

beforeAll(async () => {
  try {
    await execFileAsync('tmux', ['-V'], { timeout: 5000 });
  } catch {
    return;
  }

  workDir = mkdtempSync(path.join(tmpdir(), 'cm-2317-work-'));

  // A leftover server from an aborted run would carry stale options into these
  // assertions. `-L` makes this reachable only on the private socket.
  await execFileAsync('tmux', ['-L', SOCKET, 'kill-server'], { timeout: 5000 }).catch(
    () => undefined,
  );

  await tmuxctl(['new-session', '-d', '-s', HOLDER_SESSION, '-c', workDir, '-x', '80', '-y', '24']);
  const socketPath = await tmuxctl(['display-message', '-p', '#{socket_path}']);
  const serverPid = await tmuxctl(['display-message', '-p', '#{pid}']);

  // Belt for the `-L` braces: if the socket ever resolved to `default`, the
  // redirect below would aim the modules under test at the user's real server.
  if (!socketPath.endsWith(`/${SOCKET}`)) {
    throw new Error(`refusing to run: private socket resolved to ${socketPath}`);
  }

  previousTmux = process.env.TMUX;
  process.env.TMUX = `${socketPath},${serverPid},0`;

  tmuxAvailable = true;
});

afterAll(async () => {
  // `-L` is explicit, so this cannot reach the ambient server no matter what
  // `$TMUX` holds at this point. This is the ONLY kill-server in the file.
  await execFileAsync('tmux', ['-L', SOCKET, 'kill-server'], { timeout: 5000 }).catch(
    () => undefined,
  );

  if (previousTmux === undefined) delete process.env.TMUX;
  else process.env.TMUX = previousTmux;

  // If the redirect ever failed, `expectIsolated` fails the test and the sessions
  // are left on the ambient server. Sweep exactly those names — `=name:` is an
  // exact match, so no other `mcbd-*` session can be caught by it.
  if (tmuxAvailable) {
    for (const name of TEST_SESSIONS) {
      await execFileAsync('tmux', ['kill-session', '-t', `=${name}:`], { timeout: 5000 }).catch(
        () => undefined,
      );
    }
  }

  if (workDir) removeTempDir(workDir);
});

describe('Phase B against a real tmux server (Issue #2317)', () => {
  it('publishes a status `tmux ls` can read, without disturbing anything global', async () => {
    if (!tmuxAvailable) return;
    const { publishSessionStatus, forgetSessionStatus } = await import(
      '@/lib/tmux/session-status-options'
    );
    const sessionName = 'mcbd-claude-cm2317b';

    await makeSession(sessionName);
    await expectIsolated(sessionName);
    const before = await globalSnapshot();

    expect(
      await publishSessionStatus({
        sessionName,
        worktreeId: 'cm2317-wt',
        cliToolId: 'claude',
        instanceId: 'claude',
        status: 'running',
      }),
    ).toBe('written');

    // 受入条件 Phase B 1: `tmux ls -F '#{@cm_status}'` returns the new state.
    const listed = await tmuxctl(['list-sessions', '-F', '#{session_name} #{@cm_status} #{@cm_tool}/#{@cm_instance} #{@cm_worktree}']);
    expect(listed).toContain(`${sessionName} running claude/claude cm2317-wt`);
    expect(await userOption(sessionName, '@cm_updated')).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // 受入条件 Phase B 2: the attached status line carries the chip.
    expect(await tmuxctl(['show-options', '-t', `=${sessionName}:`, 'status-right'])).toContain(
      CM_STATUS_RIGHT_FORMAT,
    );

    // 受入条件 Phase B 3: nothing server-global moved.
    expect(await globalSnapshot()).toBe(before);

    // A transition is visible within the same poll it happens in.
    await publishSessionStatus({
      sessionName,
      worktreeId: 'cm2317-wt',
      cliToolId: 'claude',
      instanceId: 'claude',
      status: 'waiting',
    });
    expect(await userOption(sessionName, '@cm_status')).toBe('waiting');

    forgetSessionStatus(sessionName);
  });

  it('CM_TMUX_STATUS=off removes the options and the status line it installed', async () => {
    if (!tmuxAvailable) return;
    const { publishSessionStatus, forgetSessionStatus } = await import(
      '@/lib/tmux/session-status-options'
    );
    const sessionName = 'mcbd-claude-cm2317off';

    await makeSession(sessionName);
    await expectIsolated(sessionName);
    await publishSessionStatus({
      sessionName,
      worktreeId: 'cm2317-wt',
      cliToolId: 'claude',
      instanceId: 'claude',
      status: 'running',
    });
    expect(await userOption(sessionName, '@cm_status')).toBe('running');

    // The uninstall path: an operator sets the variable and restarts, and the
    // first poll after that restart takes the surface back off.
    forgetSessionStatus(sessionName);
    process.env.CM_TMUX_STATUS = 'off';
    try {
      expect(
        await publishSessionStatus({
          sessionName,
          worktreeId: 'cm2317-wt',
          cliToolId: 'claude',
          instanceId: 'claude',
          status: 'waiting',
        }),
      ).toBe('disabled');
    } finally {
      delete process.env.CM_TMUX_STATUS;
    }

    expect(await userOption(sessionName, '@cm_status')).toBe('');
    expect(await tmuxctl(['show-options', '-t', `=${sessionName}:`, 'status-right'])).toBe('');

    forgetSessionStatus(sessionName);
  });
});

describe('Phase D against a real tmux server (Issue #2317)', () => {
  it('hands the canvas over and takes it back, with no client attached', async () => {
    if (!tmuxAvailable) return;
    const { buildDelegateGeometryCommands } = await import('@/lib/session/tmux-session-surface');
    const { reconcileDelegatedGeometry } = await import('@/lib/tmux/session-hooks');
    const { resetGeometryDelegationState } = await import('@/lib/tmux/geometry-delegation');
    const sessionName = 'mcbd-claude-cm2317d';

    await makeSession(sessionName);
    await expectIsolated(sessionName);
    expect(await tmuxctl(['display-message', '-p', '-t', `=${sessionName}:`, '#{window_width}x#{window_height}'])).toBe(
      `${TUI_PANE_WIDTH}x${TUI_PANE_HEIGHT}`,
    );

    // The hand-over, run exactly as `commandmate attach --live` runs it.
    for (const argv of buildDelegateGeometryCommands(sessionName)) {
      await tmuxctl(argv);
    }
    expect(await tmuxctl(['show-window-options', '-t', `=${sessionName}:`, '-v', 'window-size'])).toBe(
      'latest',
    );
    expect(await userOption(sessionName, '@cm_delegated')).toBe('1');

    // The hand-back. No human client is attached — which is exactly the state a
    // detach leaves behind — so the poll's safety net takes the window back.
    resetGeometryDelegationState();
    expect(await reconcileDelegatedGeometry(sessionName)).toBe(true);

    expect(await tmuxctl(['show-window-options', '-t', `=${sessionName}:`, '-v', 'window-size'])).toBe(
      'manual',
    );
    expect(await tmuxctl(['display-message', '-p', '-t', `=${sessionName}:`, '#{window_width}x#{window_height}'])).toBe(
      `${TUI_PANE_WIDTH}x${TUI_PANE_HEIGHT}`,
    );
    expect(await userOption(sessionName, '@cm_delegated')).toBe('');

    // And it is idempotent: a second pass finds nothing to do.
    resetGeometryDelegationState();
    expect(await reconcileDelegatedGeometry(sessionName)).toBe(false);
  });
});
