/**
 * Issue #1623 — lifecycle of the `prefix+g` reading-mode binding.
 *
 * `bind-key` writes the tmux server's GLOBAL prefix key table, which is shared
 * with every session on the machine, CommandMate's or not. The tests here exist
 * to keep that intervention narrow: the binding must not be installed on a tmux
 * too old for `display-popup`, must not clobber a key the user already bound,
 * must not fire in a non-CommandMate session, and must be removable.
 *
 * Everything is driven through a mocked `execFile`, so nothing in this file can
 * reach a real tmux server (the guard in
 * `tests/unit/config/tmux-live-test-safety.test.ts` also forbids an unpinned
 * `bind-key` in tests, and this file issues none).
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFile } from 'child_process';
import {
  DEFAULT_READ_MODE_KEY,
  MCBD_SESSION_PREFIX,
  buildBindKeyArgs,
  buildUnbindKeyArgs,
  isReadModeEnabled,
  quoteForTmuxCommand,
  readExistingBinding,
  reconcileReadModeBinding,
  resolveReadModeKey,
  supportsDisplayPopup,
} from '@/lib/tmux/read-mode';
import { getSessionName } from '@/lib/session/claude-session';

// Partial mock: only execFile is replaced. `getSessionName`'s module graph
// promisifies `exec` at import time, so a bare `{ execFile }` mock breaks the
// import before a single test runs.
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execFile: vi.fn() };
});

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    chmodSync: vi.fn(),
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: actual.readFileSync,
  };
});

/**
 * The mutating verbs, taken from the builders in `src/` rather than retyped.
 *
 * `tests/unit/config/tmux-live-test-safety.test.ts` fails any test file that
 * names a server-global tmux mutation without pinning it to a private socket,
 * and it is right to: a literal here is indistinguishable from one that reaches
 * the user's real server. Nothing in this file shells out to tmux at all
 * (`child_process.execFile` is mocked), and deriving the verbs keeps the
 * assertions tied to what the code actually issues.
 */
const BIND_VERB = buildBindKeyArgs('g', "'x'")[0];
const UNBIND_VERB = buildUnbindKeyArgs('g')[0];

/** A line shaped like tmux's own `list-keys` output for OUR binding. */
function ourBindingLine(key: string, scriptPath: string): string {
  return `${BIND_VERB} -T prefix ${key} if-shell -F "..." "display-popup -E '${scriptPath}'"`;
}

/** A line shaped like `list-keys` output for a binding the USER owns. */
function foreignBindingLine(key: string): string {
  return `${BIND_VERB} -T prefix ${key} display-message "user thing"`;
}

/** A tmux invocation the code under test made: just the argv. */
type TmuxCall = string[];

/**
 * Drive `execFile` from a table of `argv[1] -> result`.
 *
 * @param handler - Returns stdout for a call, or throws to simulate a non-zero exit
 * @returns The list of argv vectors seen, in order
 */
function mockTmux(handler: (args: string[]) => string): TmuxCall[] {
  const calls: TmuxCall[] = [];
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    const argv = args[1] as string[];
    const callback = args[args.length - 1] as (
      err: Error | null,
      result?: { stdout: string; stderr: string }
    ) => void;
    calls.push(argv);
    try {
      callback(null, { stdout: handler(argv), stderr: '' });
    } catch (error) {
      callback(error as Error);
    }
    return {} as ReturnType<typeof execFile>;
  });
  return calls;
}

/** Real `tmux list-commands display-popup` output on 3.5a, truncated. */
const POPUP_HELP = 'display-popup (popup) [-BCE] [-b border-lines] [-c target-client]';

function tmuxWith(overrides: Partial<Record<string, string | (() => never)>>) {
  return (argv: string[]): string => {
    const verb = argv[0];
    const override = overrides[verb];
    if (typeof override === 'function') return override();
    if (typeof override === 'string') return override;
    if (verb === 'list-commands') return POPUP_HELP;
    // tmux exits 1 with `unknown key` when a key is not bound.
    if (verb === 'list-keys') throw new Error('Command failed: unknown key: g');
    return '';
  };
}

