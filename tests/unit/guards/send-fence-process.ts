/**
 * The process boundary for the send fence's guards (Issue #4534, G-境).
 *
 * Starts nothing. Every way out of `child_process` — `execFile` (callback and
 * promisified), `exec`, `spawn` and the sync forms — and `fetch` is recorded
 * and classified at this one level below every wrapper, so no list of wrapper
 * names can go stale. What is not known to be a READ is a CHANGE (design §5):
 *
 * - tmux `has-session`, `capture-pane`, `display-message`, `list-*`, `show-*`
 *   and `-V` are reads; `load-buffer` / `delete-buffer` (and the other buffer
 *   commands) touch only the server's paste buffers; every other tmux command
 *   is a change. An `exec` line is classified by its `tmux <command>`.
 * - A process that is not tmux is out of scope (`other`), never a change.
 * - `fetch`: every method but GET is a change.
 *
 * The fence's observer ({@link gateObserver}) hands one PERMIT to the next change
 * of the same synchronous step; a permit no change used is dropped at the next
 * microtask. A change with no permit — or with a permit whose ticket does not
 * name the session the change targets — is what {@link ungated} reports.
 *
 * A small pane model answers `capture-pane`: a shell until a launch line starts
 * an agent, then that agent's idle screen with the composer the keys typed.
 *
 * Use as:
 *
 * ```ts
 * vi.mock('child_process', async () => (await import('./send-fence-process')).fakeChildProcess());
 * ```
 */

import { promisify } from 'util';
import type { FenceGateEvent, FenceGateMode } from '@/lib/session/terminal-fence';
import { TUI_PANE_HEIGHT, TUI_PANE_WIDTH } from '@/config/tmux-pane-config';

/** tmux commands that change no pane, window, session or server option. */
export const TMUX_READS: ReadonlySet<string> = new Set([
  '-V',
  'has-session',
  'capture-pane',
  'display-message',
  'list-sessions',
  'list-panes',
  'list-windows',
  'list-clients',
  'list-buffers',
  'show-options',
  'show-window-options',
  'show-environment',
  'show-hooks',
  'show-buffer',
]);

/** tmux commands that touch only the server's paste buffers, never a pane. */
export const TMUX_BUFFER_ONLY: ReadonlySet<string> = new Set(['load-buffer', 'delete-buffer', 'set-buffer', 'save-buffer']);

export type OutClass = 'read' | 'buffer' | 'change' | 'other';

export interface Out {
  via: string;
  line: string;
  cls: OutClass;
  /** The session the change targets (tmux `-t` / `-s`), when it names one. */
  session: string | null;
  /** How the gate in front of it let it through; null when none did. */
  permit: FenceGateMode | null;
  /** The open ticket's names at the gate (empty for a bare gate). */
  permitNames: readonly string[];
}

/** The agent a pane runs, as far as this model knows. */
export type PaneTool = 'shell' | 'claude' | 'codex' | 'copilot' | 'opencode';

interface Pane {
  tool: PaneTool;
  composer: string;
  transcript: string[];
  /** `window-size manual` was set (a new window has it unset). */
  manual: boolean;
  /** `resize-window` gave it the canvas size (a new session is at its first size). */
  sized: boolean;
}

const ESC = '\u001b';
const SEP = '─'.repeat(40);

export const world = {
  out: [] as Out[],
  panes: new Map<string, Pane>(),
  buffers: new Map<string, string>(),
  permit: null as FenceGateEvent | null,
  /** Gates that let a change through and were followed by none in the same step. */
  unused: [] as string[],
  /** Called after each call is recorded and applied. */
  onCall: ((_o: Out) => undefined) as (o: Out) => void,
  /** Overrides the pane model's frame for a session. */
  frame: null as ((session: string) => string | null) | null,
  /** What a non-tmux `exec` / `execFile` answers on stdout. */
  execAnswer: defaultExecAnswer as (line: string) => string,
  /** `display-message` answers (the pane's path / command / pid …). */
  display: defaultDisplay as (session: string | null, format: string) => string,
  /** The worktree path `#{session_path}` / `#{pane_current_path}` answer. */
  path: '/tmp',
};

