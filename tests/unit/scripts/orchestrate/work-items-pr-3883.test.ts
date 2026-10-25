/**
 * Two PRs of one Issue through precheck → publish → merge (Issue #3883, review-3883-d1 P2-3).
 *
 * The run of 2026-10-24 stopped publish-pr.mjs with "verify: no result" because
 * another PR of the same Issue had written its records later: the publishing
 * scripts read the Issue's latest record of each stage, whichever PR wrote it.
 * Here both PRs go through the real precheck.mjs, publish-pr.mjs and
 * merge-pr.mjs, interleaved, with `--item`; `git` / `gh` / `npx` are the fake
 * of ./pr-fake.ts, and the run record is under os.tmpdir().
 *
 * @vitest-environment node
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main as runLog, readRecords, summarize } from '../../../../scripts/orchestrate/run-log.mjs';
import { main as precheck } from '../../../../scripts/orchestrate/precheck.mjs';
import { main as publish } from '../../../../scripts/orchestrate/publish-pr.mjs';
import { main as merge } from '../../../../scripts/orchestrate/merge-pr.mjs';
import { moduleReferenceBackup } from '../../../../scripts/orchestrate/pr-common.mjs';
import { DEVELOP, HEAD_A, HEAD_B, type Check, type Pr, fakeGit } from './pr-fake';

const ISSUE = '3883';
let tmp: string;
let runDir: string;
const worktrees: Record<string, string> = {};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-orchestrate-items-'));
  runDir = path.join(tmp, 'runs', '2026-10-24');
  for (const item of ['d1', 'd2']) {
    worktrees[item] = path.join(tmp, `wt-${item}`);
    fs.mkdirSync(path.join(worktrees[item], 'dev-reports', 'module-reference'), { recursive: true });
    fs.writeFileSync(path.join(worktrees[item], 'dev-reports', 'module-reference', `issue-${ISSUE}.md`), `${item} の追記\n`);
  }
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const pass = (name: string): Check => ({ name, bucket: 'pass', link: 'https://github.com/Kewton/CommandMate/actions/runs/555/job/1' });

/** One GitHub for both PRs: the PR list is shared, each worktree is its own branch and HEAD. */
function twoWorktrees() {
  const prs: Pr[] = [];
  const of = (item: string, head: string, createdNumber: number) =>
    fakeGit({
      head,
      branch: `feature/${ISSUE}-${item}`,
      firstParent: [`${head} ${DEVELOP}`],
      commitFiles: { [head]: ['scripts/orchestrate/wait-verify.mjs', `changelog.d/${ISSUE}.md`] },
      changelogStatus: `A\tchangelog.d/${ISSUE}.md`,
      changed: ['scripts/orchestrate/wait-verify.mjs', `changelog.d/${ISSUE}.md`],
      prs,
      createdNumber,
    });
  const fakes = { d1: of('d1', HEAD_A, 9001), d2: of('d2', HEAD_B, 9002) };
  /** `gh pr list --state open` of either worktree sees every open PR. */
  const syncOpen = () => {
    const open = prs.filter((pr) => pr.state === 'OPEN').map((pr) => ({ number: pr.number, title: pr.title, headRefName: pr.headRefName, body: `Refs #${ISSUE}` }));
    fakes.d1.state.otherOpen = open;
    fakes.d2.state.otherOpen = open;
  };
  return { prs, fakes, syncOpen };
}

const common = (item: string) => ['--run-dir', runDir, '--issues', ISSUE, '--issue', ISSUE, '--worktree', worktrees[item]];

/** The worker's checks, through the run record's own command line (`run-log.mjs append`). */
function recordWork(item: string, head: string, verifyNote: string) {
  const append = (stage: string, note?: string) =>
    runLog(['append', '--run-dir', runDir, '--issues', ISSUE, '--issue', ISSUE, '--item', item, '--stage', stage, '--result', 'ok', '--head', head, ...(note ? ['--note', note] : [])]);
  expect(append('verify', verifyNote)).toBe(0);
  expect(append('review')).toBe(0);
  expect(append('findings')).toBe(0);
}

