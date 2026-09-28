/**
 * Issue #2924: scripts/agent-health/daily.sh syncs to origin/develop, installs
 * dependencies only when package-lock.json changed, and on a failed sync writes
 * a minimal report and exits 2 instead of running the check.
 *
 * Everything happens under os.tmpdir(): a bare origin, a seed clone that pushes
 * to it, and a work clone holding a copy of daily.sh. `--sync-only` stops
 * before run.ts; `AGENT_HEALTH_NPM_INSTALL_CMD` only writes a marker file.
 */

import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = path.resolve(__dirname, '../../../../scripts/agent-health/daily.sh');

let root: string;
let origin: string;
let seed: string;
let work: string;
let marker: string;
let out: string;
let env: NodeJS.ProcessEnv;

function baseEnv(): NodeJS.ProcessEnv {
  const next = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
  ) as NodeJS.ProcessEnv;
  const gitconfig = path.join(root, 'gitconfig');
  fs.writeFileSync(gitconfig, '[user]\n\tname = agent-health-test\n\temail = test@example.invalid\n[init]\n\tdefaultBranch = develop\n');
  return {
    ...next,
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    AGENT_HEALTH_NPM_INSTALL_CMD: `touch '${marker}'`,
  };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function commit(cwd: string, file: string, content: string, message: string): void {
  fs.writeFileSync(path.join(cwd, file), content);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', message);
}

/** Adds a commit to origin/develop through the seed clone. */
function pushToOrigin(file: string, content: string): void {
  commit(seed, file, content, `update ${file}`);
  git(seed, 'push', '-q', 'origin', 'HEAD:develop');
}

function runDaily(): { status: number | null; stdout: string; stderr: string; syncLine: string } {
  const result = spawnSync(
    'bash',
    [path.join(work, 'scripts', 'agent-health', 'daily.sh'), '--out', out, '--sync-only'],
    { cwd: root, env, encoding: 'utf8' }
  );
  const syncLine = result.stdout.split('\n').find((line) => line.startsWith('AGENT_HEALTH_SYNC ')) ?? '';
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, syncLine };
}

function field(line: string, name: string): string | undefined {
  return line.match(new RegExp(`(?:^| )${name}=(\\S+)`))?.[1];
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cm-daily-sh-test-'));
  origin = path.join(root, 'origin.git');
  seed = path.join(root, 'seed');
  work = path.join(root, 'work');
  marker = path.join(root, 'npm-install-ran');
  out = path.join(root, 'reports', 'nested', 'report.json');
  env = baseEnv();

  git(root, 'init', '-q', '--bare', origin);
  git(root, 'init', '-q', seed);
  git(seed, 'checkout', '-q', '-b', 'develop');
  fs.mkdirSync(path.join(seed, 'scripts', 'agent-health'), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(seed, 'scripts', 'agent-health', 'daily.sh'));
  fs.writeFileSync(path.join(seed, 'package-lock.json'), '{"lockfileVersion":3}\n');
  fs.writeFileSync(path.join(seed, 'README.md'), 'seed\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-q', '-m', 'seed');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '-q', 'origin', 'HEAD:develop');
  git(origin, 'symbolic-ref', 'HEAD', 'refs/heads/develop');

  git(root, 'clone', '-q', '-b', 'develop', origin, work);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('daily.sh sync', () => {
  it('fast-forwards to a new origin/develop commit without npm install', () => {
    const before = git(work, 'rev-parse', 'HEAD');
    pushToOrigin('README.md', 'changed\n');

    const result = runDaily();
    const after = git(work, 'rev-parse', 'HEAD');

    expect(result.status).toBe(0);
    expect(after).toBe(git(seed, 'rev-parse', 'HEAD'));
    expect(field(result.syncLine, 'status')).toBe('ok');
    expect(field(result.syncLine, 'before')).toBe(before.slice(0, 8));
    expect(field(result.syncLine, 'after')).toBe(after.slice(0, 8));
    expect(field(result.syncLine, 'before')).not.toBe(field(result.syncLine, 'after'));
    expect(field(result.syncLine, 'npm_install')).toBe('skipped');
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.existsSync(out)).toBe(false);
  });

  it('runs npm install when package-lock.json changed', () => {
    pushToOrigin('package-lock.json', '{"lockfileVersion":3,"changed":true}\n');

    const result = runDaily();

    expect(result.status).toBe(0);
    expect(field(result.syncLine, 'status')).toBe('ok');
    expect(field(result.syncLine, 'npm_install')).toBe('done');
    expect(fs.existsSync(marker)).toBe(true);
  });

  it('keeps before = after and skips npm install when nothing changed (even after an earlier move)', () => {
    // An earlier pull that touched package-lock.json: HEAD@{1} would still see it.
    pushToOrigin('package-lock.json', '{"lockfileVersion":3,"changed":true}\n');
    expect(runDaily().status).toBe(0);
    fs.rmSync(marker, { force: true });

    const result = runDaily();

    expect(result.status).toBe(0);
    expect(field(result.syncLine, 'status')).toBe('ok');
    expect(field(result.syncLine, 'before')).toBe(field(result.syncLine, 'after'));
    expect(field(result.syncLine, 'npm_install')).toBe('skipped');
    expect(fs.existsSync(marker)).toBe(false);
  });
});

