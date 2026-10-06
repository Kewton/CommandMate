/**
 * A `child_process` that answers for tmux and starts nothing (Issue #3290).
 *
 * The session-ownership guard has to say "no key, no read and no kill reached
 * tmux" about routes that get there through different wrappers — `sendKeys`,
 * `sendSpecialKeysAndInvalidate`, `sendDirectInput`, a tool's own `execFile`.
 * Spying on those wrappers by name is the list that went stale in #2865, so the
 * recording happens one level below all of them: at the process boundary every
 * path to tmux has to cross.
 *
 * What the fake models is the part of a tmux server the ownership check reads —
 * which sessions exist and what their `#{session_path}` is. Every invocation is
 * recorded; anything that is not one of the read-only probes below counts as
 * having touched a session. Commands other than tmux are refused without being
 * run, so a suite using this never starts a real process.
 *
 * Use as:
 *
 * ```ts
 * vi.mock('child_process', async (importOriginal) =>
 *   (await import('@tests/unit/guards/fake-tmux-child-process')).fakeChildProcess(importOriginal)
 * );
 * ```
 */

import { EventEmitter } from 'events';
import { promisify } from 'util';

export interface TmuxInvocation {
  /** The `child_process` function it came through. */
  via: string;
  /** Arguments after the binary name. */
  argv: string[];
  /** The tmux command (`has-session`, `send-keys` …), or `-V`. */
  subcommand: string;
  /** Session named by `-t`, with the `=` / `:` exact-match decoration removed. */
  target: string | null;
}

/** tmux's own options that take a value, so the value is not read as the command. */
const GLOBAL_OPTIONS_WITH_VALUE = new Set(['-L', '-S', '-f', '-c', '-T']);

function sessionOfTarget(target: string | undefined): string | null {
  if (target === undefined) return null;
  const withoutPrefix = target.startsWith('=') ? target.slice(1) : target;
  const colon = withoutPrefix.indexOf(':');
  return colon === -1 ? withoutPrefix : withoutPrefix.slice(0, colon);
}

function parseTmuxArgv(via: string, argv: string[]): TmuxInvocation {
  let index = 0;
  while (index < argv.length && argv[index].startsWith('-')) {
    if (argv[index] === '-V') return { via, argv, subcommand: '-V', target: null };
    index += GLOBAL_OPTIONS_WITH_VALUE.has(argv[index]) ? 2 : 1;
  }
  const rest = argv.slice(index + 1);
  const targetFlag = rest.indexOf('-t');
  return {
    via,
    argv,
    subcommand: argv[index] ?? '',
    target: targetFlag === -1 ? null : sessionOfTarget(rest[targetFlag + 1]),
  };
}

