/**
 * /orchestrate 道具の改善（Issue #4162）: 2026-11-05 の run で分かった項目 2〜6。
 *   2. 落ちたジョブの再実行は run の完走を待つ
 *   3. git push の 5xx を再試行し、応答が消えたらリモートの SHA を確かめる
 *   4. uat-fix-loop の merge-pr の exit の説明を実装に揃える
 *   5. env-clean の項目の名前を欠かさず記録する（裁定は変えない）
 *   6. 文面を変える契約に対の integration の探し方を書く（テスト全体へ広げない）
 *
 * 実リポジトリのファイルは書き換えない。`git` / `gh` は ./pr-fake.ts、記録は os.tmpdir() の下。
 *
 * @vitest-environment node
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main as mergeMain, runsStillGoing } from '../../../../scripts/orchestrate/merge-pr.mjs';
import { isTransientPushFailure, pushHead, setUpstream } from '../../../../scripts/orchestrate/pr-common.mjs';
import { main as publishMain } from '../../../../scripts/orchestrate/publish-pr.mjs';
import { appendRecord, envCleanItemsNote, envCleanShared, formatEnvCleanShared, readRecords } from '../../../../scripts/orchestrate/run-log.mjs';
import { envCleanItems } from '../../../../scripts/orchestrate/wait-verify.mjs';
import { passedGates } from '../../../../scripts/orchestrate/precheck.mjs';
import { HEAD_A, type Check, DEVELOP, fakeGit, openPr } from './pr-fake';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const RUN_A = 'https://github.com/Kewton/CommandMate/actions/runs/555/job/1';
const RUN_B = 'https://github.com/Kewton/CommandMate/actions/runs/777/job/1';
const check = (name: string, bucket: string, link = RUN_A): Check => ({ name, bucket, link });
const GREEN = [check('Lint', 'pass'), check('Build', 'pass'), check('Unit Tests', 'pass')];

let tmp: string;
let runDir: string;
let worktree: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-orchestrate-4162-'));
  runDir = path.join(tmp, 'runs', '2026-11-05');
  worktree = path.join(tmp, 'wt');
  fs.mkdirSync(path.join(worktree, 'dev-reports', 'module-reference'), { recursive: true });
  fs.writeFileSync(path.join(worktree, 'dev-reports', 'module-reference', 'issue-3477.md'), '追記なし\n');
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const argv = (...extra: string[]) => ['--run-dir', runDir, '--issues', '3477', '--issue', '3477', '--worktree', worktree, ...extra];

function ready() {
  for (const stage of ['verify', 'review', 'findings', 'precheck']) {
    appendRecord(runDir, '3477', {
      issue: 3477,
      stage,
      result: 'ok',
      head: HEAD_A,
      note: stage === 'verify' ? 'exit=0(passed) passed=lint,typecheck failed=-' : 'tsc=ok tests=ok',
    });
  }
}

type Fake = ReturnType<typeof fakeGit>;

/** merge-pr with `onSleep` playing GitHub between looks. */
function merge(fake: Fake, extra: string[] = [], onSleep: (look: number) => void = () => {}) {
  const out: string[] = [];
  const err: string[] = [];
  let clock = Date.UTC(2026, 10, 5, 3, 0);
  let looks = 0;
  const code = mergeMain(argv(...extra), {
    run: fake.run,
    sleep: (ms: number) => {
      clock += ms;
      onSleep(++looks);
    },
    now: () => new Date(clock),
    findTestsNaming: () => [],
    log: (line: string) => out.push(line),
    error: (line: string) => err.push(line),
  });
  return { code, out: out.join('\n'), err: err.join('\n'), elapsed: clock - Date.UTC(2026, 10, 5, 3, 0) };
}
const ciNotes = () => readRecords(runDir, '3477').records.filter((r) => r.stage === 'ci').map((r) => r.note ?? '');

