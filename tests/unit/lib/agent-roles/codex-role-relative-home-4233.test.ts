/**
 * Issue #4233, item 1 (roles): a relative `CODEX_HOME` put a role's codex
 * profile under the server's cwd and handed codex the relative home, which
 * codex resolves against the worktree.
 *
 * `resolveArtifactLocation('codex')` writes `<CODEX_HOME>/<name>.config.toml`
 * relative to the server's cwd, and `buildRoleLaunchArguments`
 * (`agent-roles/adapters.ts`) pins `CODEX_HOME: dirname(artifact.path)` on the
 * launch line. Each test pairs the cwd the file is written from (`serverCwd`)
 * with the cwd codex runs in (`launchCwd`), as
 * `role-artifacts-relative-dir-4210.test.ts` does.
 * docs/design/relative-config-home-4233.md §3.3, #8-#10 and #15-#16.
 *
 * Nothing is written outside the two directories made under `os.tmpdir()`.
 * The relative-path assertions come before anything is written, so the
 * implementation before the fix stops there without writing into the checkout.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { isAbsolute, join, resolve } from 'path';
import { resetSafeDirectoryWarnings } from '@/config/safe-directory';
import { buildRoleLaunchArguments } from '@/lib/agent-roles/adapters';
import { resolveArtifactLocation, writeRoleArtifact } from '@/lib/agent-roles/artifacts';

const NAME = 'cm-role-ns-0011223344556677-cdcdcdcdcdcd';

let serverCwd: string;
let launchCwd: string;

beforeEach(() => {
  serverCwd = mkdtempSync(join(tmpdir(), 'cm-4233-role-server-'));
  launchCwd = mkdtempSync(join(tmpdir(), 'cm-4233-role-worktree-'));
  vi.spyOn(process, 'cwd').mockReturnValue(serverCwd);
  vi.stubEnv('CM_UAT_ISOLATION', '');
  resetSafeDirectoryWarnings();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(serverCwd, { recursive: true, force: true });
  rmSync(launchCwd, { recursive: true, force: true });
});

describe('a role for codex under a relative CODEX_HOME (Issue #4233)', () => {
  it('#8 the profile path is absolute, under the server cwd', () => {
    const location = resolveArtifactLocation('codex', NAME, { codexHome: 'rel-codex' });
    expect(isAbsolute(location.path)).toBe(true);
    expect(location.path).toBe(join(serverCwd, 'rel-codex', `${NAME}.config.toml`));
  });

  it('#9 the CODEX_HOME the role pins names, from the launch cwd, the profile written', () => {
    const options = { codexHome: 'rel-codex' };
    // Before anything is written: the old implementation stops here.
    expect(isAbsolute(resolveArtifactLocation('codex', NAME, options).path)).toBe(true);
    mkdirSync(join(serverCwd, 'rel-codex'), { recursive: true });

    const artifact = writeRoleArtifact({ adapter: 'codex', name: NAME, instructions: 'be a reviewer' }, options);
    const role = buildRoleLaunchArguments({ adapter: 'codex', effectiveAgent: null }, artifact, {});
    expect(role.args).toEqual(['-p', NAME]);
    const pinned = role.env.CODEX_HOME;
    expect(existsSync(join(resolve(launchCwd, pinned), `${NAME}.config.toml`))).toBe(true);
    expect(join(resolve(launchCwd, pinned), `${NAME}.config.toml`)).toBe(artifact.path);
  });

  it('#10 an absolute codexHome gives the same path and CODEX_HOME as before', () => {
    const home = join(serverCwd, 'abs-codex');
    mkdirSync(home);
    const options = { codexHome: home };
    expect(resolveArtifactLocation('codex', NAME, options).path).toBe(join(home, `${NAME}.config.toml`));
    const artifact = writeRoleArtifact({ adapter: 'codex', name: NAME, instructions: 'be a reviewer' }, options);
    const role = buildRoleLaunchArguments({ adapter: 'codex', effectiveAgent: null }, artifact, {});
    expect(role.env.CODEX_HOME).toBe(home);
  });
});

describe('the shared-state protection a relative CODEX_HOME already had (Issue #4233, kept)', () => {
  it('#15 a data root inside the relative CODEX_HOME is still shared state', () => {
    vi.stubEnv('CODEX_HOME', 'rel-codex');
    const location = resolveArtifactLocation('claude', NAME, { dataRoot: join(serverCwd, 'rel-codex', 'roles'), env: {} });
    expect(location.inSharedHome).toBe(true);
  });

  it('#16 an independent directory beside it is not', () => {
    vi.stubEnv('CODEX_HOME', 'rel-codex');
    const location = resolveArtifactLocation('claude', NAME, { dataRoot: join(serverCwd, 'independent'), env: {} });
    expect(location.inSharedHome).toBe(false);
  });
});
