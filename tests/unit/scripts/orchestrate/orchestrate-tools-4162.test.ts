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
import { isTransientPushFailure, pushHead } from '../../../../scripts/orchestrate/pr-common.mjs';
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
    const out = pushHead(fake.run, '/w', ['origin', 'HEAD:b'], {
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

describe('item 3: 再試行の待ちの間にローカルが進んだら送らない（レビューの指摘 P2）', () => {
  const HTTP_500 = "fatal: unable to access 'https://github.com/x/y.git/': The requested URL returned error: 500";
  const MOVED = 'b'.repeat(40);

  it('stops before the next try, says why, and sends only the first', () => {
    const fake = fakeGit({ pushFailures: [HTTP_500], remoteHead: DEVELOP });
    const out = pushHead(fake.run, '/w', ['origin', 'HEAD:b'], {
      branch: 'b',
      head: HEAD_A,
      sleep: () => {
        fake.state.head = MOVED;
      },
      notice: () => {},
    });
    expect(out.status).toBe(1);
    expect(out.stderr).toContain('HEAD moved from aaaaaaa to bbbbbbb');
    expect(out.stderr).toContain('not pushed');
    expect(fake.gitCalls('push')).toHaveLength(1);
  });

  it('stops before the first try too: precheck may have run for minutes since head was read', () => {
    const fake = fakeGit({ head: MOVED });
    const out = pushHead(fake.run, '/w', ['origin', 'HEAD:b'], { branch: 'b', head: HEAD_A, sleep: () => {}, notice: () => {} });
    expect(out.status).toBe(1);
    expect(fake.gitCalls('push')).toHaveLength(0);
  });

  it('a source that cannot be read is not pushed', () => {
    const fake = fakeGit({});
    const run = (command: string, args: string[]) =>
      args[2] === 'rev-parse' ? { status: 128, stdout: '', stderr: 'fatal: Needed a single revision' } : fake.run(command, args);
    const out = pushHead(run, '/w', ['origin', 'HEAD:b'], { branch: 'b', head: HEAD_A, sleep: () => {}, notice: () => {} });
    expect(out.status).toBe(1);
    expect(out.stderr).toContain('could not read HEAD');
    expect(fake.gitCalls('push')).toHaveLength(0);
  });

  it('negative control: with HEAD still there the retry goes through, on the same arguments', () => {
    const fake = fakeGit({ pushFailures: [HTTP_500], remoteHead: DEVELOP });
    const out = pushHead(fake.run, '/w', ['origin', 'HEAD:b'], { branch: 'b', head: HEAD_A, sleep: () => {}, notice: () => {} });
    expect(out.status).toBe(0);
    expect(fake.gitCalls('push').map((c) => c.args.slice(3))).toEqual([['origin', 'HEAD:b'], ['origin', 'HEAD:b']]);
  });

  it('merge-pr: exit 1, no merge, no second push', () => {
    ready();
    const fake = fakeGit({ prs: [openPr({ headRefOid: 'e'.repeat(40) })], checks: [GREEN], pushFailures: [HTTP_500], remoteHead: DEVELOP });
    const { code, err } = merge(fake, [], () => {
      fake.state.head = MOVED;
    });
    expect(code).toBe(1);
    expect(err).toContain('HEAD moved from aaaaaaa to bbbbbbb');
    expect(fake.gitCalls('push')).toHaveLength(1);
    expect(fake.ghCalls('pr merge')).toHaveLength(0);
  });

  it('publish-pr: exit 1, no PR, and the old SHA is not recorded as published', () => {
    ready();
    const fake = fakeGit({ pushFailures: [HTTP_500], remoteHead: DEVELOP });
    const err: string[] = [];
    const code = publishMain(argv(), {
      run: fake.run,
      sleep: () => {
        fake.state.head = MOVED;
      },
      log: () => {},
      error: (line: string) => err.push(line),
    });
    expect(code).toBe(1);
    expect(err.join('\n')).toContain('moved from aaaaaaa to bbbbbbb');
    expect(fake.gitCalls('push')).toHaveLength(1);
    expect(fake.ghCalls('pr create')).toHaveLength(0);
    expect(readRecords(runDir, '3477').records.filter((r) => r.stage === 'pr')).toEqual([]);
  });

  it('publish-pr reads the branch it pushes, not HEAD', () => {
    ready();
    const fake = fakeGit({});
    expect(publishMain(argv(), { run: fake.run, sleep: () => {}, log: () => {}, error: () => {} })).toBe(0);
    const reads = fake.gitCalls('rev-parse').map((c) => c.args.slice(3));
    expect(reads).toContainEqual(['--verify', 'refs/heads/feature/3477-worktree']);
  });

  describe('with a real git and a bare remote under os.tmpdir()', () => {
    const BRANCH = 'feature/x';
    const gitIn = (cwd: string, ...args: string[]) => {
      const out = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd, encoding: 'utf8' });
      if (out.status !== 0) throw new Error(`git ${args.join(' ')}: ${out.stderr}`);
      return out.stdout.trim();
    };
    /** Real git, except that the first push answers 500 without reaching the remote. */
    const flaky = () => {
      let failed = false;
      return (command: string, args: string[]) => {
        if (args[2] === 'push' && !failed) {
          failed = true;
          return { status: 128, stdout: '', stderr: HTTP_500 };
        }
        const out = spawnSync(command, args, { encoding: 'utf8' });
        return { status: out.status ?? 1, stdout: out.stdout, stderr: out.stderr };
      };
    };
    const setup = () => {
      const remote = path.join(tmp, 'remote.git');
      const local = path.join(tmp, 'local');
      fs.mkdirSync(local);
      gitIn(tmp, 'init', '-q', '--bare', remote);
      gitIn(local, 'init', '-q');
      gitIn(local, 'checkout', '-q', '-b', BRANCH);
      gitIn(local, 'remote', 'add', 'origin', remote);
      gitIn(local, 'commit', '-q', '--allow-empty', '-m', 'verified');
      return { remote, local, head: gitIn(local, 'rev-parse', 'HEAD') };
    };
    const remoteHead = (remote: string) => spawnSync('git', ['rev-parse', '--verify', '-q', `refs/heads/${BRANCH}`], { cwd: remote, encoding: 'utf8' }).stdout.trim();

    it.each([
      ['merge-pr', ['origin', `HEAD:${BRANCH}`], undefined],
      ['publish-pr', ['-u', 'origin', BRANCH], `refs/heads/${BRANCH}`],
    ])('%s: a commit made during the wait does not reach the remote', (_name, pushArgs, source) => {
      const { remote, local, head } = setup();
      const out = pushHead(flaky(), local, pushArgs as string[], {
        branch: BRANCH,
        head,
        ...(source ? { source } : {}),
        sleep: () => gitIn(local, 'commit', '-q', '--allow-empty', '-m', 'made during the wait'),
        notice: () => {},
      });
      expect(out.status).toBe(1);
      expect(remoteHead(remote)).toBe('');
    });

    it.each([
      ['merge-pr', ['origin', `HEAD:${BRANCH}`], undefined],
      ['publish-pr', ['-u', 'origin', BRANCH], `refs/heads/${BRANCH}`],
    ])('negative control, %s: nothing made during the wait, and the verified SHA lands', (_name, pushArgs, source) => {
      const { remote, local, head } = setup();
      const out = pushHead(flaky(), local, pushArgs as string[], {
        branch: BRANCH,
        head,
        ...(source ? { source } : {}),
        sleep: () => {},
        notice: () => {},
      });
      expect(out.status).toBe(0);
      expect(remoteHead(remote)).toBe(head);
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
