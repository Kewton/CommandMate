/**
 * Issue #1624 — live tmux verification of the pane scrollback fix.
 *
 * `tests/unit/tmux.test.ts` asserts the pane's history_limit against a MODEL of
 * tmux (child_process is mocked there). A model can be confidently wrong, and
 * this bug existed precisely because a test asserted on the command that was
 * issued rather than on the state it produced. This file closes that gap by
 * driving a REAL tmux server and reading `#{history_limit}` back off the pane.
 *
 * ## Safety — read before touching any tmux invocation here
 *
 * An earlier revision of this file isolated itself with `TMUX_TMPDIR` and tore
 * down with a bare `tmux kill-server`. That is WRONG and it destroyed a live
 * server: `TMUX_TMPDIR` is only consulted when `$TMUX` is UNSET, and a
 * CommandMate agent runs inside a tmux pane, so `$TMUX` is always set and always
 * points at the user's real server. Every tmux call — including the ones inside
 * `createSession` — went to that server, all three tests passed against it, and
 * `kill-server` then took down every `mcbd-*` session on the machine.
 *
 * The two rules that replace it (both measured on tmux 3.5a):
 *
 * 1. **Every tmux call this file makes itself is pinned with `-L`.** An explicit
 *    `-L` beats `$TMUX` (verified: with `TMUX` pointing at server A, `tmux -L B
 *    ls` lists B's sessions). `kill-server` is therefore only ever reachable on
 *    this file's private socket, whatever the ambient environment says.
 * 2. **`process.env.TMUX` is repointed at that private server** for the duration
 *    of the file. `src/lib/tmux/tmux.ts` takes no socket argument, so this is the
 *    only lever that redirects production code (verified: with `TMUX` pointing at
 *    server A, a flagless `tmux new-session -d` lands on A and nothing reaches
 *    the default socket). `expectIsolated()` asserts that redirect held for every
 *    session, so a regression here fails the test instead of leaking.
 *
 * Skipped automatically when tmux is not installed (e.g. minimal CI images).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { TMUX_HISTORY_LIMIT } from '@/config/tmux-pane-config';

const execFileAsync = promisify(execFile);

/** tmux's compiled-in default — what a pane gets when the option is set too late. */
const TMUX_BUILTIN_HISTORY_LIMIT = 2000;

/**
 * Socket name of this file's private tmux server. Anything but `default`, which
 * is where every interactive session and every CommandMate agent lives.
 */
const SOCKET = 'cm1624-live-test';

/** Keeps the private server alive between tests so `-L` never races startup. */
const HOLDER_SESSION = 'cm1624-holder';

/** Sessions `createSession` is pointed at, listed so strays can be swept up. */
const TEST_SESSIONS = ['cm1624-pane', 'cm1624-geometry', 'cm1624-global'];

let tmuxAvailable = false;
let socketPath: string | undefined;
let previousTmux: string | undefined;
let workDir: string | undefined;

/** Runs tmux against THIS FILE'S server. Never resolves to the ambient one. */
async function tmuxctl(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('tmux', ['-L', SOCKET, ...args], { timeout: 5000 });
  return stdout.trim();
}

async function tmuxQuery(sessionName: string, format: string): Promise<string> {
  return tmuxctl(['display-message', '-p', '-t', `=${sessionName}:`, format]);
}

async function sessionExistsOn(socketName: string, sessionName: string): Promise<boolean> {
  return execFileAsync('tmux', ['-L', socketName, 'has-session', '-t', `=${sessionName}:`], {
    timeout: 5000,
  })
    .then(() => true)
    .catch(() => false);
}

/**
 * Proves the `process.env.TMUX` redirect actually held for this session: present
 * on the private server, absent from the ambient `default` one. Without this the
 * suite would keep passing while silently operating on the user's real server —
 * which is exactly how the original version of this file went unnoticed.
 */
async function expectIsolated(sessionName: string): Promise<void> {
  expect(await sessionExistsOn(SOCKET, sessionName)).toBe(true);
  expect(await sessionExistsOn('default', sessionName)).toBe(false);
}