describe('item 2: 落ちたジョブの再実行は run の完走を待つ', () => {
  const going = [check('Integration Tests', 'fail'), check('Unit Tests', 'pending'), check('Lint', 'pass')];
  const finished = [check('Integration Tests', 'fail'), check('Unit Tests', 'pass'), check('Lint', 'pass')];
  const rerunning = [check('Integration Tests', 'pending'), check('Unit Tests', 'pass'), check('Lint', 'pass')];
  const allGreen = [check('Integration Tests', 'pass'), ...GREEN.slice(0, 2), check('Unit Tests', 'pass')];

  it('names only the failed runs that still have a pending check', () => {
    expect(runsStillGoing(going, ['555'])).toEqual(['555']);
    expect(runsStillGoing(finished, ['555'])).toEqual([]);
    expect(runsStillGoing([check('A', 'fail'), check('B', 'pending', RUN_B)], ['555'])).toEqual([]);
    expect(runsStillGoing([check('A', 'fail'), check('B', 'pending', RUN_B)], ['555', '777'])).toEqual(['777']);
  });

  it('sends nothing while the run is going, then re-runs once and merges', () => {
    ready();
    const fake = fakeGit({ prs: [openPr()], checks: [going, going, finished, rerunning, allGreen] });
    let rerunsWhileGoing = -1;
    const { code, out } = merge(fake, ['--poll', '30'], (look) => {
      if (look === 1) rerunsWhileGoing = fake.ghCalls('run rerun').length;
    });
    expect(code).toBe(0);
    expect(rerunsWhileGoing).toBe(0);
    expect(fake.ghCalls('run rerun')).toHaveLength(1);
    expect(out).toContain('waiting for run 555 to finish');
    expect(ciNotes().filter((note) => / rerun=555/.test(note))).toHaveLength(1);
    expect(fake.ghCalls('pr merge')).toHaveLength(1);
  });

  it('the wait is under --ci-timeout: 124, nothing sent, and it says which run', () => {
    ready();
    const fake = fakeGit({ prs: [openPr()], checks: [going] });
    const { code, err, elapsed } = merge(fake, ['--ci-timeout', '120', '--poll', '30']);
    expect(code).toBe(124);
    expect(err).toContain('CI did not settle within 120s (waiting for run 555 to finish before re-running it)');
    expect(elapsed).toBe(120_000);
    expect(fake.ghCalls('run rerun')).toHaveLength(0);
    expect(ciNotes()).toEqual([]);
  });

  it('stops with exit 4 when the base moves during the wait', () => {
    ready();
    const fake = fakeGit({ prs: [openPr()], checks: [going] });
    const { code } = merge(fake, [], () => {
      fake.state.behind = true;
    });
    expect(code).toBe(4);
    expect(fake.ghCalls('run rerun')).toHaveLength(0);
  });

  it('stops with exit 1 when the PR head moves during the wait, and does not take it for a re-run', () => {
    ready();
    const fake = fakeGit({ prs: [openPr()], checks: [going] });
    const { code, err } = merge(fake, [], () => {
      fake.state.prs[0].headRefOid = 'e'.repeat(40);
    });
    expect(code).toBe(1);
    expect(err).toContain('the PR head moved to eeeeeee');
    expect(fake.ghCalls('run rerun')).toHaveLength(0);
    expect(ciNotes()).toEqual(['pr=#4242 head-moved eeeeeee']);
    expect(ciNotes().some((note) => /(^| )rerun=/.test(note))).toBe(false);
  });

  it('a refusal the checks did not show (already running) goes back to waiting, and does not count as the re-run', () => {
    ready();
    const refusal = "run 555 cannot be rerun; This workflow is already running";
    const fake = fakeGit({ prs: [openPr()], checks: [finished, finished, rerunning, allGreen], rerunFailures: [refusal] });
    const { code } = merge(fake, ['--poll', '30']);
    expect(code).toBe(0);
    expect(fake.ghCalls('run rerun')).toHaveLength(2);
    expect(ciNotes().filter((note) => / rerun=555/.test(note))).toHaveLength(1);
  });

  it('a refusal for any other reason still stops (negative control)', () => {
    ready();
    const fake = fakeGit({ prs: [openPr()], checks: [finished], rerunFailures: ['HTTP 403: Resource not accessible'] });
    const { code, err } = merge(fake);
    expect(code).toBe(1);
    expect(err).toContain('gh run rerun 555 failed: HTTP 403');
  });

  it('once per HEAD: a failure after the re-run stops, also in a later process', () => {
    ready();
    const first = fakeGit({ prs: [openPr()], checks: [going, finished, finished] });
    expect(merge(first).code).toBe(1);
    expect(first.ghCalls('run rerun')).toHaveLength(1);
    const second = fakeGit({ prs: [openPr()], checks: [going, finished] });
    expect(merge(second).code).toBe(1);
    expect(second.ghCalls('run rerun')).toHaveLength(0);
  });

  it('negative control: a run already finished is re-run at the first look, with no wait', () => {
    ready();
    const fake = fakeGit({ prs: [openPr()], checks: [finished, rerunning, allGreen] });
    const { code, out } = merge(fake);
    expect(code).toBe(0);
    expect(fake.ghCalls('run rerun')).toHaveLength(1);
    expect(out).not.toContain('waiting for run');
  });
});