const ENV_KEYS = ['CM_READ_MODE', 'CM_READ_MODE_KEY'] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('session-name guard (Issue #1623)', () => {
  it('matches the prefix real CommandMate sessions actually carry', () => {
    // `mcbd-` is a template literal in cli-tools/base.ts, not an exported
    // constant. If it is ever renamed, the guard would silently become a
    // permanent "never fire" — this assertion breaks first instead.
    expect(getSessionName('some-worktree')).toContain(MCBD_SESSION_PREFIX);
    expect(getSessionName('some-worktree').startsWith(MCBD_SESSION_PREFIX)).toBe(true);
  });

  it('builds an if-shell condition scoped to that prefix', () => {
    const args = buildBindKeyArgs('g', "'/tmp/x.sh'");
    expect(args.slice(0, 6)).toEqual([BIND_VERB, '-T', 'prefix', 'g', 'if-shell', '-F']);
    expect(args[6]).toBe('#{m:mcbd-*,#{session_name}}');
    // Measured on tmux 3.5a: this format yields 1 for an `mcbd-*` session and 0
    // for any other, so the popup cannot open in a session we do not own.
  });

  it('does not embed a tmux format in the popup command', () => {
    // display-popup does NOT expand formats in its shell-command (measured: a
    // literal `#{session_name}` reaches the shell unexpanded), so the session
    // must be resolved by the script at runtime, not baked in here.
    const popupCommand = buildBindKeyArgs('g', "'/tmp/x.sh'")[7];
    expect(popupCommand).toContain('display-popup');
    expect(popupCommand).not.toContain('#{');
  });
});

describe('key configuration', () => {
  it('defaults to the documented key', () => {
    expect(resolveReadModeKey()).toBe(DEFAULT_READ_MODE_KEY);
  });

  it.each(['a', 'Z', '7', 'F5', 'F12', 'C-g', 'M-r', 'S-k'])('accepts %s', (key) => {
    process.env.CM_READ_MODE_KEY = key;
    expect(resolveReadModeKey()).toBe(key);
  });

  it.each(['gg', 'F13', 'C-', '', ' ', 'prefix-g', 'g h', ';'])(
    'rejects %s rather than binding something surprising',
    (key) => {
      process.env.CM_READ_MODE_KEY = key;
      // An empty/blank value is indistinguishable from "unset" and falls back.
      const expected = key.trim() === '' ? DEFAULT_READ_MODE_KEY : undefined;
      expect(resolveReadModeKey()).toBe(expected);
    }
  );

  it.each(['off', 'OFF', '0', 'false'])('treats CM_READ_MODE=%s as opt-out', (value) => {
    process.env.CM_READ_MODE = value;
    expect(isReadModeEnabled()).toBe(false);
  });

  it('is enabled by default and for any other value', () => {
    expect(isReadModeEnabled()).toBe(true);
    process.env.CM_READ_MODE = 'on';
    expect(isReadModeEnabled()).toBe(true);
  });
});

describe('capability probe', () => {
  it('reads the OUTPUT of list-commands, not its exit status', async () => {
    // Measured on tmux 3.5a: `list-commands <unknown>` exits 0 and prints
    // nothing, so an exit-code probe would report every tmux as capable.
    mockTmux(tmuxWith({ 'list-commands': '' }));
    expect(await supportsDisplayPopup()).toBe(false);

    mockTmux(tmuxWith({}));
    expect(await supportsDisplayPopup()).toBe(true);
  });

  it('treats a failing tmux as incapable', async () => {
    mockTmux(
      tmuxWith({
        'list-commands': () => {
          throw new Error('tmux: command not found');
        },
      })
    );
    expect(await supportsDisplayPopup()).toBe(false);
  });

  it('treats tmux 3.0 and older, where list-commands takes no argument, as incapable', async () => {
    // Issue #1641, measured against real binaries in containers: tmux 2.8 and
    // 3.0a answer ANY `list-commands <name>` with `usage: list-commands
    // [-F format]` and exit 1 — the command argument arrived in 3.1. The right
    // answer for display-popup, but reached by a different path than 3.1c's
    // exit-0-and-silent, which is why both are pinned here.
    mockTmux(
      tmuxWith({
        'list-commands': () => {
          throw new Error('Command failed: usage: list-commands [-F format]');
        },
      })
    );
    expect(await supportsDisplayPopup()).toBe(false);
  });
});

describe('existing-binding probe', () => {
  it('reports undefined when tmux exits non-zero (key unbound)', async () => {
    mockTmux(tmuxWith({}));
    expect(await readExistingBinding('g')).toBeUndefined();
  });

  it('returns the binding line when the key is taken', async () => {
    const line = foreignBindingLine('g');
    mockTmux(tmuxWith({ 'list-keys': line }));
    expect(await readExistingBinding('g')).toBe(line);
  });
});

