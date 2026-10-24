/**
 * The runbook's 5-1 block (a verification without a contract), run (Issue #3883).
 *
 * It wrote `verify-<issue>.json` for every row of an Issue — two PRs of one
 * Issue, or a second run, overwrote each other — read five columns, and
 * recorded no work item or execution key. The block from
 * .claude/commands/orchestrate.md is run as written, in bash and zsh (when
 * installed), with a fake `commandmatedev`, a real git repository and the real
 * execution-key / run-log scripts. Everything is under os.tmpdir().
 *
 * @vitest-environment node
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readRecords } from '../../../../scripts/orchestrate/run-log.mjs';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const orchestrate = fs.readFileSync(path.join(REPO_ROOT, '.claude/commands/orchestrate.md'), 'utf8');
const SHELLS = ['bash', ...(spawnSync('zsh', ['-fc', 'true']).status === 0 ? ['zsh'] : [])];

function section(id: string): string {
  const lines = orchestrate.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`### ${id}.`));
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('### '));
  return rest.slice(0, end).join('\n');
}
const block = [...section('5-1').matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]).find((b) => b.includes('commandmatedev verify "$WT"'))!;

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-runbook-5-1-'));
  fs.mkdirSync(path.join(tmp, 'bin'));
  // A copy, not a link: a script run through a link is not its own main module (import.meta.url is the real path).
  fs.cpSync(path.join(REPO_ROOT, 'scripts', 'orchestrate'), path.join(tmp, 'scripts', 'orchestrate'), { recursive: true });
  const repo = path.join(tmp, 'wt');
  const git = (...args: string[]) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: { ...process.env, HOME: tmp, GIT_CONFIG_GLOBAL: '/dev/null' } });
  fs.mkdirSync(repo);
  git('init', '-q');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'x');
  fs.writeFileSync(path.join(tmp, 'ls.json'), JSON.stringify([{ id: 'wt-1', path: repo }, { id: 'wt-2', path: repo }]));
  fs.writeFileSync(
    path.join(tmp, 'bin', 'commandmatedev'),
    `#!/bin/sh
case "$1" in
  ls) cat "$FAKE_LS" ;;
  verify) printf '{"worktree":"%s"}\\n' "$2"; [ "$2" = wt-2 ] && exit 20; exit 0 ;;
  *) exit 2 ;;
esac
`,
    { mode: 0o755 }
  );
  fs.mkdirSync(path.join(tmp, 'workspace', 'orchestration', 'runs', '2026-10-25'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, 'workspace', 'orchestration', 'runs', '2026-10-25', 'tasks.tsv'),
    [
      '3700\twt-1\tclaude\tt-0\topus',
      '3883\twt-1\tclaude\tt-1\topus\titem=d1',
      '3883\twt-2\tclaude\tt-2\tsonnet\titem=d2',
      '3880\twt-1\tclaude\t-\topus\t3880-a1-r2',
      '',
    ].join('\n')
  );
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function run(shell: string) {
  const args = shell === 'zsh' ? ['-f', '-c', block] : ['--noprofile', '--norc', '-c', block];
  return spawnSync(shell, args, {
    cwd: tmp,
    encoding: 'utf8',
    env: {
      PATH: `${path.join(tmp, 'bin')}:${process.env.PATH}`,
      HOME: tmp,
      GIT_CONFIG_GLOBAL: '/dev/null',
      FAKE_LS: path.join(tmp, 'ls.json'),
      DATE: '2026-10-25',
      RUN_ISSUES: '3700,3880,3883',
    } as unknown as NodeJS.ProcessEnv,
  });
}

describe.each(SHELLS)('5-1 in %s', (shell) => {
  it('each row (and each run of the block) takes a result file of its own, and the record names the work item and the key', () => {
    expect(run(shell).status).toBe(0);
    const second = run(shell);
    expect(second.status, second.stderr).toBe(0);
    const runDir = path.join(tmp, 'workspace', 'orchestration', 'runs', '2026-10-25');
    expect(fs.readdirSync(runDir).filter((f) => f.startsWith('verify-')).sort()).toEqual([
      'verify-3700.a2.json', 'verify-3700.json',
      'verify-3880.a2.json', 'verify-3880.json',
      'verify-3883-d1.a2.json', 'verify-3883-d1.json',
      'verify-3883-d2.a2.json', 'verify-3883-d2.json',
    ]);
    expect(JSON.parse(fs.readFileSync(path.join(runDir, 'verify-3883-d2.json'), 'utf8'))).toEqual({ worktree: 'wt-2' });
    const records = readRecords(runDir, '3700,3880,3883').records.filter((r) => r.stage === 'verify');
    expect(records.map((r) => [r.issue, r.item ?? null, r.key, r.result])).toEqual([
      [3700, null, '3700,3880,3883:3700:t-0:a1', 'ok'],
      [3883, 'd1', '3700,3880,3883:3883-d1:t-1:a1', 'ok'],
      [3883, 'd2', '3700,3880,3883:3883-d2:t-2:a1', 'fail'],
      // An old run's 6th column (a retry label) is not a work item.
      [3880, null, '3700,3880,3883:3880:-:a1', 'ok'],
      [3700, null, '3700,3880,3883:3700:t-0:a2', 'ok'],
      [3883, 'd1', '3700,3880,3883:3883-d1:t-1:a2', 'ok'],
      [3883, 'd2', '3700,3880,3883:3883-d2:t-2:a2', 'fail'],
      [3880, null, '3700,3880,3883:3880:-:a2', 'ok'],
    ]);
    expect(records[2].note).toBe('exit=20 (verify without a contract) verify-3883-d2.json');
  });
});