describe('daily.sh failed sync', () => {
  function readReport(): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(out, 'utf8')) as Record<string, unknown>;
  }

  function expectMinimalReport(before: string, reasonPrefix: string): void {
    const report = readReport();
    expect(report.schemaVersion).toBe(1);
    expect(typeof report.startedAt).toBe('string');
    expect(typeof report.completedAt).toBe('string');
    expect(Number.isNaN(Date.parse(report.completedAt as string))).toBe(false);
    expect(report.host).toMatchObject({ commandmateCommit: before });
    expect((report.host as { node: string }).node).toMatch(/^v\d+/);
    expect(report.tools).toEqual([]);
    expect(report.safety).toEqual({ globalConfigRestored: [], tmuxSocket: 'cm-agent-health' });
    const errors = report.scriptErrors as string[];
    expect(errors).toHaveLength(1);
    expect(errors[0].startsWith(`sync: ${reasonPrefix}`)).toBe(true);
    const sync = report.sync as { status: string; before: string; after: string; reason: string };
    expect(sync).toMatchObject({ status: 'failed', before, after: before });
    expect(sync.reason.startsWith(reasonPrefix)).toBe(true);
  }

  it('refuses to pull over uncommitted changes to tracked files', () => {
    const before = git(work, 'rev-parse', 'HEAD');
    pushToOrigin('README.md', 'changed\n');
    fs.writeFileSync(path.join(work, 'README.md'), 'local edit\n');

    const result = runDaily();

    expect(result.status).toBe(2);
    expect(result.syncLine).toBe(`AGENT_HEALTH_SYNC status=failed reason=dirty-worktree before=${before.slice(0, 8)}`);
    expect(git(work, 'rev-parse', 'HEAD')).toBe(before);
    expectMinimalReport(before, 'dirty-worktree');
  });

  it('ignores untracked files', () => {
    fs.writeFileSync(path.join(work, 'CMATE.md'), 'schedule\n');

    const result = runDaily();

    expect(result.status).toBe(0);
    expect(field(result.syncLine, 'status')).toBe('ok');
  });

  it('fails when the pull cannot fast-forward', () => {
    commit(work, 'local.txt', 'local\n', 'local commit');
    const before = git(work, 'rev-parse', 'HEAD');
    pushToOrigin('README.md', 'changed\n');

    const result = runDaily();

    expect(result.status).toBe(2);
    expect(field(result.syncLine, 'status')).toBe('failed');
    expect(result.syncLine).toMatch(/ reason=pull-failed: \S/);
    expect(result.syncLine.endsWith(` before=${before.slice(0, 8)}`)).toBe(true);
    expect(git(work, 'rev-parse', 'HEAD')).toBe(before);
    expectMinimalReport(before, 'pull-failed: ');
  });

  it('fails when npm install fails', () => {
    const before = git(work, 'rev-parse', 'HEAD');
    pushToOrigin('package-lock.json', '{"lockfileVersion":3,"changed":true}\n');
    env = { ...env, AGENT_HEALTH_NPM_INSTALL_CMD: `touch '${marker}'; exit 1` };

    const result = runDaily();

    expect(result.status).toBe(2);
    expect(result.syncLine).toBe(`AGENT_HEALTH_SYNC status=failed reason=npm-install-failed before=${before.slice(0, 8)}`);
    expect(fs.existsSync(marker)).toBe(true);
    expectMinimalReport(before, 'npm-install-failed');
  });
});
