/**
 * A `child_process` whose tmux has panes with generations (Issue #4304 F1-a).
 *
 * The answer path's tests have to show which PANE a frame came from and which
 * pane a key went to, through the real `tmux.ts`, `cli-session.ts` and
 * `prompt-answer-sender.ts` — whatever they ask tmux (`capture-pane -t =s:`
 * before #4304, `capture-pane -t %N` after). So the fake sits at the process
 * boundary and models what both ask: sessions that show one pane, panes with
 * ids that are never reused (measured on tmux 3.5a, design §7.1 E-2), the
 * server's `start_time` / `pid`, `pane_dead`, and a pane that is gone
 * (`capture-pane` fails, `display-message` prints an empty line — §7.1).
 *
 * A test replaces a session's pane (`replacePane`, a new `%N` as `new-window -k`
 * gives) at the exact step it wants with `before` / `after` hooks on a tmux
 * subcommand. Every key is recorded with the pane it reached.
 *
 * Nothing is started: commands other than tmux are refused.
 */

import { promisify } from 'util';
import { EventEmitter } from 'events';

interface Pane {
  id: string;
  grid: string;
  dead: boolean;
}

/** One tmux call as the fake saw it. */
export interface FakeTmuxCall {
  subcommand: string;
  argv: string[];
  /** The `-t` target as given (`=s:`, `%N`). */
  target: string | null;
}

/** A key that reached a pane. */
export interface FakeKey {
  paneId: string;
  argv: string[];
}

type Hook = (call: FakeTmuxCall) => void | Promise<void>;

type Outcome = { ok: true; stdout: string } | { ok: false; message: string };

class FakePaneTmux {
  serverStartTime = '1794589716';
  serverPid = '4242';
  private nextPane = 0;
  private sessions = new Map<string, string>();
  private panes = new Map<string, Pane>();
  calls: FakeTmuxCall[] = [];
  keys: FakeKey[] = [];
  private before: Array<{ subcommand: string; match?: (c: FakeTmuxCall) => boolean; hook: Hook }> = [];
  private after: Array<{ subcommand: string; match?: (c: FakeTmuxCall) => boolean; hook: Hook }> = [];

  reset(): void {
    this.nextPane = 0;
    this.sessions = new Map();
    this.panes = new Map();
    this.calls = [];
    this.keys = [];
    this.before = [];
    this.after = [];
    this.serverStartTime = '1794589716';
    this.serverPid = '4242';
  }

  /** A session showing a new pane with `grid`; its pane id. */
  addSession(name: string, grid: string): string {
    const id = `%${this.nextPane++}`;
    this.panes.set(id, { id, grid, dead: false });
    this.sessions.set(name, id);
    return id;
  }

  /** The session's pane replaced by a new one (`new-window -k`): the old pane is gone. */
  replacePane(name: string, grid: string): string {
    const old = this.sessions.get(name);
    if (old !== undefined) this.panes.delete(old);
    return this.addSession(name, grid);
  }

  /** What the session's current pane shows now. */
  setGrid(name: string, grid: string): void {
    const pane = this.paneOf(name);
    if (pane) pane.grid = grid;
  }

  /** The session's pane exits (`remain-on-exit`): it stays, dead. */
  markDead(name: string): void {
    const pane = this.paneOf(name);
    if (pane) pane.dead = true;
  }

  /** The session (and its pane) is gone. */
  killSession(name: string): void {
    const id = this.sessions.get(name);
    if (id !== undefined) this.panes.delete(id);
    this.sessions.delete(name);
  }

  paneIdOf(name: string): string | undefined {
    return this.sessions.get(name);
  }

  private paneOf(name: string): Pane | undefined {
    const id = this.sessions.get(name);
    return id === undefined ? undefined : this.panes.get(id);
  }

  /** Run `hook` once, before the next `subcommand` call (that `match`es). */
  onceBefore(subcommand: string, hook: Hook, match?: (c: FakeTmuxCall) => boolean): void {
    this.before.push({ subcommand, match, hook });
  }

  /** Run `hook` once, after the next `subcommand` call (that `match`es) read tmux, before it returns. */
  onceAfter(subcommand: string, hook: Hook, match?: (c: FakeTmuxCall) => boolean): void {
    this.after.push({ subcommand, match, hook });
  }

