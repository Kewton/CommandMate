import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { createLogger } from '@/lib/logger';
import { TmuxControlParser, type TmuxControlEvent } from './tmux-control-parser';
import { exactTarget } from './tmux';

const logger = createLogger('tmux-control-client');
const DEFAULT_CONTROL_CLIENT_IDLE_TIMEOUT_MS = 30_000;

/**
 * Bytes of user input per `send-keys -H` command (Issue #2767).
 *
 * A control-mode client's stdin is a stream of tmux COMMANDS, one per line — it
 * is not the pane's keyboard. Input is therefore delivered as `send-keys -H`
 * followed by the bytes in hex, and a long paste is split so no single command
 * line grows without bound (256 bytes is 767 characters of hex).
 */
export const CONTROL_SEND_KEYS_CHUNK_BYTES = 256;

export interface TmuxControlClientOptions {
  tmuxBinary?: string;
  idleTimeoutMs?: number;
  spawnProcess?: (
    command: string,
    args: string[],
    options: { stdio: 'pipe' }
  ) => ChildProcessWithoutNullStreams;
}

type EventHandler = (event: TmuxControlEvent) => void;

/**
 * Thin wrapper around a tmux control mode child process.
 *
 * This class is intentionally small in Phase 2:
 * - It owns the child process lifecycle
 * - It parses stdout into events
 * - It surfaces a minimal input/resize/cleanup interface
 */
export class TmuxControlClient {
  private readonly parser = new TmuxControlParser();
  private readonly handlers = new Set<EventHandler>();
  private readonly spawnProcess: NonNullable<TmuxControlClientOptions['spawnProcess']>;
  private readonly tmuxBinary: string;
  private readonly idleTimeoutMs: number;
  private child: ChildProcessWithoutNullStreams | null = null;
  private sessionName: string | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;

  constructor(options: TmuxControlClientOptions = {}) {
    this.spawnProcess = options.spawnProcess ?? ((command, args, spawnOptions) =>
      spawn(command, args, spawnOptions));
    this.tmuxBinary = options.tmuxBinary ?? 'tmux';
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_CONTROL_CLIENT_IDLE_TIMEOUT_MS;
  }

  start(sessionName: string): void {
    if (this.started) {
      return;
    }

    this.sessionName = sessionName;
    this.child = this.spawnProcess(
      this.tmuxBinary,
      ['-C', 'attach-session', '-t', exactTarget(sessionName)],
      { stdio: 'pipe' }
    );
    this.started = true;

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string | Buffer) => {
      this.touch();
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      for (const event of this.parser.push(text)) {
        this.emit(event);
      }
    });

    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string | Buffer) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      this.emit({ type: 'error', error: new Error(text.trim() || 'tmux control stderr') });
    });

    this.child.on('close', (code) => {
      for (const event of this.parser.flush()) {
        this.emit(event);
      }
      this.emit({ type: 'exit', exitCode: code });
      this.stop();
    });

    this.child.on('error', (error) => {
      this.emit({ type: 'error', error });
      this.stop();
    });

    this.resetIdleTimer();
    logger.debug('start', { sessionName });
  }

  onEvent(handler: EventHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /**
   * Deliver user input to the pane (Issue #2767).
   *
   * A control-mode client's stdin is where tmux COMMANDS are written, not the
   * pane's keyboard. Before #2767 the raw input was written straight through, so
   * a line typed in the browser terminal ran as a tmux command (`kill-server` +
   * Enter took down every session) and never reached the pane. The input is now
   * wrapped in `send-keys -H` with the bytes in hex: not one character of the
   * input appears in the line that is written, so it cannot be parsed as a command.
   */
  sendInput(input: string): void {
    if (!this.child?.stdin.writable || this.sessionName === null) {
      throw new Error('Tmux control client is not writable');
    }
    this.touch();
    const bytes = Buffer.from(input, 'utf8');
    for (let offset = 0; offset < bytes.length; offset += CONTROL_SEND_KEYS_CHUNK_BYTES) {
      const hex = Array.from(bytes.subarray(offset, offset + CONTROL_SEND_KEYS_CHUNK_BYTES), (byte) =>
        byte.toString(16).padStart(2, '0')
      ).join(' ');
      this.child.stdin.write(`send-keys -t ${exactTarget(this.sessionName)} -H ${hex}\n`);
    }
  }

  resize(cols: number, rows: number): void {
    if (!this.child?.stdin.writable) {
      throw new Error('Tmux control client is not writable');
    }
    this.touch();
    this.child.stdin.write(`refresh-client -C ${cols}x${rows}\n`);
  }

  stop(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    if (this.child) {
      this.child.removeAllListeners();
      this.child.stdout.removeAllListeners();
      this.child.stderr.removeAllListeners();
      this.child.kill();
      this.child = null;
    }

    this.started = false;
  }

  isStarted(): boolean {
    return this.started;
  }

  /**
   * Point this client's bookkeeping at a session that has been renamed
   * underneath it (Issue #1621 Phase 3).
   *
   * The attach itself needs no repair: `attach-session` binds to the session
   * object, not to its name, so a `rename-session` leaves the child process,
   * its pipe and its scrollback untouched (measured in #1621). Only the name
   * this client reports in its logs would otherwise go stale.
   */
  setSessionName(sessionName: string): void {
    this.sessionName = sessionName;
  }

  private emit(event: TmuxControlEvent): void {
    for (const handler of this.handlers) {
      handler(event);
    }
  }

  private touch(): void {
    this.resetIdleTimer();
  }

  private resetIdleTimer(): void {
    if (this.idleTimeoutMs <= 0) {
      return;
    }

    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }

    this.idleTimer = setTimeout(() => {
      logger.debug('idle-timeout', { sessionName: this.sessionName });
      this.stop();
    }, this.idleTimeoutMs);
  }
}