beforeAll(async () => {
  try {
    await execFileAsync('tmux', ['-V'], { timeout: 5000 });
  } catch {
    return;
  }

  workDir = mkdtempSync(path.join(tmpdir(), 'cm-1624-work-'));

  // A leftover server from an aborted run would carry stale options into these
  // assertions. `-L` makes this reachable only on the private socket.
  await execFileAsync('tmux', ['-L', SOCKET, 'kill-server'], { timeout: 5000 }).catch(
    () => undefined,
  );

  await tmuxctl(['new-session', '-d', '-s', HOLDER_SESSION, '-c', workDir, '-x', '80', '-y', '24']);
  socketPath = await tmuxctl(['display-message', '-p', '#{socket_path}']);
  const serverPid = await tmuxctl(['display-message', '-p', '#{pid}']);

  // Belt for the `-L` braces: if the socket ever resolved to `default`, the
  // redirect below would aim production code at the user's real server.
  if (!socketPath.endsWith(`/${SOCKET}`)) {
    throw new Error(`refusing to run: private socket resolved to ${socketPath}`);
  }

  previousTmux = process.env.TMUX;
  process.env.TMUX = `${socketPath},${serverPid},0`;

  // Set last: afterAll keys off this flag, and a half-built fixture must not
  // look like one this file owns.
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

  // If the redirect ever fails, `expectIsolated` fails the test and the sessions
  // are left behind on the ambient server. Sweep exactly those names — `=name:`
  // is an exact match, so no `mcbd-*` session can be caught by it.
  if (tmuxAvailable) {
    for (const name of TEST_SESSIONS) {
      await execFileAsync('tmux', ['kill-session', '-t', `=${name}:`], { timeout: 5000 }).catch(
        () => undefined,
      );
    }
  }

  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

describe('createSession against a real tmux server (Issue #1624)', () => {
  it("leaves the PANE at the configured history-limit, not tmux's 2000", async () => {
    if (!tmuxAvailable) return;
    // Imported lazily so the module resolves tmux through the redirected env.
    const { createSession, killSession } = await import('@/lib/tmux/tmux');
    const sessionName = 'cm1624-pane';

    try {
      await createSession({ sessionName, workingDirectory: workDir! });
      await expectIsolated(sessionName);

      // The regression this issue is about: the session option was already being
      // set correctly, while the pane stayed on tmux's built-in default.
      expect(await tmuxQuery(sessionName, '#{history_limit}')).toBe(String(TMUX_HISTORY_LIMIT));
      expect(await tmuxQuery(sessionName, '#{history_limit}')).not.toBe(
        String(TMUX_BUILTIN_HISTORY_LIMIT),
      );
    } finally {
      await killSession(sessionName).catch(() => undefined);
    }
  }, 30_000);

  it('keeps window index 0, the working directory, and the #1163 geometry', async () => {
    if (!tmuxAvailable) return;
    const { createSession, killSession } = await import('@/lib/tmux/tmux');
    const sessionName = 'cm1624-geometry';

    try {
      await createSession({ sessionName, workingDirectory: workDir! });
      await expectIsolated(sessionName);

      // Rebuilding the window must not renumber it — no call site targets an
      // explicit window index, but a stray extra window would be user-visible.
      expect(await tmuxQuery(sessionName, '#{window_index}')).toBe('0');
      expect(await tmuxQuery(sessionName, '#{session_windows}')).toBe('1');

      // A bare `new-window` inherits the tmux CLIENT's cwd, not the session's.
      // realpath because macOS resolves /var -> /private/var.
      const paneCwd = await tmuxQuery(sessionName, '#{pane_current_path}');
      const { stdout: expectedCwd } = await execFileAsync('realpath', [workDir!]);
      expect(paneCwd).toBe(expectedCwd.trim());

      // Issue #1163 must survive the rebuild: the replacement window does not
      // inherit `window-size manual`, so geometry has to be re-applied after it.
      const windowSize = await tmuxctl([
        'show-window-options',
        '-v',
        '-t',
        `=${sessionName}:`,
        'window-size',
      ]);
      expect(windowSize).toBe('manual');
      expect(await tmuxQuery(sessionName, '#{window_width}|#{window_height}')).toBe('200|1000');
    } finally {
      await killSession(sessionName).catch(() => undefined);
    }
  }, 30_000);

  it('does not modify the GLOBAL history-limit of the tmux server', async () => {
    if (!tmuxAvailable) return;
    const { createSession, killSession } = await import('@/lib/tmux/tmux');
    const sessionName = 'cm1624-global';

    try {
      await createSession({ sessionName, workingDirectory: workDir! });
      await expectIsolated(sessionName);

      // `set-option -g` would change scrollback for every session on the tmux
      // server, including ones CommandMate does not own.
      expect(await tmuxctl(['show-options', '-g', '-v', 'history-limit'])).toBe(
        String(TMUX_BUILTIN_HISTORY_LIMIT),
      );
    } finally {
      await killSession(sessionName).catch(() => undefined);
    }
  }, 30_000);
});
