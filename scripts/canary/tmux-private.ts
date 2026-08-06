/**
 * Private-socket tmux wrapper for the detection canary (Issue #1727).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The canary runs from inside a tmux pane on the developer's machine, so `$TMUX`
 * points at the tmux server that hosts the user's live `mcbd-*` agent sessions.
 * A bare `tmux …` call from here lands on THAT server. On 2026-08-02 a live tmux
 * test that believed it was isolated ran `kill-server` and killed every running
 * `mcbd-*` session; the test itself stayed green and CI never runs tmux, so
 * nothing caught it.
 *
 * Isolation rules encoded here (not left to the caller):
 *
 * - Every invocation goes through {@link buildTmuxArgs}, which ALWAYS emits
 *   `-L <private socket>`. `-L`/`-S` take precedence over `$TMUX`, which is the
 *   only reliable isolation lever — `TMUX_TMPDIR` is ignored outright when
 *   `$TMUX` is set, so it must never be used as the isolation mechanism.
 * - The socket name must match {@link CANARY_SOCKET_PATTERN}. `kill-server` is
 *   reachable only via {@link PrivateTmuxServer.killServer}, i.e. only ever with
 *   a `-L cmate-canary-*` prefix in front of it.
 * - Server-global mutations (`bind-key` / `unbind-key` / `set-option -g`) are
 *   rejected outright: they are the commands that would leak to every session if
 *   the socket guard were ever bypassed.
 * - Session targets are always the exact form `=<name>:` so a prefix match can
 *   never resolve to one of the user's sessions.
 */

