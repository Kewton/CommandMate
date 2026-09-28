/**
 * The private tmux server agent-health drives (Issue #2878).
 *
 * Every argv comes from `src/lib/agent-health/tmux-command.ts`, which pins
 * `-L cm-agent-health`; every child gets an environment without `TMUX`. This
 * file adds only process plumbing on top of those two rules.
 */

import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import {
  AGENT_HEALTH_TMUX_SOCKET,
  buildTmuxArgv,
  buildTmuxStartArgv,
  buildTmuxTeardownArgv,
  exactSessionTarget,
} from '@/lib/agent-health/tmux-command';

const execFileAsync = promisify(execFile);

const TMUX_TIMEOUT_MS = 10_000;
const CAPTURE_MAX_BUFFER = 16 * 1024 * 1024;

/**
 * Server options, applied through `-f` when the first session starts the
 * server — they never reach any other server. `history-limit` matches
 * `TMUX_HISTORY_LIMIT`; `remain-on-exit` keeps a crashed CLI's last words on
 * screen as evidence.
 */
const SERVER_CONFIG = ['set -g history-limit 20000', 'set -g remain-on-exit on', ''].join('\n');

export class AgentHealthTmux {
  readonly socketName = AGENT_HEALTH_TMUX_SOCKET;
  private socketPath: string | null = null;
  private started = false;

  constructor(
    private readonly env: NodeJS.ProcessEnv,
    private readonly configDir: string
  ) {}

  private async exec(argv: string[], maxBuffer = 1024 * 1024): Promise<string> {
    const { stdout } = await execFileAsync('tmux', argv, {
      timeout: TMUX_TIMEOUT_MS,
      maxBuffer,
      env: this.env,
    });
    return stdout;
  }

  private run(args: readonly string[], maxBuffer?: number): Promise<string> {
    return this.exec(buildTmuxArgv(args), maxBuffer);
  }

  /** Whether a server is already listening on the private socket. */
  async isServerRunning(): Promise<boolean> {
    try {
      await this.run(['list-sessions']);
      return true;
    } catch {
      return false;
    }
  }

  async newSession(options: {
    sessionName: string;
    workingDirectory: string;
    width: number;
    height: number;
    command: string;
  }): Promise<void> {
    const args = [
      'new-session',
      '-d',
      '-s',
      options.sessionName,
      '-c',
      options.workingDirectory,
      '-x',
      String(options.width),
      '-y',
      String(options.height),
      options.command,
    ];
    if (!this.started) {
      const configPath = path.join(this.configDir, 'tmux.conf');
      fs.writeFileSync(configPath, SERVER_CONFIG, { mode: 0o600 });
      await this.exec(buildTmuxStartArgv(configPath, args));
      this.started = true;
    } else {
      await this.run(args);
    }
    if (this.socketPath === null) {
      this.socketPath = (await this.run(['display-message', '-p', '#{socket_path}'])).trim() || null;
    }
  }

  async capture(sessionName: string, lines: number): Promise<string> {
    return this.run(
      ['capture-pane', '-t', exactSessionTarget(sessionName), '-p', '-e', '-S', String(-lines), '-E', '-'],
      CAPTURE_MAX_BUFFER
    );
  }

  /** Named keys (`Enter`, `Escape`, `Down`). */
  async sendKey(sessionName: string, key: string): Promise<void> {
    await this.run(['send-keys', '-t', exactSessionTarget(sessionName), key]);
  }

  /** Literal text, never interpreted as key names (`-l --`). */
  async typeText(sessionName: string, text: string): Promise<void> {
    await this.run(['send-keys', '-t', exactSessionTarget(sessionName), '-l', '--', text]);
  }

  /** Multi-line text as one bracketed paste, so newlines do not submit. */
  async pasteText(sessionName: string, text: string): Promise<void> {
    const bufferName = `agent-health-${sessionName}`;
    const argv = buildTmuxArgv(['load-buffer', '-b', bufferName, '-']);
    await new Promise<void>((resolve, reject) => {
      const child = execFile('tmux', argv, { timeout: TMUX_TIMEOUT_MS, env: this.env }, (error: Error | null) =>
        error ? reject(error) : resolve()
      );
      child.stdin?.end(text);
    });
    await this.run(['paste-buffer', '-p', '-d', '-b', bufferName, '-t', exactSessionTarget(sessionName)]);
  }

  async killSession(sessionName: string): Promise<void> {
    try {
      await this.run(['kill-session', '-t', exactSessionTarget(sessionName)]);
    } catch {
      // Already gone.
    }
  }

  /**
   * Tear the private server down and remove its socket file. Safe to call
   * more than once and when nothing was started.
   */
  async teardown(): Promise<void> {
    try {
      await this.exec(buildTmuxTeardownArgv());
    } catch {
      // No server — nothing to stop.
    }
    if (this.socketPath && path.basename(this.socketPath) === AGENT_HEALTH_TMUX_SOCKET) {
      fs.rmSync(this.socketPath, { force: true });
    }
  }
}