/** `which <bin>` finds it under /usr/local/bin; `ps -o tpgid=` says the agent holds the terminal. */
function defaultExecAnswer(line: string): string {
  const which = /^\s*(?:which|command -v)\s+(\S+)/.exec(line);
  if (which) return `/usr/local/bin/${which[1]}`;
  if (/^ps\s/.test(line)) return '9999';
  return '';
}

/** `#{session_path}` is the worktree; `#{pane_current_command}` is the pane's tool. */
function defaultDisplay(session: string | null, format: string): string {
  const pane = session === null ? undefined : world.panes.get(session);
  return format.replace(/#\{(\w+)\}/g, (_m, key: string) => {
    if (key === 'session_path' || key === 'pane_current_path') return world.path;
    if (key === 'pane_current_command') return pane === undefined || pane.tool === 'shell' ? 'zsh' : pane.tool;
    if (key === 'pane_pid') return '4242';
    if (key === 'window_width') return pane?.sized ? String(TUI_PANE_WIDTH) : '80';
    if (key === 'window_height') return pane?.sized ? String(TUI_PANE_HEIGHT) : '24';
    if (key === 'pane_dead') return '0';
    return '';
  });
}

export function resetWorld(): void {
  world.out.length = 0;
  world.panes.clear();
  world.buffers.clear();
  world.permit = null;
  world.unused.length = 0;
  world.onCall = () => undefined;
  world.frame = null;
  world.execAnswer = defaultExecAnswer;
  world.display = defaultDisplay;
  world.path = '/tmp';
}

/** A session that already exists and runs `tool`. */
export function addPane(session: string, tool: PaneTool, composer = ''): void {
  world.panes.set(session, { tool, composer, transcript: [], manual: true, sized: true });
}

/** Install as the fence's observer: a passing gate hands one permit to the next change of the same synchronous step. */
export function gateObserver(event: FenceGateEvent): void {
  const permit = { ...event, names: [...event.names] };
  world.permit = permit;
  queueMicrotask(() => {
    if (world.permit === permit) {
      world.permit = null;
      world.unused.push(`${event.kind}:${event.mode}`);
    }
  });
}

function sessionOf(argv: readonly string[]): string | null {
  const t = argv.indexOf('-t');
  const s = argv.indexOf('-s');
  const raw = t >= 0 ? argv[t + 1] : s >= 0 ? argv[s + 1] : undefined;
  if (raw === undefined) return null;
  const bare = raw.startsWith('=') ? raw.slice(1) : raw;
  const colon = bare.indexOf(':');
  return colon === -1 ? bare : bare.slice(0, colon);
}

function classifyTmux(sub: string): OutClass {
  if (TMUX_READS.has(sub)) return 'read';
  if (TMUX_BUFFER_ONLY.has(sub)) return 'buffer';
  return 'change';
}

function record(via: string, line: string, cls: OutClass, session: string | null): Out {
  const out: Out = { via, line, cls, session, permit: null, permitNames: [] };
  if (cls === 'change') {
    out.permit = world.permit?.mode ?? null;
    out.permitNames = world.permit?.names ?? [];
    world.permit = null;
  }
  world.out.push(out);
  return out;
}

function renderPane(pane: Pane): string {
  switch (pane.tool) {
    case 'claude':
      return ['⏺ a reply', ...pane.transcript.map((t) => `❯ ${t}`), '', SEP, `${ESC}[39m❯ ${pane.composer}`, SEP, '  ⏵⏵ auto mode on'].join('\n');
    case 'codex':
      return [
        '• a reply',
        ...pane.transcript.map((t) => `› ${t}`),
        '',
        pane.composer ? `${ESC}[1m›${ESC}[0m ${pane.composer}` : `${ESC}[1m›${ESC}[0m ${ESC}[2mAsk Codex to do anything${ESC}[0m`,
        '',
        '  gpt-5.6-sol xhigh · /repo',
      ].join('\n');
    default:
      return `user@host repo % ${pane.composer}`;
  }
}

function frameOf(session: string | null): string {
  if (session === null) return '';
  const override = world.frame?.(session);
  if (override !== null && override !== undefined) return override;
  const pane = world.panes.get(session);
  return pane ? renderPane(pane) : '';
}