  /** Keys that reached the pane `paneId`. */
  keysTo(paneId: string): FakeKey[] {
    return this.keys.filter((key) => key.paneId === paneId);
  }

  private resolve(target: string | null): Pane | undefined {
    if (target === null) return undefined;
    if (target.startsWith('%')) return this.panes.get(target);
    const name = target.replace(/^=/, '').replace(/:$/, '');
    return this.paneOf(name);
  }

  private render(format: string, pane: Pane): string {
    const values: Record<string, string> = {
      start_time: this.serverStartTime,
      pid: this.serverPid,
      pane_id: pane.id,
      pane_dead: pane.dead ? '1' : '0',
      pane_current_command: 'claude',
      pane_pid: '100',
      session_path: '/repo',
    };
    return format.replace(/#\{([a-z_]+)\}/g, (_m, key: string) => values[key] ?? '');
  }

  private async fire(list: typeof this.before, call: FakeTmuxCall): Promise<void> {
    const index = list.findIndex((h) => h.subcommand === call.subcommand && (h.match === undefined || h.match(call)));
    if (index === -1) return;
    const [{ hook }] = list.splice(index, 1);
    await hook(call);
  }

  async run(argv: string[]): Promise<Outcome> {
    const subcommand = argv[0] ?? '';
    const t = argv.indexOf('-t');
    const call: FakeTmuxCall = { subcommand, argv, target: t === -1 ? null : argv[t + 1] };
    this.calls.push(call);
    await this.fire(this.before, call);
    let outcome: Outcome;
    const pane = this.resolve(call.target);
    if (subcommand === 'display-message') {
      // Measured on tmux 3.5a (§7.1): a target that is gone prints an empty line, exit 0.
      outcome = { ok: true, stdout: pane === undefined ? '\n' : `${this.render(argv[argv.length - 1], pane)}\n` };
    } else if (subcommand === 'capture-pane') {
      outcome = pane === undefined ? { ok: false, message: `can't find pane: ${call.target}` } : { ok: true, stdout: pane.grid };
    } else if (subcommand === 'has-session') {
      outcome = pane === undefined ? { ok: false, message: `can't find session: ${call.target}` } : { ok: true, stdout: '' };
    } else if (subcommand === 'send-keys') {
      if (pane === undefined) {
        outcome = { ok: false, message: `can't find pane: ${call.target}` };
      } else {
        this.keys.push({ paneId: pane.id, argv });
        outcome = { ok: true, stdout: '' };
      }
    } else {
      outcome = { ok: true, stdout: '' };
    }
    await this.fire(this.after, call);
    return outcome;
  }
}

/** The one fake of the test file that mocked `child_process` with this module. */
export const fakePaneTmux = new FakePaneTmux();

function failure(message: string): Error {
  return Object.assign(new Error(message), { code: 1, stdout: '', stderr: message });
}

async function settle(file: unknown, argv: string[]): Promise<{ stdout: string; stderr: string }> {
  if (file !== 'tmux') throw Object.assign(new Error(`spawn ${String(file)} ENOENT (refused by fake-pane-tmux)`), { code: 'ENOENT' });
  const outcome = await fakePaneTmux.run(argv);
  if (!outcome.ok) throw failure(outcome.message);
  return { stdout: outcome.stdout, stderr: '' };
}

/** The `child_process` mock factory's module: `execFile` answers for tmux; nothing else starts. */
export async function fakePaneChildProcess(
  importOriginal: <T = unknown>() => Promise<T>,
): Promise<Record<string, unknown>> {
  const actual = await importOriginal<Record<string, unknown>>();
  const argvOf = (args: unknown[]): string[] => (Array.isArray(args[1]) ? (args[1] as unknown[]).map(String) : []);
  const execFile = Object.assign(
    (...args: unknown[]) => {
      const callback = args[args.length - 1] as (e: Error | null, out?: unknown, err?: unknown) => void;
      settle(args[0], argvOf(args)).then(
        (r) => callback(null, r.stdout, r.stderr),
        (e: Error) => callback(e, '', e.message),
      );
      return new EventEmitter();
    },
    { [promisify.custom]: (...args: unknown[]) => settle(args[0], argvOf(args)) },
  );
  return { ...actual, execFile, default: { ...actual, execFile } };
}