describe('item 3: git push の 5xx', () => {
  const HTTP_500 = "remote: Internal Server Error\nfatal: unable to access 'https://github.com/x/y.git/': The requested URL returned error: 500";

  it('tells a server failure from an answer', () => {
    const failed = (stderr: string) => ({ status: 1, stdout: '', stderr });
    expect(isTransientPushFailure(failed(HTTP_500))).toBe(true);
    expect(isTransientPushFailure(failed('error: RPC failed; HTTP 502 curl 22'))).toBe(true);
    expect(isTransientPushFailure(failed('fatal: the remote end hung up unexpectedly'))).toBe(true);
    expect(isTransientPushFailure(failed('! [rejected] HEAD -> b (non-fast-forward)'))).toBe(false);
    expect(isTransientPushFailure(failed('! [remote rejected] HEAD -> b (hook says HTTP 500)'))).toBe(false);
    expect(isTransientPushFailure(failed('fatal: Authentication failed'))).toBe(false);
    expect(isTransientPushFailure({ status: 0, stdout: '', stderr: HTTP_500 })).toBe(false);
  });

  const push = (fake: Fake) => {
    const sleeps: number[] = [];
    const notices: string[] = [];
    const out = pushHead(fake.run, '/w', {
      branch: 'b',
      head: HEAD_A,
      sleep: (ms: number) => sleeps.push(ms),
      notice: (line: string) => notices.push(line),
    });
    return { out, sleeps, notices };
  };

  it('tries again after a 500 with the remote elsewhere', () => {
    const fake = fakeGit({ pushFailures: [HTTP_500] });
    const { out, sleeps, notices } = push(fake);
    expect(out.status).toBe(0);
    expect(fake.gitCalls('push')).toHaveLength(2);
    expect(sleeps).toEqual([10_000]);
    expect(notices[0]).toContain('retrying in 10s (attempt 2/4)');
  });

  it('when the answer was lost and the remote is at this HEAD: a success, not sent again', () => {
    const fake = fakeGit({ pushFailures: [HTTP_500], remoteHead: HEAD_A });
    const { out, notices } = push(fake);
    expect(out).toMatchObject({ status: 0, confirmed: true });
    expect(fake.gitCalls('push')).toHaveLength(1);
    expect(fake.gitCalls('ls-remote')[0].args.slice(2)).toEqual(['ls-remote', 'origin', 'refs/heads/b']);
    expect(notices[0]).toContain('not sent again; origin/b is at aaaaaaa');
  });

  it('gives up after four tries with the last failure', () => {
    const fake = fakeGit({ pushFailures: [HTTP_500, HTTP_500, HTTP_500, HTTP_500, HTTP_500], remoteHead: DEVELOP });
    const { out, sleeps } = push(fake);
    expect(out.status).toBe(1);
    expect(fake.gitCalls('push')).toHaveLength(4);
    expect(sleeps).toEqual([10_000, 30_000, 60_000]);
  });

  it('negative control: a rejection is sent once, and the remote is not read', () => {
    const fake = fakeGit({ pushFails: true });
    const { out, sleeps } = push(fake);
    expect(out.status).toBe(1);
    expect(fake.gitCalls('push')).toHaveLength(1);
    expect(fake.gitCalls('ls-remote')).toHaveLength(0);
    expect(sleeps).toEqual([]);
  });

  it('merge-pr goes through it', () => {
    ready();
    const fake = fakeGit({ prs: [openPr({ headRefOid: 'e'.repeat(40) })], checks: [GREEN], pushFailures: [HTTP_500] });
    expect(merge(fake).code).toBe(0);
    expect(fake.gitCalls('push')).toHaveLength(2);
    expect(fake.ghCalls('pr merge')).toHaveLength(1);
  });

  it('publish-pr goes through it, and stays stopped on a rejection', () => {
    ready();
    const deps = (fake: Fake) => ({ run: fake.run, sleep: () => {}, log: () => {}, error: () => {} });
    const fake = fakeGit({ pushFailures: [HTTP_500] });
    expect(publishMain(argv(), deps(fake))).toBe(0);
    expect(fake.gitCalls('push')).toHaveLength(2);
    const rejected = fakeGit({ pushFails: true });
    expect(publishMain(argv(), deps(rejected))).toBe(1);
    expect(rejected.gitCalls('push')).toHaveLength(1);
  });
});

