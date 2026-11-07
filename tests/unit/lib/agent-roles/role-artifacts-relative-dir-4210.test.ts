/**
 * Issue #4210: relative role-artifact locations named one file where the server
 * wrote the role and another where the CLI looked for it.
 *
 * `writeRoleArtifact` writes relative to the server's cwd, and
 * `buildRoleLaunchArguments` (`agent-roles/adapters.ts`) hands the CLI either
 * the file's path (`--append-system-prompt-file`, `--mod`, OpenCode's
 * `instructions`) or the home it sits in (`COPILOT_HOME`). The CLI runs in a
 * pane created in the worktree (`cli-tools/base.ts` `createLaunchPane`). Each
 * test pairs the cwd the file is written from (`serverCwd`) with the cwd the
 * CLI runs in (`launchCwd`).
 *
 * Nothing is written outside the two directories made under `os.tmpdir()`.
 * The relative-path assertions come before anything is written, so the
 * implementation before the fix stops there without writing into the checkout
 * (`fs` resolves against the real cwd, not the mocked one).
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { isAbsolute, join, resolve } from 'path';
import { resetSafeDirectoryWarnings } from '@/config/safe-directory';
import { buildRoleLaunchArguments } from '@/lib/agent-roles/adapters';
import {
  AGENT_ROLE_ARTIFACTS_DIR_ENV_VAR,
  resolveArtifactLocation,
  writeRoleArtifact,
  type ArtifactOptions,
} from '@/lib/agent-roles/artifacts';
import { getCopilotHomeDirectory } from '@/lib/hooks/sources/copilot/hook-settings';
import type { AgentRoleCliTool } from '@/types/agent-roles';

const NAME = 'cm-role-ns-0011223344556677-abababababab';

let serverCwd: string;
let launchCwd: string;

function launch(adapter: AgentRoleCliTool, options: ArtifactOptions) {
  const artifact = writeRoleArtifact({ adapter, name: NAME, instructions: 'be a reviewer' }, options);
  return { artifact, role: buildRoleLaunchArguments({ adapter, effectiveAgent: null }, artifact, {}) };
}

/** The operand after `flag`, as the CLI in the pane receives it. */
function operandAfter(args: string[], flag: string): string {
  const index = args.indexOf(flag);
  if (index < 0) throw new Error(`no ${flag} in: ${args.join(' ')}`);
  return args[index + 1];
}

beforeEach(() => {
  serverCwd = mkdtempSync(join(tmpdir(), 'cm-4210-roles-server-'));
  launchCwd = mkdtempSync(join(tmpdir(), 'cm-4210-roles-worktree-'));
  vi.spyOn(process, 'cwd').mockReturnValue(serverCwd);
  resetSafeDirectoryWarnings();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(serverCwd, { recursive: true, force: true });
  rmSync(launchCwd, { recursive: true, force: true });
});

describe('a relative CM_AGENT_ROLE_ARTIFACTS_DIR (Issue #4210)', () => {
  const options = (): ArtifactOptions => ({ env: { [AGENT_ROLE_ARTIFACTS_DIR_ENV_VAR]: 'rel-roles' } });

  it('is resolved against the cwd the file is written from', () => {
    expect(resolveArtifactLocation('claude', NAME, options()).path).toBe(
      join(serverCwd, 'rel-roles', 'claude', `${NAME}.md`)
    );
  });

  it.each(['claude', 'command-code'] as const)('names, from the launch cwd, the file written for %s', (adapter) => {
    // Before anything is written: the old implementation stops here.
    expect(isAbsolute(resolveArtifactLocation(adapter, NAME, options()).path)).toBe(true);

    const { artifact, role } = launch(adapter, options());
    const flag = adapter === 'claude' ? '--append-system-prompt-file' : '--mod';
    const operand = operandAfter(role.args, flag);
    expect(existsSync(artifact.path)).toBe(true);
    expect(resolve(launchCwd, operand)).toBe(artifact.path);
  });

  it('names, from the launch cwd, the file in OpenCode V1 instructions', () => {
    expect(isAbsolute(resolveArtifactLocation('opencode', NAME, options()).path)).toBe(true);

    const { artifact, role } = launch('opencode', options());
    const content = JSON.parse(role.env.OPENCODE_CONFIG_CONTENT) as { instructions: string[] };
    expect(resolve(launchCwd, content.instructions[0])).toBe(artifact.path);
    expect(existsSync(artifact.path)).toBe(true);
  });

  it('does the same for ArtifactOptions.dataRoot', () => {
    expect(resolveArtifactLocation('claude', NAME, { dataRoot: 'opt-roles', env: {} }).path).toBe(
      join(serverCwd, 'opt-roles', 'claude', `${NAME}.md`)
    );
  });

  it('is refused when its absolute form is inside /proc, as an absolute value is', () => {
    vi.mocked(process.cwd).mockReturnValue('/proc');
    expect(resolveArtifactLocation('claude', NAME, options()).path).toBe(
      join(homedir(), '.commandmate', 'agent-roles', 'claude', `${NAME}.md`)
    );
  });
});