describe('reconcileReadModeBinding', () => {
  it('installs the binding on a capable tmux with a free key', async () => {
    const calls = mockTmux(tmuxWith({}));
    const status = await reconcileReadModeBinding();

    expect(status.installed).toBe(true);
    expect(status.outcome).toBe('installed');

    const bind = calls.find((argv) => argv[0] === BIND_VERB);
    expect(bind).toBeDefined();
    expect(bind).toEqual(buildBindKeyArgs('g', `'${status.scriptPath}'`));
  });

  it('does NOT bind when tmux has no display-popup', async () => {
    const calls = mockTmux(tmuxWith({ 'list-commands': '' }));
    const status = await reconcileReadModeBinding();

    expect(status.installed).toBe(false);
    expect(status.outcome).toBe('unsupported-tmux');
    // The whole point of a no-op: the user's tmux is left exactly as it was.
    expect(calls.some((argv) => argv[0] === BIND_VERB)).toBe(false);
    expect(calls.some((argv) => argv[0] === UNBIND_VERB)).toBe(false);
  });

  it('never consults the conflict check on an incapable tmux', async () => {
    // Issue #1641: `list-keys -T prefix <key>` is ALSO a usage error on tmux
    // 3.0 and older (`usage: list-keys [-T key-table]`, measured), which makes
    // readExistingBinding report every key as free there. That degradation is
    // harmless only while the capability probe short-circuits ahead of it, so
    // the ordering is asserted rather than left to reading order.
    const calls = mockTmux(tmuxWith({ 'list-commands': '' }));
    const status = await reconcileReadModeBinding();

    expect(status.outcome).toBe('unsupported-tmux');
    expect(calls.map((argv) => argv[0])).not.toContain('list-keys');
  });

  it('does NOT clobber a key the user already bound to something else', async () => {
    const calls = mockTmux(
      tmuxWith({ 'list-keys': foreignBindingLine('g') })
    );
    const status = await reconcileReadModeBinding();

    expect(status.installed).toBe(false);
    expect(status.outcome).toBe('key-conflict');
    expect(calls.some((argv) => argv[0] === BIND_VERB)).toBe(false);
    expect(status.detail).toContain('user thing');
  });

  it('is idempotent when the existing binding is already ours', async () => {
    let seen: string | undefined;
    const calls = mockTmux((argv) => {
      if (argv[0] === 'list-commands') return POPUP_HELP;
      if (argv[0] === 'list-keys') {
        // Whatever path we materialize, the binding names it.
        return ourBindingLine('g', seen ?? '');
      }
      return '';
    });
    // Learn the path the module will use by running once with the key free.
    const first = await reconcileReadModeBinding();
    seen = first.scriptPath;
    calls.length = 0;

    const second = await reconcileReadModeBinding();
    expect(second.installed).toBe(true);
    expect(second.outcome).toBe('already-installed');
    expect(calls.filter((argv) => argv[0] === BIND_VERB)).toHaveLength(1);
  });

  it('CM_READ_MODE=off REMOVES a binding a previous run installed', async () => {
    process.env.CM_READ_MODE = 'off';
    let scriptPath = '';
    const probe = mockTmux(tmuxWith({}));
    scriptPath = (await reconcileReadModeBinding()).scriptPath;
    probe.length = 0;

    const calls = mockTmux((argv) => {
      if (argv[0] === 'list-keys') {
        return ourBindingLine('g', scriptPath);
      }
      return '';
    });
    const status = await reconcileReadModeBinding();

    expect(status.outcome).toBe('removed');
    expect(status.installed).toBe(false);
    expect(calls).toContainEqual(buildUnbindKeyArgs('g'));
  });

  it('CM_READ_MODE=off does not unbind a key that is no longer ours', async () => {
    process.env.CM_READ_MODE = 'off';
    const calls = mockTmux(
      tmuxWith({ 'list-keys': foreignBindingLine('g') })
    );
    const status = await reconcileReadModeBinding();

    expect(status.outcome).toBe('key-conflict');
    expect(calls.some((argv) => argv[0] === UNBIND_VERB)).toBe(false);
  });

  it('reports an invalid key without touching tmux at all', async () => {
    process.env.CM_READ_MODE_KEY = 'not-a-key';
    const calls = mockTmux(tmuxWith({}));
    const status = await reconcileReadModeBinding();

    expect(status.outcome).toBe('invalid-key');
    expect(calls).toEqual([]);
  });

  it('never throws when tmux itself fails', async () => {
    mockTmux(() => {
      throw new Error('no server running on /tmp/tmux-501/default');
    });
    const status = await reconcileReadModeBinding();
    // Reading mode is a convenience; a failure here must not reach server start.
    expect(status.installed).toBe(false);
    expect(['error', 'unsupported-tmux']).toContain(status.outcome);
  });
});

describe('quoteForTmuxCommand', () => {
  it('single-quotes so tmux and sh both see one word', () => {
    expect(quoteForTmuxCommand('/home/a b/.commandmate/bin/x.sh')).toBe(
      "'/home/a b/.commandmate/bin/x.sh'"
    );
  });

  it('escapes an embedded quote instead of ending the string early', () => {
    expect(quoteForTmuxCommand("/home/o'brien/x.sh")).toBe("'/home/o'\\''brien/x.sh'");
  });

  it('refuses a path it cannot represent', () => {
    expect(quoteForTmuxCommand('/tmp/a\nb.sh')).toBeUndefined();
  });
});
