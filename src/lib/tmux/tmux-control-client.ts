import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { createLogger } from '@/lib/logger';
import { TmuxControlParser, type TmuxControlEvent } from './tmux-control-parser';

const logger = createLogger('tmux-control-client');
const DEFAULT_CONTROL_CLIENT_IDLE_TIMEOUT_MS = 30_000;

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
      ['-C', 'attach-session', '-t', sessionName],
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

  sendInput(input: string): void {
    if (!this.child?.stdin.writable) {
      throw new Error('Tmux control client is not writable');
    }
    this.touch();
    this.child.stdin.write(input);
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