/** A launch line typed into a shell starts the agent it names. */
function launchedTool(line: string): PaneTool | null {
  for (const tool of ['claude', 'codex', 'copilot', 'opencode'] as const) {
    if (new RegExp(`(^|[\\s/'"])${tool}(\\s|$|['"])`).test(line)) return tool;
  }
  return null;
}

function submit(pane: Pane): void {
  if (pane.tool === 'shell') {
    const tool = launchedTool(pane.composer);
    if (tool !== null) pane.tool = tool;
  } else if (pane.composer.length > 0) {
    pane.transcript.push(pane.composer);
  }
  pane.composer = '';
}

function applyKeys(pane: Pane, argv: readonly string[]): void {
  const rest = argv.slice(argv.indexOf('-t') + 2);
  if (rest[0] === '-l') {
    pane.composer += rest.slice(rest[1] === '--' ? 2 : 1).join(' ');
    return;
  }
  if (rest[0] === '-H') return;
  for (const key of rest) {
    if (key === 'C-u' || key === 'C-c') pane.composer = '';
    else if (key === 'C-m' || key === 'Enter') submit(pane);
    else if (key === 'BSpace') pane.composer = pane.composer.slice(0, -1);
    else if (/^(C-.|M-.|Escape|Tab|Up|Down|Left|Right|Home|End|--)$/.test(key)) continue;
    else pane.composer += key.replace(/\\;$/, ';');
  }
}

function runTmux(via: string, argv: readonly string[], input?: string): { stdout: string; stderr: string } {
  const sub = argv[0] ?? '';
  const session = sessionOf(argv);
  const out = record(via, argv.join(' '), classifyTmux(sub), session);
  const pane = session === null ? undefined : world.panes.get(session);
  try {
    switch (sub) {
      case 'has-session':
        if (pane === undefined) throw Object.assign(new Error(`can't find session: ${session}`), { code: 1 });
        return { stdout: '', stderr: '' };
      case 'new-session':
        if (session !== null) world.panes.set(session, { tool: 'shell', composer: '', transcript: [], manual: false, sized: false });
        return { stdout: '', stderr: '' };
      case 'new-window':
        if (pane !== undefined) pane.manual = false;
        return { stdout: '', stderr: '' };
      case 'set-window-option':
        if (pane !== undefined && argv.includes('manual')) pane.manual = true;
        return { stdout: '', stderr: '' };
      case 'resize-window':
        if (pane !== undefined) pane.sized = true;
        return { stdout: '', stderr: '' };
      case 'kill-session':
        if (session === null || !world.panes.delete(session)) throw new Error(`can't find session: ${session}`);
        return { stdout: '', stderr: '' };
      case 'capture-pane':
        return { stdout: frameOf(session), stderr: '' };
      case 'display-message':
        return { stdout: world.display(session, argv[argv.length - 1] ?? ''), stderr: '' };
      case 'show-window-options':
        return { stdout: pane?.manual ? 'manual' : '', stderr: '' };
      case 'list-sessions':
        return { stdout: [...world.panes.keys()].join('\n'), stderr: '' };
      case 'load-buffer': {
        const b = argv.indexOf('-b');
        if (b >= 0) world.buffers.set(argv[b + 1], input ?? '');
        return { stdout: '', stderr: '' };
      }
      case 'paste-buffer': {
        const b = argv.indexOf('-b');
        if (pane !== undefined && b >= 0) pane.composer += world.buffers.get(argv[b + 1]) ?? '';
        return { stdout: '', stderr: '' };
      }
      case 'send-keys':
        if (pane === undefined) throw new Error(`can't find session: ${session}`);
        applyKeys(pane, argv);
        return { stdout: '', stderr: '' };
      default:
        return { stdout: '', stderr: '' };
    }
  } finally {
    world.onCall(out);
  }
}

function runShell(via: string, line: string): { stdout: string; stderr: string } {
  const m = /^\s*tmux\s+(\S+)/.exec(line);
  const out = record(via, line, m ? classifyTmux(m[1]) : 'other', null);
  world.onCall(out);
  return { stdout: world.execAnswer(line), stderr: '' };
}

function runOther(via: string, cmd: string, argv: readonly string[]): { stdout: string; stderr: string } {
  const line = [cmd, ...argv].join(' ');
  const out = record(via, line, 'other', null);
  world.onCall(out);
  return { stdout: world.execAnswer(line), stderr: '' };
}

