/**
 * Issue #3044: scripts/agent-health/metrics.sh syncs through
 * `daily.sh --sync-only` and, when the sync fails, writes a minimal metrics
 * report (completedAt + scriptErrors) and exits 2 without measuring.
 *
 * A work clone under os.tmpdir() holds copies of both scripts and has no
 * `origin`, so the pull fails.
 */

import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPTS = path.resolve(__dirname, '../../../../scripts/agent-health');

let root: string;
let work: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cm-metrics-sh-test-'));
  work = path.join(root, 'work');
  const gitconfig = path.join(root, 'gitconfig');
  fs.writeFileSync(gitconfig, '[user]\n\tname = metrics-test\n\temail = test@example.invalid\n[init]\n\tdefaultBranch = develop\n');
  env = {
    ...(Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))) as NodeJS.ProcessEnv),
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    TMPDIR: root,
  };
  fs.mkdirSync(path.join(work, 'scripts', 'agent-health'), { recursive: true });
  for (const name of ['daily.sh', 'metrics.sh']) {
    fs.copyFileSync(path.join(SCRIPTS, name), path.join(work, 'scripts', 'agent-health', name));
  }
  const git = (...args: string[]) => execFileSync('git', args, { cwd: work, env, stdio: 'ignore' });
  git('init', '-q');
  git('add', '.');
  git('commit', '-q', '-m', 'seed');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('metrics.sh', () => {
  it('on a failed sync writes a minimal report with the reason and exits 2', () => {
    const out = path.join(root, 'metrics', 'nested', 'today.json');
    const result = spawnSync('bash', [path.join(work, 'scripts', 'agent-health', 'metrics.sh'), '--out', out], {
      cwd: root,
      env,
      encoding: 'utf8',
    });
    expect(result.status).toBe(2);
    expect(result.stdout).toMatch(/^AGENT_HEALTH_SYNC status=failed reason=pull-failed/m);
    const report = JSON.parse(fs.readFileSync(out, 'utf8'));
    expect(report).toMatchObject({ schemaVersion: 1, metrics: [], queue: [] });
    expect(typeof report.completedAt).toBe('string');
    expect(report.scriptErrors[0]).toMatch(/^sync: pull-failed/);
    // the sync's own agent-health report went to a temp dir that is gone
    expect(fs.readdirSync(root).filter((name) => name.startsWith('cm-agent-health-metrics-sync'))).toEqual([]);
  });

  it('rejects an unknown argument', () => {
    const result = spawnSync('bash', [path.join(work, 'scripts', 'agent-health', 'metrics.sh'), '--bogus'], {
      cwd: root,
      env,
      encoding: 'utf8',
    });
    expect(result.status).toBe(2);
  });
});