describe('a relative COPILOT_HOME (Issue #4210)', () => {
  it('is resolved against the cwd the definition is written from', () => {
    vi.stubEnv('COPILOT_HOME', 'rel-copilot');
    expect(getCopilotHomeDirectory()).toBe(join(serverCwd, 'rel-copilot'));
  });

  it('is handed to copilot in a form that finds, from the launch cwd, the agent written', () => {
    vi.stubEnv('COPILOT_HOME', 'rel-copilot');
    // Before anything is written: the old implementation stops here.
    expect(isAbsolute(getCopilotHomeDirectory())).toBe(true);

    const { artifact, role } = launch('copilot', { env: {} });
    const home = role.env.COPILOT_HOME;
    expect(existsSync(artifact.path)).toBe(true);
    // copilot looks up `--agent <name>` in `<COPILOT_HOME>/agents/`, from the worktree:
    expect(resolve(launchCwd, home, 'agents', `${operandAfter(role.args, '--agent')}.agent.md`)).toBe(artifact.path);
  });

  it('does the same for ArtifactOptions.copilotHome', () => {
    expect(resolveArtifactLocation('copilot', NAME, { copilotHome: 'opt-copilot', env: {} }).path).toBe(
      join(serverCwd, 'opt-copilot', 'agents', `${NAME}.agent.md`)
    );
  });

  it('is refused when its absolute form is inside /proc', () => {
    vi.mocked(process.cwd).mockReturnValue('/proc');
    vi.stubEnv('COPILOT_HOME', 'x');
    expect(getCopilotHomeDirectory()).toBe(join(homedir(), '.copilot'));
  });
});

describe('what does not change (negative controls)', () => {
  it('absolute values are used as given', () => {
    const roles = join(serverCwd, 'abs-roles');
    const copilot = join(serverCwd, 'abs-copilot');
    expect(resolveArtifactLocation('claude', NAME, { env: { [AGENT_ROLE_ARTIFACTS_DIR_ENV_VAR]: roles } }).path).toBe(
      join(roles, 'claude', `${NAME}.md`)
    );
    vi.stubEnv('COPILOT_HOME', copilot);
    expect(getCopilotHomeDirectory()).toBe(copilot);

    const { artifact, role } = launch('claude', { env: { [AGENT_ROLE_ARTIFACTS_DIR_ENV_VAR]: roles } });
    expect(resolve(launchCwd, operandAfter(role.args, '--append-system-prompt-file'))).toBe(artifact.path);
  });

  it('unset or empty, the defaults are under the home directory', () => {
    vi.stubEnv('COPILOT_HOME', '');
    expect(getCopilotHomeDirectory()).toBe(join(homedir(), '.copilot'));
    expect(resolveArtifactLocation('claude', NAME, { env: {} }).path).toBe(
      join(homedir(), '.commandmate', 'agent-roles', 'claude', `${NAME}.md`)
    );
  });
});
