/**
 * Issue #4176, item 2: the scripts behind the session-scoped tmux hooks are
 * materialized into `CM_TMUX_SCRIPT_DIR`, and the suite never into the real
 * `~/.commandmate/bin`.
 *
 * `ensureSessionHooks` writes them whenever the live-attach or auto-popup option
 * is on, and `tests/unit/tmux/session-hooks-2317.test.ts` turns both on. Before
 * this, `getScriptDir()` was `homedir()` with no override, so that test read and
 * (on any content difference) rewrote the scripts the running server's hooks
 * execute. Nothing here writes outside a directory it made under `os.tmpdir()`.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join, sep } from 'path';
import {
  LIVE_DELEGATE_SCRIPT_FILENAME,
  LIVE_RESTORE_SCRIPT_FILENAME,
  SCRIPT_DIR_ENV,
  getScriptDir,
  getScriptPath,
} from '@/lib/tmux/session-hook-scripts';
import { ensureSessionHooks, forgetSessionHooks } from '@/lib/tmux/session-hooks';
import { resetGeometryDelegationState } from '@/lib/tmux/geometry-delegation';
import { AUTO_POPUP_ENV, LIVE_ATTACH_HOOK_ENV } from '@/lib/session/tmux-session-surface';

vi.mock('child_process', () => ({ execFile: vi.fn() }));

const underHome = (path: string): boolean => path === homedir() || path.startsWith(homedir() + sep);

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cm-4176-scripts-'));
  vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
    const callback = args[args.length - 1] as (err: Error | null, out?: { stdout: string; stderr: string }) => void;
    callback(null, { stdout: '', stderr: '' });
    return {};
  }) as unknown as typeof execFile);
  resetGeometryDelegationState();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('the directory the hook scripts are written to', () => {
  it('is under the temp directory in the process tests/setup.ts handed this file', () => {
    expect(process.env[SCRIPT_DIR_ENV]?.startsWith(tmpdir())).toBe(true);
    expect(getScriptDir()).toBe(process.env[SCRIPT_DIR_ENV]);
    expect(underHome(getScriptPath(LIVE_DELEGATE_SCRIPT_FILENAME))).toBe(false);
  });

  it('is ~/.commandmate/bin when the variable is unset or blank, as before', () => {
    vi.stubEnv(SCRIPT_DIR_ENV, '');
    expect(getScriptDir()).toBe(join(homedir(), '.commandmate', 'bin'));
    vi.stubEnv(SCRIPT_DIR_ENV, '   ');
    expect(getScriptDir()).toBe(join(homedir(), '.commandmate', 'bin'));
  });

  it('refuses a directory inside /proc, as the other directory settings do', () => {
    vi.stubEnv(SCRIPT_DIR_ENV, '/proc/self/cm-4176');
    expect(getScriptDir()).toBe(join(homedir(), '.commandmate', 'bin'));
  });

  it('turning live-attach on writes the scripts into the variable’s directory', async () => {
    vi.stubEnv(SCRIPT_DIR_ENV, dir);
    vi.stubEnv(LIVE_ATTACH_HOOK_ENV, 'on');
    vi.stubEnv(AUTO_POPUP_ENV, '');
    // Before the call, so that a resolver that ignored the variable fails here
    // rather than writing into the real home.
    expect(getScriptDir()).toBe(dir);

    await ensureSessionHooks('mcbd-claude-wt-4176');
    forgetSessionHooks('mcbd-claude-wt-4176');

    expect(readdirSync(dir).sort()).toEqual([LIVE_DELEGATE_SCRIPT_FILENAME, LIVE_RESTORE_SCRIPT_FILENAME].sort());
    const delegateInstall = vi
      .mocked(execFile)
      .mock.calls.map((call) => call[1] as string[])
      .find((argv) => argv[0] === 'set-hook' && !argv.includes('-u'));
    expect(delegateInstall?.join(' ')).toContain(join(dir, LIVE_DELEGATE_SCRIPT_FILENAME));
  });

  it('positive control: the same call with the variable unset would have used the home directory', () => {
    // Asked of the resolver, not by calling `ensureSessionHooks` again, which
    // would write into the real home this test exists to keep clean.
    vi.stubEnv(SCRIPT_DIR_ENV, '');
    expect(underHome(getScriptPath(LIVE_DELEGATE_SCRIPT_FILENAME))).toBe(true);
    expect(existsSync(dir)).toBe(true);
  });
});