type Callback = (error: Error | null, stdout?: unknown, stderr?: unknown) => void;

/** The `child_process` module for `vi.mock`. */
export function fakeChildProcess(): Record<string, unknown> {
  const run = (via: string, cmd: string, argv: readonly string[], input?: string): { stdout: string; stderr: string } =>
    cmd === 'tmux' ? runTmux(via, argv, input) : runOther(via, cmd, argv);

  const execFile = ((cmd: string, argv: string[] | undefined, opts: unknown, cb?: Callback) => {
    const callback = (typeof argv === 'function' ? argv : typeof opts === 'function' ? opts : cb) as Callback | undefined;
    const args = Array.isArray(argv) ? argv : [];
    // `load-buffer -` reads stdin: the call is recorded when stdin ends.
    if (cmd === 'tmux' && args[0] === 'load-buffer' && args[args.length - 1] === '-') {
      return {
        stdin: {
          end: (input?: string) => {
            let error: Error | null = null;
            try {
              run('execFile', cmd, args, input ?? '');
            } catch (e) {
              error = e as Error;
            }
            queueMicrotask(() => callback?.(error, '', ''));
          },
        },
      };
    }
    let out: { stdout: string; stderr: string } | undefined;
    let error: Error | null = null;
    try {
      out = run('execFile', cmd, args);
    } catch (e) {
      error = e as Error;
    }
    queueMicrotask(() => callback?.(error, out?.stdout ?? '', out?.stderr ?? ''));
    return { stdin: { end: () => undefined }, on: () => undefined, kill: () => true };
  }) as unknown as Record<symbol, unknown>;
  execFile[promisify.custom] = async (cmd: string, argv?: string[]) => run('execFile', cmd, argv ?? []);

  const exec = ((line: string, opts: unknown, cb?: Callback) => {
    const callback = (typeof opts === 'function' ? opts : cb) as Callback | undefined;
    const out = runShell('exec', line);
    queueMicrotask(() => callback?.(null, out.stdout, out.stderr));
    return { stdin: { end: () => undefined }, on: () => undefined, kill: () => true };
  }) as unknown as Record<symbol, unknown>;
  exec[promisify.custom] = async (line: string) => runShell('exec', line);

  const refuse = (via: string) => (cmd: string, argv?: readonly string[]) => {
    if (cmd === 'tmux') runTmux(via, argv ?? []);
    else runOther(via, cmd, argv ?? []);
    throw new Error(`send-fence-process: ${via} is not modelled`);
  };
  const execSync = (line: string) => runShell('execSync', line).stdout;
  const execFileSync = (cmd: string, argv?: readonly string[]) => run('execFileSync', cmd, argv ?? []).stdout;
  const mod = { execFile, exec, execSync, execFileSync, spawn: refuse('spawn'), spawnSync: refuse('spawnSync'), fork: refuse('fork') };
  return { ...mod, default: mod };
}

/** A `fetch` that records: every method but GET is a change. */
export function fakeFetch(answer: (url: string, init?: RequestInit) => unknown): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const out = record('fetch', `${method} ${String(url)}`, method === 'GET' ? 'read' : 'change', null);
    world.onCall(out);
    return answer(String(url), init);
  }) as unknown as typeof fetch;
}

/** Every change, as its line (first 120 characters). */
export const changes = (): string[] => world.out.filter((o) => o.cls === 'change').map((o) => o.line.slice(0, 120));

/**
 * G-境: changes no open ticket's gate (or batch step, or retraction) let through
 * in the same synchronous step, and changes whose session the permit's ticket
 * does not name.
 */
export const ungated = (): string[] =>
  world.out
    .filter((o) => o.cls === 'change')
    .filter((o) => o.permit === null || o.permit === 'bare' || (o.session !== null && !o.permitNames.includes(o.session)))
    .map((o) => `${o.via}[${o.permit ?? 'none'}]: ${o.line.slice(0, 100)}`);

/** The tmux command of each change, in order. */
export const changeCommands = (): string[] =>
  world.out.filter((o) => o.cls === 'change').map((o) => (o.via === 'fetch' ? o.line.split(' ')[0] : o.line.replace(/^tmux\s+/, '').split(' ')[0]));
