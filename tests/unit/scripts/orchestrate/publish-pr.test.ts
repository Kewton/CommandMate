/**
 * scripts/orchestrate/publish-pr.mjs — push and open the PR once (Issue #3477, PR 3).
 *
 * `git` and `gh` are the fake of ./pr-fake.ts: nothing is pushed or opened.
 * The run record and the worktree's dev-reports/ are under os.tmpdir().
 *
 * @vitest-environment node
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendRecord, readRecords } from '../../../../scripts/orchestrate/run-log.mjs';
import { defaultBody, main, parseArgs, prNumberFromUrl, validate } from '../../../../scripts/orchestrate/publish-pr.mjs';
import { HEAD_A, HEAD_B, fakeGit, openPr } from './pr-fake';

let tmp: string;
let runDir: string;
let worktree: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-orchestrate-publish-'));
  runDir = path.join(tmp, 'runs', '2026-10-09');
  worktree = path.join(tmp, 'wt');
  fs.mkdirSync(path.join(worktree, 'dev-reports', 'module-reference'), { recursive: true });
  fs.writeFileSync(path.join(worktree, 'dev-reports', 'module-reference', 'issue-3477.md'), '追記なし\n');
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const argv = (...extra: string[]) => ['--run-dir', runDir, '--issues', '3477', '--issue', '3477', '--worktree', worktree, ...extra];

/** Records every stage before the PR as passed on `head`. */
function recordReady(head = HEAD_A) {
  for (const stage of ['verify', 'review', 'findings', 'precheck']) {
    appendRecord(runDir, '3477', { issue: 3477, stage, result: 'ok', head });
  }
}

