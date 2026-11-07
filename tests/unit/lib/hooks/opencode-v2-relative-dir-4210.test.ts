/**
 * Issue #4210: a relative `CM_OPENCODE_V2_DIR` named one password file where the
 * server wrote it and another where the launch script read it.
 *
 * The server writes `<CM_OPENCODE_V2_DIR>/<key>.pw` relative to its own cwd and
 * puts the same path on the launch line as `--password-file`
 * (`opencode-v2/source.ts` `prepareOpencodeV2Launch`); the line runs in a pane
 * created in the worktree (`cli-tools/base.ts` `createLaunchPane`), where
 * `scripts/opencode-v2/launch.sh` reads `<"$password_file"`. Each test pairs
 * the cwd the file is written from (`serverCwd`) with the cwd the line runs in
 * (`launchCwd`).
 *
 * Nothing is written outside the two directories made under `os.tmpdir()`.
 * The relative-path assertions come before anything is written, so the
 * implementation before the fix stops there without creating `rel-v2/` in the
 * checkout (`fs` resolves against the real cwd, not the mocked one).
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { isAbsolute, join, resolve } from 'path';
import { resetSafeDirectoryWarnings } from '@/config/safe-directory';
import {
  forgetOpencodeV2Port,
  rememberOpencodeV2Port,
  resetOpencodeV2PortAssignments,
} from '@/lib/hooks/sources/opencode-v2/ports';
import {
  OPENCODE_V2_DIR_ENV,
  getOpencodeV2PasswordFilePath,
  getOpencodeV2StateDir,
  writeOpencodeV2Password,
} from '@/lib/hooks/sources/opencode-v2/secrets';
import {
  OPENCODE_V2_LAUNCH_SCRIPT_RELATIVE_PATH,
  prepareOpencodeV2Launch,
} from '@/lib/hooks/sources/opencode-v2/source';
import type { AgentInstanceRef } from '@/lib/hooks/sources/types';

const TARGET: AgentInstanceRef = { worktreeId: 'wt-4210', cliToolId: 'opencode-v2', instanceId: 'opencode-v2' };

let serverCwd: string;
let launchCwd: string;

/** The `--password-file` operand, as the shell in the pane hands it to the script. */
function passwordOperand(command: string): string {
  const match = /--password-file '([^']+)'/.exec(command);
  if (match === null) throw new Error(`no --password-file in: ${command}`);
  return match[1];
}

beforeEach(() => {
  serverCwd = mkdtempSync(join(tmpdir(), 'cm-4210-v2-server-'));
  launchCwd = mkdtempSync(join(tmpdir(), 'cm-4210-v2-worktree-'));
  // The launch script is looked up under the server's cwd; a stand-in is enough.
  const script = join(serverCwd, ...OPENCODE_V2_LAUNCH_SCRIPT_RELATIVE_PATH);
  mkdirSync(join(script, '..'), { recursive: true });
  writeFileSync(script, '#!/bin/sh\n');
  vi.spyOn(process, 'cwd').mockReturnValue(serverCwd);
  resetSafeDirectoryWarnings();
  resetOpencodeV2PortAssignments();
});

afterEach(() => {
  forgetOpencodeV2Port(TARGET);
  resetOpencodeV2PortAssignments();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(serverCwd, { recursive: true, force: true });
  rmSync(launchCwd, { recursive: true, force: true });
});

describe('a relative CM_OPENCODE_V2_DIR (Issue #4210)', () => {
  it('is resolved against the cwd the state is written from', () => {
    vi.stubEnv(OPENCODE_V2_DIR_ENV, 'rel-v2');
    expect(getOpencodeV2StateDir()).toBe(join(serverCwd, 'rel-v2'));
    expect(isAbsolute(getOpencodeV2PasswordFilePath(TARGET))).toBe(true);
  });

  it('names, from the launch cwd, the password file the server wrote', () => {
    vi.stubEnv(OPENCODE_V2_DIR_ENV, 'rel-v2');
    // Before anything is written: the old implementation stops here.
    expect(isAbsolute(getOpencodeV2StateDir())).toBe(true);

    const written = writeOpencodeV2Password(TARGET);
    rememberOpencodeV2Port(TARGET, 4300, launchCwd);
    const plan = prepareOpencodeV2Launch({ target: TARGET, executablePath: 'opencode2', worktreePath: launchCwd });
    const operand = passwordOperand(plan.command);

    expect(written.startsWith(join(serverCwd, 'rel-v2'))).toBe(true);
    expect(existsSync(written)).toBe(true);
    // What launch.sh opens, run in the worktree:
    expect(resolve(launchCwd, operand)).toBe(written);
    expect(existsSync(resolve(launchCwd, operand))).toBe(true);
  });

  it('is refused when its absolute form is inside /proc, as an absolute value is', () => {
    vi.mocked(process.cwd).mockReturnValue('/proc');
    vi.stubEnv(OPENCODE_V2_DIR_ENV, 'x');
    expect(getOpencodeV2StateDir()).toBe(join(homedir(), '.commandmate', 'opencode-v2'));
  });
});

describe('what does not change (negative controls)', () => {
  it('an absolute CM_OPENCODE_V2_DIR is used as given, and the launch line names the same file', () => {
    const absolute = join(serverCwd, 'abs-v2');
    vi.stubEnv(OPENCODE_V2_DIR_ENV, absolute);
    expect(getOpencodeV2StateDir()).toBe(absolute);

    const written = writeOpencodeV2Password(TARGET);
    rememberOpencodeV2Port(TARGET, 4300, launchCwd);
    const plan = prepareOpencodeV2Launch({ target: TARGET, executablePath: 'opencode2', worktreePath: launchCwd });
    expect(resolve(launchCwd, passwordOperand(plan.command))).toBe(written);
  });

  it('unset or empty, it is ~/.commandmate/opencode-v2', () => {
    vi.stubEnv(OPENCODE_V2_DIR_ENV, '');
    expect(getOpencodeV2StateDir()).toBe(join(homedir(), '.commandmate', 'opencode-v2'));
  });
});