/** #4133 の実際の出力（workspace/orchestration/runs/2026-11-04/merge-4133.out の `git push failed: ` の後）をそのまま。 */
const PUSH_500_4133 = [
  'remote: Internal Server Error        ',
  'remote: Request ID F1BC:1BD11D:752008:A98681:6AEAFF92        ',
  'remote: Time 2026-11-04T09:49:07Z',
  'To https://github.com/Kewton/CommandMate.git',
  ' ! [remote rejected]     HEAD -> feature/4133-roles-cli-ui-fixes (Internal Server Error)',
  "error: failed to push some refs to 'https://github.com/Kewton/CommandMate.git'",
].join('\n');

describe('item 3: 実測の push の 500（#4133 の [remote rejected] ... (Internal Server Error)）', () => {
  const failed = (stderr: string) => ({ status: 1, stdout: '', stderr });
  const line = (reason: string) => ` ! [remote rejected]     ${HEAD_A} -> b (${reason})`;
  const quiet = { sleep: () => {}, notice: () => {} };

  it('the output of #4133 is worth trying again', () => {
    expect(isTransientPushFailure(failed(PUSH_500_4133))).toBe(true);
  });

  it('so is the same line with a SHA as the source, which is how pushHead sends now', () => {
    expect(isTransientPushFailure(failed(line('Internal Server Error')))).toBe(true);
  });

  it.each([
    ['a hook', 'pre-receive hook declined'],
    ['a protected branch', 'protected branch hook declined'],
    ['a hook quoting a status', 'hook says HTTP 500'],
    ['a hook quoting the words', 'hook says Internal Server Error'],
    ['a reason that goes on', 'Internal Server Error: quota'],
  ])('negative control: another reason, %s, is the answer', (_name, reason) => {
    expect(isTransientPushFailure(failed(line(reason)))).toBe(false);
  });

  it('negative control: the words from a hook do not outvote what the server decided', () => {
    const hook = ['remote: Internal Server Error', 'remote: HTTP 500', line('pre-receive hook declined')].join('\n');
    expect(isTransientPushFailure(failed(hook))).toBe(false);
    const quoted = ['remote:  ! [remote rejected] x -> y (Internal Server Error)', line('pre-receive hook declined')].join('\n');
    expect(isTransientPushFailure(failed(quoted))).toBe(false);
    expect(isTransientPushFailure(failed('remote:  ! [remote rejected] x -> y (Internal Server Error)'))).toBe(false);
  });

  it('negative control: [rejected] is not sent again, whatever is said beside it', () => {
    expect(isTransientPushFailure(failed(' ! [rejected]        HEAD -> b (non-fast-forward)'))).toBe(false);
    expect(isTransientPushFailure(failed(' ! [rejected]        HEAD -> b (Internal Server Error)'))).toBe(false);
    expect(isTransientPushFailure(failed(`remote: Internal Server Error\n ! [rejected]        HEAD -> b (fetch first)`))).toBe(false);
  });

  it('pushHead tries again on it, and goes through', () => {
    const fake = fakeGit({ pushFailures: [PUSH_500_4133], remoteHead: DEVELOP });
    const out = pushHead(fake.run, '/w', { branch: 'b', head: HEAD_A, ...quiet });
    expect(out.status).toBe(0);
    expect(fake.gitCalls('push')).toHaveLength(2);
  });

  it('the answer was lost and the push landed: the remote is read, a success, not sent again', () => {
    const fake = fakeGit({ pushFailures: [PUSH_500_4133], remoteHead: HEAD_A });
    const out = pushHead(fake.run, '/w', { branch: 'b', head: HEAD_A, ...quiet });
    expect(out).toMatchObject({ status: 0, confirmed: true });
    expect(fake.gitCalls('push')).toHaveLength(1);
    expect(fake.gitCalls('ls-remote')).toHaveLength(1);
  });

  it('merge-pr and publish-pr get through it', () => {
    ready();
    const merged = fakeGit({ prs: [openPr({ headRefOid: 'e'.repeat(40) })], checks: [GREEN], pushFailures: [PUSH_500_4133], remoteHead: DEVELOP });
    expect(merge(merged).code).toBe(0);
    expect(merged.gitCalls('push')).toHaveLength(2);
    const published = fakeGit({ pushFailures: [PUSH_500_4133], remoteHead: DEVELOP });
    expect(publishMain(argv(), { run: published.run, sleep: () => {}, log: () => {}, error: () => {} })).toBe(0);
    expect(published.gitCalls('push')).toHaveLength(2);
  });

  it('out of tries: exit 1 from both, four sends, with the server\'s words', () => {
    ready();
    const five = [PUSH_500_4133, PUSH_500_4133, PUSH_500_4133, PUSH_500_4133, PUSH_500_4133];
    const merged = fakeGit({ prs: [openPr({ headRefOid: 'e'.repeat(40) })], checks: [GREEN], pushFailures: [...five], remoteHead: DEVELOP });
    const { code, err } = merge(merged);
    expect(code).toBe(1);
    expect(err).toContain('git push failed');
    expect(err).toContain('(Internal Server Error)');
    expect(merged.gitCalls('push')).toHaveLength(4);
    expect(merged.ghCalls('pr merge')).toHaveLength(0);
    const published = fakeGit({ pushFailures: [...five], remoteHead: DEVELOP });
    expect(publishMain(argv(), { run: published.run, sleep: () => {}, log: () => {}, error: () => {} })).toBe(1);
    expect(published.gitCalls('push')).toHaveLength(4);
    expect(published.ghCalls('pr create')).toHaveLength(0);
  });

  it('negative control: a declined push is sent once, and the remote is not read', () => {
    const fake = fakeGit({ pushFailures: [line('pre-receive hook declined')], remoteHead: HEAD_A });
    const out = pushHead(fake.run, '/w', { branch: 'b', head: HEAD_A, ...quiet });
    expect(out.status).toBe(1);
    expect(fake.gitCalls('push')).toHaveLength(1);
    expect(fake.gitCalls('ls-remote')).toHaveLength(0);
  });
});

