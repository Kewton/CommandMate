/**
 * Issue #4134: a UAT server's role files go under its run, and the isolation
 * checks measure that on the running process.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';

const ROOT = path.resolve(__dirname, '../../..');
const runServer = fs.readFileSync(path.join(ROOT, 'scripts/uat/run-server.sh'), 'utf8');
const readChecks = (file: string): string[] =>
  (YAML.parse(fs.readFileSync(path.join(ROOT, '.commandmate', file), 'utf8')) as { isolation: { checks: string[] } })
    .isolation.checks;
const spec = { isolation: { checks: readChecks('uat.yaml') } };

describe('CM_AGENT_ROLE_ARTIFACTS_DIR in the UAT isolation', () => {
  it('is set under the run on the env -i line that starts the server', () => {
    const logical = runServer.replace(/\\\n\s*/g, ' ').split('\n');
    const [line] = logical.filter((l) => l.includes('$SERVER_ENTRY'));
    expect(line.trimStart().startsWith('env -i ')).toBe(true);
    const at = line.indexOf('CM_AGENT_ROLE_ARTIFACTS_DIR="$RUN_DIR/agent-roles"');
    expect(at).toBeGreaterThan(line.indexOf('env -i'));
    expect(at).toBeLessThan(line.indexOf('nohup'));
  });

  it('is checked on the running process, positive and negative', () => {
    const checks = spec.isolation.checks.filter((c) => c.includes('CM_AGENT_ROLE_ARTIFACTS_DIR'));
    expect(
      checks.some((c) => c.includes("grep -qxF 'CM_AGENT_ROLE_ARTIFACTS_DIR={run_dir}/agent-roles'") && !c.includes('! ps'))
    ).toBe(true);
    expect(checks.some((c) => c.includes('! ps eww') && c.includes('grep -vF'))).toBe(true);
  });

  it('is checked by the own-home set too, positive and negative', () => {
    const checks = readChecks('uat-own-home.yaml').filter((c) => c.includes('CM_AGENT_ROLE_ARTIFACTS_DIR'));
    expect(
      checks.some((c) => c.includes("grep -qxF 'CM_AGENT_ROLE_ARTIFACTS_DIR={run_dir}/agent-roles'") && !c.includes('! ps'))
    ).toBe(true);
    expect(checks.some((c) => c.includes('! ps eww') && c.includes('grep -vF'))).toBe(true);
  });

  it.each(['docs/user-guide/uat-isolation.md', 'docs/en/user-guide/uat-isolation.md'])(
    '%s says where the role files go and how that is measured',
    (file) => {
      const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
      expect(text).toContain('CM_AGENT_ROLE_ARTIFACTS_DIR');
      expect(text).toContain('~/.commandmate/agent-roles');
      expect(text).toContain('ps eww');
    }
  );
});

describe('CM_AGENT_ROLE_ARTIFACTS_DIR in the daily check', () => {
  const NAME = 'CM_AGENT_ROLE_ARTIFACTS_DIR';
  let saved: Record<string, string | undefined>;
  const MANAGED = ['CM_PORT', 'CM_AGENT_HOOKS_DIR', 'CM_OPENCODE_V2_DIR', NAME];

  beforeEach(() => {
    saved = Object.fromEntries(MANAGED.map((name) => [name, process.env[name]]));
  });

  afterEach(() => {
    for (const name of MANAGED) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  it("moves this process's role files with the rest of its launch environment", async () => {
    const { redirectLaunchEnvironment } = await import('../../../scripts/agent-health/main');
    process.env[NAME] = '/somewhere/inherited';
    redirectLaunchEnvironment(3999, '/run/hooks', '/run/opencode-v2-state', '/run/role-artifacts');
    expect(process.env[NAME]).toBe('/run/role-artifacts');
    expect(process.env.CM_OPENCODE_V2_DIR).toBe('/run/opencode-v2-state');
  }, 30000);

  it('points the children at the same place the probes generate into', () => {
    const main = fs.readFileSync(path.join(ROOT, 'scripts/agent-health/main.ts'), 'utf8');
    expect(main).toMatch(/const roleArtifactsDir = path\.join\(workRoot, 'role-artifacts'\);/);
    expect(main).toMatch(/buildChildEnv\(process\.env, \{[^}]*CM_AGENT_ROLE_ARTIFACTS_DIR: roleArtifactsDir,/);
    const probe = fs.readFileSync(path.join(ROOT, 'scripts/agent-health/probe-tool.ts'), 'utf8');
    expect(probe).toContain("dataRoot: path.join(ctx.workRoot, 'role-artifacts')");
  });
});