function renderFormat(format: string, name: string, path: string): string {
  const values: Record<string, string> = {
    session_name: name,
    session_path: path,
    session_windows: '1',
    session_attached: '0',
  };
  return format.replace(/#\{([a-z_]+)\}/g, (_match, key: string) => values[key] ?? '');
}

type Outcome = { ok: true; stdout: string } | { ok: false; message: string };

/**
 * True for an invocation that only asks tmux a question about sessions. A
 * `display-message` without `-p` writes to the attached client's status line,
 * so it is not one.
 */
export function isReadOnlyProbe(invocation: TmuxInvocation): boolean {
  if (invocation.subcommand === '-V') return true;
  if (invocation.subcommand === 'has-session' || invocation.subcommand === 'list-sessions') return true;
  return invocation.subcommand === 'display-message' && invocation.argv.includes('-p');
}

class FakeTmuxServer {
  /** Session name -> `#{session_path}`. */
  private sessions = new Map<string, string>();
  /** Session name -> what `capture-pane` prints for it (Issue #3334). Empty when unset. */
  private panes = new Map<string, string>();
  private invocations: TmuxInvocation[] = [];
  private refused: string[] = [];

  /** Forget every session and everything recorded. */
  reset(): void {
    this.sessions = new Map();
    this.panes = new Map();
    this.invocations = [];
    this.refused = [];
  }

  /** Make `name` exist, created in `sessionPath`. */
  addSession(name: string, sessionPath: string): void {
    this.sessions.set(name, sessionPath);
  }

  /**
   * What `capture-pane` returns for `name` (Issue #3334), so a suite can show a
   * reader a screen worth saving and see whether it was saved. The capture is
   * still recorded as a touch.
   */
  setPane(name: string, text: string): void {
    this.panes.set(name, text);
  }

  /** Every tmux invocation so far, in order. */
  all(): TmuxInvocation[] {
    return [...this.invocations];
  }

  /** Invocations that did more than ask a question: a key, a read, a kill, a new session … */
  touches(): TmuxInvocation[] {
    return this.invocations.filter((invocation) => !isReadOnlyProbe(invocation));
  }

  /** True once tmux was asked for `name`'s `#{session_path}` — the ownership check's own read. */
  askedSessionPathOf(name: string): boolean {
    return this.invocations.some(
      (invocation) =>
        invocation.subcommand === 'display-message' &&
        invocation.target === name &&
        invocation.argv.includes('#{session_path}')
    );
  }

  /** Commands other than tmux that were refused instead of run. */
  refusedCommands(): string[] {
    return [...this.refused];
  }

  refuse(via: string, command: string): void {
    this.refused.push(`${via}: ${command}`);
  }

  run(via: string, argv: string[]): Outcome {
    const invocation = parseTmuxArgv(via, argv);
    this.invocations.push(invocation);
    const { subcommand, target } = invocation;

    if (subcommand === '-V') return { ok: true, stdout: 'tmux 3.5a\n' };
    if (subcommand === 'list-sessions') {
      const format = argv[argv.indexOf('-F') + 1] ?? '#{session_name}';
      const lines = [...this.sessions].map(([name, path]) => renderFormat(format, name, path));
      return { ok: true, stdout: lines.length > 0 ? `${lines.join('\n')}\n` : '' };
    }
    if (subcommand === 'has-session' || subcommand === 'display-message') {
      const path = target === null ? undefined : this.sessions.get(target);
      if (target === null || path === undefined) {
        return { ok: false, message: `can't find session: ${target ?? '(none)'}` };
      }
      if (subcommand === 'has-session') return { ok: true, stdout: '' };
      return { ok: true, stdout: `${renderFormat(argv[argv.length - 1], target, path)}\n` };
    }
    if (subcommand === 'capture-pane' && target !== null && this.panes.has(target)) {
      return { ok: true, stdout: this.panes.get(target) ?? '' };
    }
    // Everything else is recorded as a touch and reported as having worked, so
    // a route that sends into a session it should have refused runs to the end
    // and the record shows the whole of what it did.
    return { ok: true, stdout: '' };
  }
}

/** The one fake server of the test file that mocked `child_process` with this module. */
export const fakeTmux = new FakeTmuxServer();

function isTmuxBinary(file: unknown): boolean {
  return typeof file === 'string' && (file === 'tmux' || file.endsWith('/tmux'));
}

function failure(message: string, code: string | number): Error {
  return Object.assign(new Error(message), { code, stdout: '', stderr: message });
}

function notStarted(command: string): Error {
  return failure(`spawn ${command} ENOENT (refused by fake-tmux-child-process)`, 'ENOENT');
}

/** The stand-in for the `ChildProcess` the callback-style functions return. */
function fakeChild(): EventEmitter & Record<string, unknown> {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
  const stdin = new EventEmitter() as EventEmitter & Record<string, unknown>;
  stdin.write = () => true;
  stdin.end = () => undefined;
  child.stdin = stdin;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 0;
  child.kill = () => true;
  child.unref = () => undefined;
  return child;
}

type Callback = (error: Error | null, stdout: string, stderr: string) => void;

function lastCallback(args: unknown[]): Callback | undefined {
  const last = args[args.length - 1];
  return typeof last === 'function' ? (last as Callback) : undefined;
}

/** `execFile` / `exec` share one shape once the command is split into file + argv. */
function settle(via: string, file: unknown, argv: string[]): Outcome | Error {
  if (isTmuxBinary(file)) return fakeTmux.run(via, argv);
  fakeTmux.refuse(via, [String(file), ...argv].join(' '));
  return notStarted(String(file));
}

function asPromise(result: Outcome | Error): Promise<{ stdout: string; stderr: string }> {
  if (result instanceof Error) return Promise.reject(result);
  if (!result.ok) return Promise.reject(failure(result.message, 1));
  return Promise.resolve({ stdout: result.stdout, stderr: '' });
}

function viaCallback(result: Outcome | Error, callback: Callback | undefined): EventEmitter {
  const child = fakeChild();
  queueMicrotask(() => {
    if (result instanceof Error) callback?.(result, '', result.message);
    else if (!result.ok) callback?.(failure(result.message, 1), '', result.message);
    else callback?.(null, result.stdout, '');
    child.emit('close', result instanceof Error || !result.ok ? 1 : 0, null);
  });
  return child;
}

function argvOf(args: unknown[]): string[] {
  return Array.isArray(args[1]) ? (args[1] as unknown[]).map(String) : [];
}

function splitShellCommand(command: unknown): { file: string; argv: string[] } {
  const [file = '', ...argv] = String(command).trim().split(/\s+/);
  return { file, argv };
}

function syncResult(result: Outcome | Error): string {
  if (result instanceof Error) throw result;
  if (!result.ok) throw failure(result.message, 1);
  return result.stdout;
}

/**
 * The module to return from the `child_process` mock factory. Types, classes
 * and constants pass through from the real module; every function that starts
 * a process is replaced.
 */
export async function fakeChildProcess(
  importOriginal: <T = unknown>() => Promise<T>
): Promise<Record<string, unknown>> {
  const actual = await importOriginal<Record<string, unknown>>();

  const execFile = Object.assign(
    (...args: unknown[]) => viaCallback(settle('execFile', args[0], argvOf(args)), lastCallback(args)),
    { [promisify.custom]: (...args: unknown[]) => asPromise(settle('execFile', args[0], argvOf(args))) }
  );
  const exec = Object.assign(
    (...args: unknown[]) => {
      const { file, argv } = splitShellCommand(args[0]);
      return viaCallback(settle('exec', file, argv), lastCallback(args));
    },
    {
      [promisify.custom]: (...args: unknown[]) => {
        const { file, argv } = splitShellCommand(args[0]);
        return asPromise(settle('exec', file, argv));
      },
    }
  );
  const spawn = (...args: unknown[]) => {
    const result = settle('spawn', args[0], argvOf(args));
    const child = fakeChild();
    queueMicrotask(() => {
      if (result instanceof Error) child.emit('error', result);
      else child.emit('close', result.ok ? 0 : 1, null);
    });
    return child;
  };
  const execFileSync = (...args: unknown[]) => syncResult(settle('execFileSync', args[0], argvOf(args)));
  const execSync = (...args: unknown[]) => {
    const { file, argv } = splitShellCommand(args[0]);
    return syncResult(settle('execSync', file, argv));
  };
  const spawnSync = (...args: unknown[]) => {
    const result = settle('spawnSync', args[0], argvOf(args));
    if (result instanceof Error) return { error: result, status: null, signal: null, stdout: '', stderr: '' };
    return { status: result.ok ? 0 : 1, signal: null, stdout: result.ok ? result.stdout : '', stderr: '' };
  };
  const fork = (...args: unknown[]) => {
    fakeTmux.refuse('fork', String(args[0]));
    throw notStarted(String(args[0]));
  };

  const replaced = { execFile, exec, spawn, execFileSync, execSync, spawnSync, fork };
  return { ...actual, ...replaced, default: { ...actual, ...replaced } };
}