describe('item 3: 送るのは確かめた SHA（レビューの指摘 P2）', () => {
  const HTTP_500 = "fatal: unable to access 'https://github.com/x/y.git/': The requested URL returned error: 500";
  const MOVED = 'b'.repeat(40);
  const REFSPEC = `${HEAD_A}:refs/heads/feature/3477-worktree`;

  it('every try names the SHA, also after HEAD moved during the wait; nothing local is read', () => {
    const fake = fakeGit({ pushFailures: [HTTP_500], remoteHead: DEVELOP });
    const out = pushHead(fake.run, '/w', {
      branch: 'b',
      head: HEAD_A,
      sleep: () => {
        fake.state.head = MOVED;
      },
      notice: () => {},
    });
    expect(out.status).toBe(0);
    expect(fake.gitCalls('push').map((c) => c.args.slice(3))).toEqual([['origin', `${HEAD_A}:refs/heads/b`], ['origin', `${HEAD_A}:refs/heads/b`]]);
    expect(fake.gitCalls('rev-parse')).toEqual([]);
  });

  it('merge-pr: HEAD moved during the wait, and what goes out and is merged is the SHA it checked', () => {
    ready();
    const fake = fakeGit({ prs: [openPr({ headRefOid: 'e'.repeat(40) })], checks: [GREEN], pushFailures: [HTTP_500], remoteHead: DEVELOP });
    const { code } = merge(fake, [], () => {
      fake.state.head = MOVED;
    });
    expect(code).toBe(0);
    expect(fake.gitCalls('push').map((c) => c.args[c.args.length - 1])).toEqual([REFSPEC, REFSPEC]);
    expect(fake.ghCalls('pr merge')[0].args).toContain(HEAD_A);
    expect(fake.ghCalls('pr merge')[0].args).not.toContain(MOVED);
  });

  it('publish-pr: HEAD moved during the wait, and the SHA recorded is the SHA sent', () => {
    ready();
    const fake = fakeGit({ pushFailures: [HTTP_500], remoteHead: DEVELOP });
    const code = publishMain(argv(), {
      run: fake.run,
      sleep: () => {
        fake.state.head = MOVED;
      },
      log: () => {},
      error: () => {},
    });
    expect(code).toBe(0);
    expect(fake.gitCalls('push').map((c) => c.args[c.args.length - 1])).toEqual([REFSPEC, REFSPEC]);
    expect(readRecords(runDir, '3477').records.filter((r) => r.stage === 'pr').map((r) => r.head)).toEqual([HEAD_A]);
    expect(fake.state.prs[0].headRefOid).toBe(HEAD_A);
  });

  it('publish-pr sets the upstream after the push; merge-pr and a failed push do not', () => {
    ready();
    const deps = (fake: Fake) => ({ run: fake.run, sleep: () => {}, log: () => {}, error: () => {} });
    const published = fakeGit({});
    expect(publishMain(argv(), deps(published))).toBe(0);
    expect(published.gitCalls('config').map((c) => c.args.slice(3))).toEqual([
      ['branch.feature/3477-worktree.remote', 'origin'],
      ['branch.feature/3477-worktree.merge', 'refs/heads/feature/3477-worktree'],
    ]);
    const rejected = fakeGit({ pushFails: true });
    expect(publishMain(argv(), deps(rejected))).toBe(1);
    expect(rejected.gitCalls('config')).toEqual([]);
    const merged = fakeGit({ prs: [openPr({ headRefOid: 'e'.repeat(40) })], checks: [GREEN] });
    expect(merge(merged).code).toBe(0);
    expect(merged.gitCalls('config')).toEqual([]);
  });

  it('an upstream that cannot be set is said, and the published PR stands', () => {
    ready();
    const fake = fakeGit({ configFails: true });
    const err: string[] = [];
    expect(publishMain(argv(), { run: fake.run, sleep: () => {}, log: () => {}, error: (line: string) => err.push(line) })).toBe(0);
    expect(err.join('\n')).toContain('the push stands');
    expect(fake.ghCalls('pr create')).toHaveLength(1);
  });

  describe('with a real git and a bare remote under os.tmpdir()', () => {
    const BRANCH = 'feature/x';
    /** A private HOME and an empty global config: the user's commit.gpgsign and core.hooksPath stay out. */
    const spawnGit = (args: string[], cwd?: string) =>
      spawnSync('git', args, {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, HOME: path.join(tmp, 'home'), GIT_CONFIG_GLOBAL: path.join(tmp, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' },
      });
    const gitIn = (cwd: string, ...args: string[]) => {
      const out = spawnGit(['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], cwd);
      if (out.status !== 0) throw new Error(`git ${args.join(' ')}: ${out.stderr}`);
      return out.stdout.trim();
    };
    const realRun = (_command: string, args: string[]) => {
      const out = spawnGit(args);
      return { status: out.status ?? 1, stdout: out.stdout, stderr: out.stderr };
    };
    const setup = () => {
      const remote = path.join(tmp, 'remote.git');
      const local = path.join(tmp, 'local');
      fs.mkdirSync(path.join(tmp, 'home'));
      fs.writeFileSync(path.join(tmp, 'gitconfig'), '');
      fs.mkdirSync(local);
      gitIn(tmp, 'init', '-q', '--bare', remote);
      gitIn(local, 'init', '-q');
      gitIn(local, 'checkout', '-q', '-b', BRANCH);
      gitIn(local, 'remote', 'add', 'origin', remote);
      gitIn(local, 'commit', '-q', '--allow-empty', '-m', 'verified');
      return { remote, local, head: gitIn(local, 'rev-parse', 'HEAD') };
    };
    const refAt = (remote: string, ref: string) => spawnGit(['rev-parse', '--verify', '-q', `refs/heads/${ref}`], remote).stdout.trim();
    const quiet = { sleep: () => {}, notice: () => {} };

    it('the ref moves between the check and the push: B is not sent, and A alone lands', () => {
      const { remote, local, head: a } = setup();
      let b = '';
      const moveThenRun = (command: string, args: string[]) => {
        if (args[2] === 'push') {
          gitIn(local, 'commit', '-q', '--allow-empty', '-m', 'made just before the push');
          b = gitIn(local, 'rev-parse', 'HEAD');
        }
        return realRun(command, args);
      };
      expect(pushHead(moveThenRun, local, { branch: BRANCH, head: a, ...quiet }).status).toBe(0);
      expect(b).not.toBe(a);
      expect(gitIn(local, 'rev-parse', BRANCH)).toBe(b);
      expect(refAt(remote, BRANCH)).toBe(a);
      expect(spawnGit(['cat-file', '-e', b], remote).status).not.toBe(0);
      // The order is a real one: a push by name at this point does send B.
      gitIn(local, 'push', '-q', 'origin', `HEAD:refs/heads/by-name`);
      expect(refAt(remote, 'by-name')).toBe(b);
    });

    it('a commit made during the wait of a retry does not reach the remote either', () => {
      const { remote, local, head: a } = setup();
      let failed = false;
      const flaky = (command: string, args: string[]) => {
        if (args[2] === 'push' && !failed) {
          failed = true;
          return { status: 128, stdout: '', stderr: HTTP_500 };
        }
        return realRun(command, args);
      };
      const out = pushHead(flaky, local, {
        branch: BRANCH,
        head: a,
        sleep: () => gitIn(local, 'commit', '-q', '--allow-empty', '-m', 'made during the wait'),
        notice: () => {},
      });
      expect(out.status).toBe(0);
      expect(refAt(remote, BRANCH)).toBe(a);
      expect(gitIn(local, 'rev-parse', 'HEAD')).not.toBe(a);
    });

    it('negative control: nothing moved, the SHA lands and the upstream reads as with -u', () => {
      const { remote, local, head: a } = setup();
      expect(pushHead(realRun, local, { branch: BRANCH, head: a, ...quiet }).status).toBe(0);
      expect(refAt(remote, BRANCH)).toBe(a);
      setUpstream(realRun, local, BRANCH, () => {
        throw new Error('no notice expected');
      });
      expect(gitIn(local, 'rev-parse', '--abbrev-ref', '@{upstream}')).toBe(`origin/${BRANCH}`);
    });

    it('the output of #4133 after the push really landed: ls-remote finds it, sent once', () => {
      const { remote, local, head: a } = setup();
      let pushes = 0;
      const landedThenLost = (command: string, args: string[]) => {
        if (args[2] !== 'push') return realRun(command, args);
        pushes += 1;
        expect(realRun(command, args).status).toBe(0);
        return { status: 1, stdout: '', stderr: PUSH_500_4133 };
      };
      expect(pushHead(landedThenLost, local, { branch: BRANCH, head: a, ...quiet })).toMatchObject({ status: 0, confirmed: true });
      expect(pushes).toBe(1);
      expect(refAt(remote, BRANCH)).toBe(a);
    });

    it('negative control: a real hook printing the words is declined once, in the output git really gives', () => {
      const { remote, local, head: a } = setup();
      const hook = path.join(remote, 'hooks', 'pre-receive');
      fs.writeFileSync(hook, '#!/bin/sh\necho "Internal Server Error"\nexit 1\n');
      fs.chmodSync(hook, 0o755);
      let pushes = 0;
      const counted = (command: string, args: string[]) => {
        if (args[2] === 'push') pushes += 1;
        return realRun(command, args);
      };
      const out = pushHead(counted, local, { branch: BRANCH, head: a, ...quiet });
      expect(out.status).not.toBe(0);
      expect(out.stderr).toContain('remote: Internal Server Error');
      expect(out.stderr).toContain('(pre-receive hook declined)');
      expect(pushes).toBe(1);
      expect(refAt(remote, BRANCH)).toBe('');
    });

    it('negative control: a non-fast-forward is still refused, not forced', () => {
      const { remote, local, head: a } = setup();
      gitIn(local, 'commit', '-q', '--allow-empty', '-m', 'newer');
      const b = gitIn(local, 'rev-parse', 'HEAD');
      expect(pushHead(realRun, local, { branch: BRANCH, head: b, ...quiet }).status).toBe(0);
      expect(pushHead(realRun, local, { branch: BRANCH, head: a, ...quiet }).status).not.toBe(0);
      expect(refAt(remote, BRANCH)).toBe(b);
    });
  });
});

describe('item 4: merge-pr の exit の説明', () => {
  const exitLine = (file: string) => {
    const body = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
    const at = body.indexOf('scripts/orchestrate/merge-pr.mjs --run-dir');
    return body.slice(at).split('\n').find((line) => line.startsWith('echo "exit=$?"')) ?? '';
  };

  it.each(['.claude/commands/uat-fix-loop.md', '.claude/commands/orchestrate.md'])('%s names every exit, and 124 includes the registration', (file) => {
    const line = exitLine(file);
    for (const code of ['0 →', '1 →', '2 →', '3 →', '4 →', '124 →']) expect(line).toContain(code);
    expect(line).toContain('--register-timeout');
    expect(line).toContain('--ci-timeout');
  });
});

describe('item 5: env-clean の項目の名前', () => {
  const report = (...changes: string[]) =>
    ['env-clean: baseline=x status=violated task-session=none', '  home-entries VIOLATED ($HOME entries): +2 -0', ...changes].join('\n');
  const view = (logTail: string) => ({ gates: [{ gateId: 'env-clean', status: 'failed', logTail }] });
  const verify = (issue: number, note: string) => ({ issue, stage: 'verify', result: 'fail', note });

  it('keeps a name with a space whole, so two entries stay two', () => {
    const tail = report('    + My Tests [unattributed]', '    + My Photos [unattributed]');
    expect(envCleanItems('', view(tail))).toEqual(['home-entries:+My Tests', 'home-entries:+My Photos']);
  });

  it('takes the key without the detail for listeners, whose detail follows it', () => {
    const tail = ['  listeners VIOLATED (CommandMate TCP listeners): +1 -0', '    + tcp/3000 node pid=12 [unattributed]'].join('\n');
    expect(envCleanItems('', view(tail))).toEqual(['listeners:+tcp/3000']);
  });

  it('still drops [self] and the excused task session (negative control)', () => {
    const tail = report('    + My Tests [self]', '    + mcbd-x [task session, excused]', '    · My Photos (ignored: options.envCleanIgnoreHomeEntries)');
    expect(envCleanItems('', view(tail))).toEqual([]);
  });

  it.each(['My Tests', 'a,b', '100%', 'x=ok', 'a%2Cb', 'タブ\tあり', '日本語'])('round-trips %j through the note', (name) => {
    const item = `home-entries:+${name}`;
    const note = `exit=20(failed) ${envCleanItemsNote([item, 'home-entries:+other'])}`;
    expect(note.split(/\s+/)).toHaveLength(2);
    const shared = envCleanShared([verify(1, note), verify(2, note)]);
    expect(shared.map((entry: { item: string }) => entry.item)).toEqual([item, 'home-entries:+other']);
    expect(formatEnvCleanShared(shared[0])).toContain(item);
  });

  it('does not take two names for one, or one with a comma for two', () => {
    const a = `x ${envCleanItemsNote(['home-entries:+My Tests'])}`;
    const b = `x ${envCleanItemsNote(['home-entries:+My Photos'])}`;
    expect(envCleanShared([verify(1, a), verify(2, b)])).toEqual([]);
    const comma = `x ${envCleanItemsNote(['home-entries:+a,b'])}`;
    expect(envCleanShared([verify(1, comma), verify(2, comma)])).toHaveLength(1);
  });

  it('reads a note from before the encoding as it was written', () => {
    const old = 'exit=20(failed) env-clean-items=home-entries:+.s185h,home-entries:+100%';
    expect(envCleanShared([verify(1, old), verify(2, old)]).map((entry: { item: string }) => entry.item)).toEqual(['home-entries:+.s185h', 'home-entries:+100%']);
  });

  it('a name cannot change what the note says was judged', () => {
    const note = `exit=20(failed) passed=lint failed=- ${envCleanItemsNote(['home-entries:+x passed=unit'])}`;
    expect(passedGates({ result: 'fail', note })).toEqual(passedGates({ result: 'fail', note: 'exit=20(failed) passed=lint failed=-' }));
    expect(note).not.toMatch(/\spassed=unit/);
  });
});

describe('item 6: 文面を変える契約と対の integration', () => {
  it('the goal template tells the worker how to look, without running the whole suite', () => {
    const goal = fs.readFileSync(path.join(REPO_ROOT, 'scripts/orchestrate/templates/goal.md'), 'utf8');
    expect(goal).toContain("git grep -l '<変える前の文面>' -- tests/integration tests/e2e");
    expect(goal).not.toContain('npm run test:integration');
  });

  it('contract.md names the file-by-file command and why the gate is not widened', () => {
    const doc = fs.readFileSync(path.join(REPO_ROOT, 'docs/orchestrate/contract.md'), 'utf8');
    const section = doc.slice(doc.indexOf('## 2-4 文面を変える契約と integration'));
    expect(section).toContain('NODE_ENV=test npx vitest run <ファイル>');
    expect(section).toContain('広げない');
  });
});
