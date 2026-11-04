/**
 * Issue #4134: a UAT server's role files go under its run, and the isolation
 * checks measure that on the running process.
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

const ROOT = path.resolve(__dirname, '../../..');
const runServer = fs.readFileSync(path.join(ROOT, 'scripts/uat/run-server.sh'), 'utf8');
const spec = YAML.parse(fs.readFileSync(path.join(ROOT, '.commandmate/uat.yaml'), 'utf8')) as {
  isolation: { checks: string[] };
};

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
});