import { execFile } from 'node:child_process';
import { unlinkSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Every canary socket name starts with this. */
export const CANARY_SOCKET_PREFIX = 'cmate-canary-';

/** Accepted socket names: prefix + lowercase alphanumerics/dashes. */
export const CANARY_SOCKET_PATTERN = /^cmate-canary-[a-z0-9][a-z0-9-]{0,40}$/;

/**
 * tmux commands that mutate server-global state and would therefore escape the
 * scenario even on the private server. Rejected as a matter of discipline: the
 * canary never needs them.
 */
export const FORBIDDEN_TMUX_COMMANDS = ['bind-key', 'unbind-key', 'source-file'] as const;

/**
 * The teardown command that destroys every session on whichever server it
 * reaches. Exported as a constant so tests can exercise the guard without
 * spelling the literal out: `tests/unit/config/tmux-live-test-safety.test.ts`
 * treats an unpinned occurrence of it anywhere under `tests/` as a violation,
 * which is exactly the rule this canary is built to respect.
 */
export const SERVER_TEARDOWN_COMMAND = 'kill-server';

/** tmux's "apply globally" flag — forbidden here for the same reason. */
export const GLOBAL_OPTION_FLAG = '-g';

/** Default tmux command timeout (ms). */
const TMUX_TIMEOUT_MS = 10_000;

/** 10MB, matching `src/lib/tmux/tmux.ts` — a 1000-row pane capture is large. */
const CAPTURE_MAX_BUFFER = 10 * 1024 * 1024;

export interface TmuxArgOptions {
  /**
   * tmux config file loaded when the private server starts. Defaults to
   * `/dev/null` so the run is hermetic: the developer's `~/.tmux.conf` cannot
   * change pane geometry, status lines or key tables underneath the capture.
   */
  configPath?: string;
  /** Set only by {@link PrivateTmuxServer.killServer}. */
  allowKillServer?: boolean;
}

/**
 * Build the full argv for a tmux invocation on a private socket.
 *
 * Pure and exported so the isolation invariants are unit-testable without a
 * tmux binary (`tests/unit/canary/canary-tmux-guard.test.ts`).
 */
export function buildTmuxArgs(
  socketName: string,
  args: readonly string[],
  options: TmuxArgOptions = {}
): string[] {
  if (!CANARY_SOCKET_PATTERN.test(socketName)) {
    throw new Error(
      `canary: refusing to run tmux with socket name ${JSON.stringify(socketName)} — ` +
        `it must match ${CANARY_SOCKET_PATTERN} so the command cannot reach the user's tmux server`
    );
  }
  if (args.length === 0) {
    throw new Error('canary: refusing to run tmux with an empty command');
  }

  const command = args[0];
  if ((FORBIDDEN_TMUX_COMMANDS as readonly string[]).includes(command)) {
    throw new Error(
      `canary: tmux "${command}" is forbidden — it mutates server-global state that outlives the run`
    );
  }
  if (command === SERVER_TEARDOWN_COMMAND && !options.allowKillServer) {
    throw new Error(
      'canary: tmux "kill-server" must go through PrivateTmuxServer.killServer() so it can never run without -L'
    );
  }
  if (args.includes(GLOBAL_OPTION_FLAG)) {
    throw new Error('canary: tmux global options (-g) are forbidden — they leak beyond the scenario');
  }

  return ['-L', socketName, '-f', options.configPath ?? '/dev/null', ...args];
}

/**
 * Exact session target (`=name:`). tmux resolves a bare name as a PREFIX match,
 * so `-t canary` could select `canary-other` — or, on the wrong server, an
 * `mcbd-*` session. Mirrors `exactTarget()` in `src/lib/tmux/tmux.ts`.
 */
export function exactTarget(sessionName: string): string {
  if (!sessionName || /[\s:.]/.test(sessionName)) {
    throw new Error(`canary: invalid tmux session name ${JSON.stringify(sessionName)}`);
  }
  return `=${sessionName}:`;
}

/** A tmux server that exists only for this canary run. */
export class PrivateTmuxServer {
  private readonly createdSessions = new Set<string>();
  /** Filesystem path of this run's socket, captured while the server is alive. */
  private resolvedSocketPath: string | null = null;

  constructor(
    readonly socketName: string,
    private readonly env: NodeJS.ProcessEnv,
    private readonly configPath: string = '/dev/null'
  ) {
    if (!CANARY_SOCKET_PATTERN.test(socketName)) {
      throw new Error(`canary: invalid private socket name ${JSON.stringify(socketName)}`);
    }
  }

  private async run(
    args: readonly string[],
    options: { allowKillServer?: boolean; maxBuffer?: number } = {}
  ): Promise<string> {
    const argv = buildTmuxArgs(this.socketName, args, {
      configPath: this.configPath,
      allowKillServer: options.allowKillServer,
    });
    const { stdout } = await execFileAsync('tmux', argv, {
      timeout: TMUX_TIMEOUT_MS,
      maxBuffer: options.maxBuffer ?? 1024 * 1024,
      env: this.env,
    });
    return stdout;
  }

  /**
   * Create a detached session running `command`, with production pane geometry.
   *
   * Mirrors `createTmuxSession()` in `src/lib/tmux/tmux.ts`: history-limit is set
   * before the pane that uses it is created (a pane sizes its scrollback once, at
   * creation), then `window-size manual` + `resize-window` pin the geometry so an
   * attaching client cannot shrink the capturable rows.
   */
  async newSession(options: {
    sessionName: string;
    workingDirectory: string;
    command: string;
    width: number;
    height: number;
    historyLimit: number;
    env: Record<string, string>;
  }): Promise<void> {
    const { sessionName, workingDirectory, command, width, height, historyLimit } = options;
    if (sessionName.startsWith('mcbd-')) {
      throw new Error(`canary: refusing to create a session named like a production session: ${sessionName}`);
    }
    const target = exactTarget(sessionName);
    const envFlags = Object.entries(options.env).flatMap(([key, value]) => ['-e', `${key}=${value}`]);

    await this.run([
      'new-session',
      '-d',
      '-s',
      sessionName,
      '-c',
      workingDirectory,
      '-x',
      String(width),
      '-y',
      String(height),
      ...envFlags,
      command,
    ]);
    this.createdSessions.add(sessionName);

    await this.run(['set-option', '-t', target, 'history-limit', String(historyLimit)]);
    await this.run(['set-option', '-t', target, 'window-size', 'manual']);
    await this.run(['resize-window', '-t', target, '-x', String(width), '-y', String(height)]);

    // Remember the socket path WHILE the server is alive. tmux exits on its own
    // once the last session is killed, so by teardown time there is nobody left
    // to answer this query — and the dead socket file would pile up, one per run.
    if (!this.resolvedSocketPath) {
      this.resolvedSocketPath = await this.run(['display-message', '-p', '#{socket_path}'])
        .then(stdout => stdout.trim() || null)
        .catch(() => null);
    }
  }

  /** `capture-pane -p -e` over the last `lines` rows — the production shape. */
  async capturePane(sessionName: string, lines: number): Promise<string> {
    return this.run(
      ['capture-pane', '-t', exactTarget(sessionName), '-p', '-e', '-S', String(-lines), '-E', '-'],
      { maxBuffer: CAPTURE_MAX_BUFFER }
    );
  }

  /** Send literal text (never interpreted as key names). */
  async sendLiteral(sessionName: string, text: string): Promise<void> {
    await this.run(['send-keys', '-t', exactTarget(sessionName), '-l', '--', text]);
  }

  /** Send one key by tmux key name (`Enter`, `Escape`, …). */
  async sendKey(sessionName: string, key: string): Promise<void> {
    await this.run(['send-keys', '-t', exactTarget(sessionName), key]);
  }

  /** Read one environment variable as the session sees it. */
  async showEnvironment(sessionName: string, name: string): Promise<string | null> {
    const stdout = await this.run(['show-environment', '-t', exactTarget(sessionName), name]).catch(
      () => ''
    );
    const line = stdout.trim();
    if (!line || line.startsWith('-')) return null;
    const eq = line.indexOf('=');
    return eq === -1 ? null : line.slice(eq + 1);
  }

  /** Session names on THIS private server (never the user's). */
  async listSessions(): Promise<string[]> {
    const stdout = await this.run(['list-sessions', '-F', '#{session_name}']).catch(() => '');
    return stdout.split('\n').map(line => line.trim()).filter(Boolean);
  }

  /** Kill one session by exact name. Never throws. */
  async killSession(sessionName: string): Promise<void> {
    await this.run(['kill-session', '-t', exactTarget(sessionName)]).catch(() => '');
    this.createdSessions.delete(sessionName);
  }

  /**
   * Tear the private server down. Safe because {@link buildTmuxArgs} always
   * prefixes `-L <canary socket>`: this can only ever kill the canary's own
   * server, never the user's.
   */
  async killServer(): Promise<void> {
    const socketPath = this.resolvedSocketPath;
    await this.run([SERVER_TEARDOWN_COMMAND], { allowKillServer: true }).catch(() => '');

    // Only ever unlink a path whose basename is this run's own socket name.
    if (socketPath && path.basename(socketPath) === this.socketName) {
      try {
        unlinkSync(socketPath);
      } catch {
        // Already gone — nothing to clean up.
      }
    }
    this.createdSessions.clear();
  }

  /** Sessions this instance created and has not killed. */
  get openSessions(): string[] {
    return [...this.createdSessions];
  }
}