function runMain(fake: ReturnType<typeof fakeGit>, ...extra: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = main(argv(...extra), { run: fake.run, log: (l: string) => out.push(l), error: (l: string) => err.push(l) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('parseArgs', () => {
  it('requires the run, the Issue and the worktree', () => {
    expect(parseArgs(['--run-dir', 'r', '--issues', '1']).error).toMatch(/--issue is required/);
    expect(parseArgs(['--run-dir', 'r', '--issues', '1', '--issue', '1', '--worktree', '/w']).options).toMatchObject({
      base: 'develop',
      repo: 'Kewton/CommandMate',
    });
    const options = parseArgs(['--run-dir', 'r', '--issues', '1', '--issue', 'x', '--worktree', '/w']).options;
    expect(validate(options)).toMatch(/--issue/);
    expect(main(['--run-dir', 'r', '--issues', '1', '--issue', 'x', '--worktree', '/w'], { error: () => {} })).toBe(2);
  });
});

describe('helpers', () => {
  it('reads the PR number from gh pr create', () => {
    expect(prNumberFromUrl('https://github.com/Kewton/CommandMate/pull/3493\n')).toBe(3493);
    expect(prNumberFromUrl('something went wrong')).toBeNull();
  });

  it('names the Issue without a closing keyword (merge-pr.mjs closes it)', () => {
    expect(defaultBody('## 決めたこと\n- x\n', 3477)).toBe('## 決めたこと\n- x\n\nRefs #3477\n');
    expect(defaultBody('', 3477)).toBe('Refs #3477\n');
  });
});

describe('main: stops before publishing', () => {
  it('stops when the run record lacks a stage of this HEAD, and pushes nothing (positive control)', () => {
    appendRecord(runDir, '3477', { issue: 3477, stage: 'verify', result: 'ok', head: HEAD_A });
    appendRecord(runDir, '3477', { issue: 3477, stage: 'precheck', result: 'ok', head: HEAD_A });
    const fake = fakeGit();
    const { code, err } = runMain(fake);
    expect(code).toBe(1);
    expect(err).toContain('review: no record for aaaaaaa');
    expect(err).toContain('findings: no record for aaaaaaa');
    expect(fake.gitCalls('push')).toHaveLength(0);
    expect(fake.ghCalls('pr create')).toHaveLength(0);
  });

  it('does not take records of an earlier HEAD of the work', () => {
    recordReady(HEAD_B);
    const fake = fakeGit();
    const { code, err } = runMain(fake);
    expect(code).toBe(1);
    expect(err).toContain('precheck: no record for aaaaaaa');
  });

  it('stops on a failed precheck recorded after an ok one', () => {
    recordReady();
    appendRecord(runDir, '3477', { issue: 3477, stage: 'precheck', result: 'fail', head: HEAD_A });
    const { code, err } = runMain(fakeGit());
    expect(code).toBe(1);
    expect(err).toContain('precheck: fail at aaaaaaa');
  });

  it('stops without the CHANGELOG fragment in the commits or the module-reference fragment', () => {
    recordReady();
    fs.rmSync(path.join(worktree, 'dev-reports'), { recursive: true });
    const { code, err } = runMain(fakeGit({ changelogStatus: '' }));
    expect(code).toBe(1);
    expect(err).toContain('changelog.d/3477.md is not in the branch');
    expect(err).toContain('dev-reports/module-reference/issue-3477.md is missing');
  });

  it('exits 2 on a dirty tree, ignoring the contract and dev-reports', () => {
    recordReady();
    expect(runMain(fakeGit({ status: ' M src/a.ts\n' })).code).toBe(2);
    expect(runMain(fakeGit({ status: '?? .commandmate/tasks/issue-3477.yaml\n?? dev-reports/x.md\n' })).code).toBe(0);
  });

  it('stops when another branch already has an open PR for the Issue', () => {
    recordReady();
    const fake = fakeGit({ otherOpen: [{ number: 77, title: 'feat: x (#3477)', headRefName: 'feature/3477b-worktree' }] });
    const { code, err } = runMain(fake);
    expect(code).toBe(1);
    expect(err).toContain('#77 (feature/3477b-worktree) is already open for #3477');
    expect(runMain(fakeGit({ otherOpen: fake.state.otherOpen }), '--allow-other-pr').code).toBe(0);
  });
});

describe('main: publishes once', () => {
  it('pushes, opens the PR to develop, backs up the fragment and records the pr stage (negative control)', () => {
    recordReady();
    const fake = fakeGit();
    const { code } = runMain(fake, '--label', 'feature');
    expect(code).toBe(0);
    expect(fake.gitCalls('push')[0].args).toEqual(['-C', worktree, 'push', '-u', 'origin', 'feature/3477-worktree']);
    const create = fake.ghCalls('pr create');
    expect(create).toHaveLength(1);
    expect(create[0].args).toEqual(expect.arrayContaining(['--base', 'develop', '--head', 'feature/3477-worktree', '--label', 'feature']));
    expect(create[0].args[create[0].args.indexOf('--title') + 1]).toBe('feat(orchestrate): publish and merge (#3477)');
    expect(fs.readFileSync(path.join(runDir, 'module-reference-3477.md'), 'utf8')).toBe('追記なし\n');
    const pr = readRecords(runDir, '3477').records.filter((r) => r.stage === 'pr');
    expect(pr).toHaveLength(1);
    expect(pr[0]).toMatchObject({ result: 'ok', head: HEAD_A });
    expect(pr[0].note).toMatch(/^pr=#9001 created /);
  });

  it('does not open a second PR when run again — it records the open one', () => {
    recordReady();
    const fake = fakeGit();
    expect(runMain(fake).code).toBe(0);
    expect(runMain(fake).code).toBe(0);
    expect(fake.ghCalls('pr create')).toHaveLength(1);
    const notes = readRecords(runDir, '3477').records.filter((r) => r.stage === 'pr').map((r) => r.note);
    expect(notes[1]).toMatch(/^pr=#9001 existing /);
  });

  it('pushes a new HEAD to the open PR without opening another', () => {
    recordReady(HEAD_B);
    const fake = fakeGit({
      head: HEAD_B,
      firstParent: [`${HEAD_B} ${HEAD_A}`],
      commitFiles: { [HEAD_B]: ['scripts/orchestrate/merge-pr.mjs'] },
      prs: [openPr()],
    });
    expect(runMain(fake).code).toBe(0);
    expect(fake.gitCalls('push')).toHaveLength(1);
    expect(fake.ghCalls('pr create')).toHaveLength(0);
  });

  it('does nothing for a branch already merged', () => {
    const fake = fakeGit({ prs: [openPr({ state: 'MERGED' })] });
    const { code, out } = runMain(fake);
    expect(code).toBe(0);
    expect(out).toContain('was merged in #4242');
    expect(fake.gitCalls('push')).toHaveLength(0);
    expect(readRecords(runDir, '3477').records).toHaveLength(0);
  });

  it('fails without recording when the push is rejected', () => {
    recordReady();
    const fake = fakeGit({ pushFails: true });
    expect(runMain(fake).code).toBe(1);
    expect(fake.ghCalls('pr create')).toHaveLength(0);
    expect(readRecords(runDir, '3477').records.filter((r) => r.stage === 'pr')).toHaveLength(0);
  });
});