function call(fn: typeof precheck, fake: ReturnType<typeof fakeGit>, argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  let clock = Date.UTC(2026, 9, 24, 3, 0);
  const code = fn(argv, {
    run: fake.run,
    sleep: (ms: number) => {
      clock += ms;
    },
    now: () => new Date(clock),
    findTestsNaming: () => [],
    log: (l: string) => out.push(l),
    error: (l: string) => err.push(l),
  } as Parameters<typeof precheck>[1]);
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const records = () => readRecords(runDir, ISSUE).records;
const silent = (l: string) => void l;

describe('two PRs of one Issue, interleaved, each on its own records (#3883)', () => {
  it('precheck → publish → merge of each PR: neither stops on the other’s records, nor passes on them', () => {
    const { fakes, syncOpen } = twoWorktrees();

    // d1's checks first, then d2's at its own HEAD — d2's are the Issue's latest records.
    recordWork('d1', HEAD_A, 'exit=0(passed) passed=lint,typecheck,unit-related failed=-');
    expect(call(precheck, fakes.d1, [...common('d1'), '--item', 'd1']).code).toBe(0);
    recordWork('d2', HEAD_B, 'exit=0(passed) passed=lint,typecheck,unit failed=-');
    expect(call(precheck, fakes.d2, [...common('d2'), '--item', 'd2']).code).toBe(0);

    // Each precheck has its own log, and a rerun on the same HEAD does not overwrite it.
    expect(fs.existsSync(path.join(runDir, `precheck-${ISSUE}-d1-${HEAD_A.slice(0, 7)}.log`))).toBe(true);
    expect(fs.existsSync(path.join(runDir, `precheck-${ISSUE}-d2-${HEAD_B.slice(0, 7)}.log`))).toBe(true);
    expect(call(precheck, fakes.d1, [...common('d1'), '--item', 'd1', '--force']).code).toBe(0);
    expect(fs.existsSync(path.join(runDir, `precheck-${ISSUE}-d1-${HEAD_A.slice(0, 7)}.a2.log`))).toBe(true);

    // publish d1 after d2's records: it reads d1's (before #3883: "verify: no result for aaaaaaa").
    const published1 = call(publish, fakes.d1, [...common('d1'), '--item', 'd1']);
    expect(published1.err).toBe('');
    expect(published1.code).toBe(0);
    syncOpen();
    // publish d2: d1's PR is this run's PR of the Issue's other work item, not "two PRs for one Issue".
    const published2 = call(publish, fakes.d2, [...common('d2'), '--item', 'd2']);
    expect(published2.err).toBe('');
    expect(published2.code).toBe(0);
    expect(fs.readFileSync(moduleReferenceBackup(runDir, Number(ISSUE), 'd1'), 'utf8')).toBe('d1 の追記\n');
    expect(fs.readFileSync(moduleReferenceBackup(runDir, Number(ISSUE), 'd2'), 'utf8')).toBe('d2 の追記\n');

    // merge d1: its verification ran unit-related, so it waits for `Unit Tests` —
    // d2's full `unit` gate does not stand for it.
    fakes.d1.state.checks = [[pass('Lint'), pass('Build')]];
    const waiting = call(merge, fakes.d1, [...common('d1'), '--item', 'd1', '--ci-timeout', '0']);
    expect(waiting.code).toBe(124);
    expect(waiting.err).toMatch(/waiting for Unit Tests/);

    fakes.d1.state.checks = [[pass('Lint'), pass('Build'), pass('Unit Tests')]];
    expect(call(merge, fakes.d1, [...common('d1'), '--item', 'd1']).code).toBe(0);
    // One PR of two does not close the Issue.
    expect(fakes.d1.ghCalls('issue')).toEqual([]);

    // merge d2 after d1's merge: d2 is not done by d1's merge=ok, and it closes the Issue when asked.
    fakes.d2.state.checks = [[pass('Lint'), pass('Build')]];
    const merged2 = call(merge, fakes.d2, [...common('d2'), '--item', 'd2', '--close', ISSUE]);
    expect(merged2.err).toBe('');
    expect(merged2.code).toBe(0);
    expect(fakes.d2.state.issueState).toBe('CLOSED');

    // Every record of the publishing scripts carries its work item; status resumes each one to the end.
    const byItem = (item: string) => records().filter((r) => r.item === item).map((r) => `${r.stage}=${r.result}`);
    expect(byItem('d1')).toEqual(['verify=ok', 'review=ok', 'findings=ok', 'precheck=ok', 'precheck=ok', 'pr=ok', 'ci=ok', 'merge=ok']);
    expect(byItem('d2')).toEqual(['verify=ok', 'review=ok', 'findings=ok', 'precheck=ok', 'pr=ok', 'ci=ok', 'merge=ok']);
    expect(records().every((r) => r.item === 'd1' || r.item === 'd2')).toBe(true);
    expect(summarize(records()).map((s) => [s.item ?? null, s.reached, s.next])).toEqual([
      ['d1', 'merge', null],
      ['d2', 'merge', null],
    ]);
  });

  it('the other PR’s records do not pass this one: d2 ready, d1 missing its review → d1 is not published', () => {
    const { fakes } = twoWorktrees();
    expect(
      runLog(['append', '--run-dir', runDir, '--issues', ISSUE, '--issue', ISSUE, '--item', 'd1', '--stage', 'verify', '--result', 'ok', '--head', HEAD_A])
    ).toBe(0);
    recordWork('d2', HEAD_B, 'exit=0(passed) passed=lint failed=-');
    expect(call(precheck, fakes.d2, [...common('d2'), '--item', 'd2']).code).toBe(0);
    // d2's review / findings / precheck are later than d1's verify and name another HEAD, so they cannot stand for d1.
    const result = call(publish, fakes.d1, [...common('d1'), '--item', 'd1']);
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/review: no result for aaaaaaa/);
    expect(result.err).toMatch(/precheck: no result for aaaaaaa/);
    expect(fakes.d1.gitCalls('push')).toEqual([]);
  });

  it('without --item the work item records are not the Issue’s own: publish stops instead of mixing them', () => {
    const { fakes } = twoWorktrees();
    recordWork('d1', HEAD_A, 'exit=0(passed) passed=lint failed=-');
    expect(call(precheck, fakes.d1, [...common('d1'), '--item', 'd1']).code).toBe(0);
    const result = call(publish, fakes.d1, common('d1'));
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/verify: no result for aaaaaaa/);
  });

  it('a PR of the Issue the run record does not know still stops publish (negative control)', () => {
    const { fakes } = twoWorktrees();
    recordWork('d1', HEAD_A, 'exit=0(passed) passed=lint failed=-');
    expect(call(precheck, fakes.d1, [...common('d1'), '--item', 'd1']).code).toBe(0);
    fakes.d1.state.otherOpen = [{ number: 7777, title: `fix: something (#${ISSUE})`, headRefName: 'fix/elsewhere' }];
    const result = call(publish, fakes.d1, [...common('d1'), '--item', 'd1']);
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/#7777 \(fix\/elsewhere\) is already open for #3883/);
  });

  it('rejects an --item that cannot be part of a file name, in every script', () => {
    const { fakes } = twoWorktrees();
    for (const fn of [precheck, publish, merge]) {
      expect(fn([...common('d1'), '--item', '../x'], { run: fakes.d1.run, error: silent, log: silent } as Parameters<typeof precheck>[1])).toBe(2);
    }
  });
});
