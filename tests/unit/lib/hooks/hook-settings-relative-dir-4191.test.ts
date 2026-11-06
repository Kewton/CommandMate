/**
 * Issue #4191, item 3: a relative `CM_AGENT_HOOKS_DIR` named one file where the
 * server wrote the claude settings and another where claude read them.
 *
 * The daemon runs from the package root (`src/cli/utils/daemon.ts`,
 * `cwd: packageRoot`) and writes `<CM_AGENT_HOOKS_DIR>/<file>.json` relative to
 * that; claude is started in the worktree (`claude-session.ts`,
 * `createSession({ workingDirectory: worktreePath })`) and resolves
 * `--settings <path>` relative to the worktree. Each test below pairs the two:
 * the directory the generator wrote from (`serverCwd`, the cwd this process
 * reports) and the directory the agent is launched in (`launchCwd`), and asks
 * whether the path on the command line names the file that was written.
 *
 * Nothing is written outside the two directories made under `os.tmpdir()`.
 * The relative-path assertions run before anything is written, so the
 * implementation before the fix fails them without creating `rel-hooks/` in
 * the checkout.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { isAbsolute, join, resolve } from 'path';
import {
  buildClaudeLaunchCommand,
  getHookSettingsDirectory,
  getHookSettingsPath,
} from '@/lib/hooks/hook-settings-generator';
import { resetSafeDirectoryWarnings } from '@/config/safe-directory';

const TARGET = { worktreeId: 'wt-4191' };

let serverCwd: string;
let launchCwd: string;

/** The `--settings` operand, as the shell in the pane would hand it to claude. */
function settingsOperand(command: string): string {
  const match = /--settings '([^']+)'/.exec(command);
  if (match === null) throw new Error(`no --settings in: ${command}`);
  return match[1];
}

beforeEach(() => {
  serverCwd = mkdtempSync(join(tmpdir(), 'cm-4191-server-'));
  launchCwd = mkdtempSync(join(tmpdir(), 'cm-4191-worktree-'));
  vi.spyOn(process, 'cwd').mockReturnValue(serverCwd);
  vi.stubEnv('CM_AGENT_HOOKS_INJECT', '1');
  resetSafeDirectoryWarnings();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(serverCwd, { recursive: true, force: true });
  rmSync(launchCwd, { recursive: true, force: true });
});

describe('a relative CM_AGENT_HOOKS_DIR (Issue #4191)', () => {
  it('is resolved against the cwd the file is written from', () => {
    vi.stubEnv('CM_AGENT_HOOKS_DIR', 'rel-hooks');
    const dir = getHookSettingsDirectory();
    expect(isAbsolute(dir)).toBe(true);
    expect(dir).toBe(join(serverCwd, 'rel-hooks'));
    expect(isAbsolute(getHookSettingsPath(TARGET))).toBe(true);
  });

  it('names, from the launch cwd, the file the generator wrote', () => {
    vi.stubEnv('CM_AGENT_HOOKS_DIR', 'rel-hooks');
    // Before anything is written: the old implementation stops here.
    expect(isAbsolute(getHookSettingsDirectory())).toBe(true);

    const command = buildClaudeLaunchCommand('/usr/local/bin/claude', TARGET);
    const operand = settingsOperand(command);
    const written = getHookSettingsPath(TARGET);

    expect(written.startsWith(join(serverCwd, 'rel-hooks'))).toBe(true);
    expect(existsSync(written)).toBe(true);
    // What claude opens, started in the worktree:
    expect(resolve(launchCwd, operand)).toBe(written);
    expect(existsSync(resolve(launchCwd, operand))).toBe(true);
  });

  it('does the same for HookSettingsOptions.directory', () => {
    const options = { directory: 'opt-hooks' };
    expect(getHookSettingsDirectory(options)).toBe(join(serverCwd, 'opt-hooks'));
    const operand = settingsOperand(buildClaudeLaunchCommand('/usr/local/bin/claude', TARGET, options));
    expect(resolve(launchCwd, operand)).toBe(getHookSettingsPath(TARGET, options));
    expect(existsSync(resolve(launchCwd, operand))).toBe(true);
  });

  it('is refused when its absolute form is inside /proc, as an absolute value is', () => {
    vi.mocked(process.cwd).mockReturnValue('/proc');
    vi.stubEnv('CM_AGENT_HOOKS_DIR', 'x');
    expect(getHookSettingsDirectory()).toBe(join(homedir(), '.commandmate', 'hooks'));
  });
});

describe('what does not change (negative controls)', () => {
  it('an absolute CM_AGENT_HOOKS_DIR is used as given, whatever the cwd', () => {
    const absolute = join(serverCwd, 'abs-hooks');
    vi.stubEnv('CM_AGENT_HOOKS_DIR', absolute);
    expect(getHookSettingsDirectory()).toBe(absolute);
    const operand = settingsOperand(buildClaudeLaunchCommand('/usr/local/bin/claude', TARGET));
    expect(resolve(launchCwd, operand)).toBe(getHookSettingsPath(TARGET));
  });

  it('unset or empty, it is ~/.commandmate/hooks', () => {
    vi.stubEnv('CM_AGENT_HOOKS_DIR', '');
    expect(getHookSettingsDirectory()).toBe(join(homedir(), '.commandmate', 'hooks'));
  });
});
