/**
 * /orchestrate 道具の改善（Issue #4148）: 2026-11-04 の run で手で裁定した 4 点と、見送りの理由。
 *   1. 同じ env-clean の項目が複数の検証に出たら外部要因の候補として表示する
 *   2. 全体実行に広がる unit-related を計画の段階で見分ける
 *   3. CLI の応答を変える契約の scope に src/cli/types/** を足す
 *   4. CI 待ちの間に develop が動いたら止める・登録までの時間を --ci-timeout と分ける
 *   5. --last の対象は ci-pr.yml だけでよい理由
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
import { parse, stringify } from 'yaml';
import { cliTypesNote, fullUnitNote, fullUnitPattern, normalizeConfig } from '../../../../scripts/orchestrate/contract.mjs';
import { main as mergeMain, parseArgs, validate } from '../../../../scripts/orchestrate/merge-pr.mjs';
import { checkPlan } from '../../../../scripts/orchestrate/plan-check.mjs';
import { appendRecord, envCleanShared, readRecords } from '../../../../scripts/orchestrate/run-log.mjs';
import { envCleanItems } from '../../../../scripts/orchestrate/wait-verify.mjs';
import { ScopeMatcher } from '../../../../src/lib/verification/scope-gate-glob';
import { HEAD_A, type Check, fakeGit, openPr } from './pr-fake';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const SCRIPTS = path.join(REPO_ROOT, 'scripts/orchestrate');

let tmp: string;
let runDir: string;
let worktree: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-orchestrate-4148-'));
  runDir = path.join(tmp, 'runs', '2026-11-05');
  worktree = path.join(tmp, 'wt');
  fs.mkdirSync(path.join(worktree, 'dev-reports', 'module-reference'), { recursive: true });
  fs.writeFileSync(path.join(worktree, 'dev-reports', 'module-reference', 'issue-3477.md'), '追記なし\n');
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const REPORT = [
  'env-clean: baseline=2026-11-04T04:37:13.185Z status=violated task-session=mcbd-x-claude-wt',
  '  listeners clean (CommandMate TCP listeners)',
  '  tmux-sessions VIOLATED (mcbd-* tmux sessions): +2 -1',
  '    + mcbd-x-claude-wt-2 [self]',
  '    + mcbd-x-claude-wt [task session, excused]',
  '    - mcbd-y-claude-other [unattributed]',
  '  home-entries VIOLATED ($HOME entries): +1 -0',
  '    + .s185h-operator-tests [unattributed]',
  '    · .semgrep (ignored: options.envCleanIgnoreHomeEntries)',
  '  commandmate-entries clean (~/.commandmate entries)',
  'Anything listed under "+" was started or created during this task and left behind.',
].join('\n');
const ITEMS = ['tmux-sessions:-mcbd-y-claude-other', 'home-entries:+.s185h-operator-tests'];

describe('item 1: env-clean の項目の抽出', () => {
  it('reads the stored run, without the worker\'s own and the excused session', () => {
    expect(envCleanItems('', { gates: [{ gateId: 'env-clean', status: 'failed', logTail: REPORT }] })).toEqual(ITEMS);
  });

  it('falls back to the gate\'s part of the log, not to another gate\'s output', () => {
    const log = [`GATE env-clean FAIL (exit=1, 0.2s)`, REPORT, 'GATE unit FAIL (exit=1, 1s)', '  home-entries VIOLATED (x): +1 -0', '    + from-a-test-body [unattributed]', 'RESULT failed'].join('\n');
    expect(envCleanItems(log)).toEqual(ITEMS);
  });

  it('negative control: a passing gate or a clean probe lists nothing', () => {
    expect(envCleanItems('GATE env-clean PASS (exit=0, 0.1s)\nGATE lint PASS (exit=0, 1s)\nRESULT passed\n')).toEqual([]);
    expect(envCleanItems('', { gates: [{ gateId: 'env-clean', status: 'passed', logTail: '  home-entries clean ($HOME entries)' }] })).toEqual([]);
    expect(envCleanItems('', { gates: [{ gateId: 'lint', status: 'passed', logTail: REPORT }] })).toEqual([]);
  });
});

describe('item 1: 複数の検証に出た項目', () => {
  const verify = (issue: number, note: string, item?: string) => ({ issue, stage: 'verify', result: 'fail', note, ...(item ? { item } : {}) });
  const NOTE = 'exit=20(failed) env-clean-items=home-entries:+.s185h-operator-tests';

  it('names an item two Issues saw (positive control)', () => {
    expect(envCleanShared([verify(4132, NOTE), verify(4133, `${NOTE},tmux-sessions:-a`)])).toEqual([
      { item: 'home-entries:+.s185h-operator-tests', workItems: ['#4132', '#4133'] },
    ]);
  });

  it('counts two work items of one Issue as two', () => {
    expect(envCleanShared([verify(4132, NOTE), verify(4132, NOTE, 'b')])[0].workItems).toEqual(['#4132', '#4132/b']);
  });

  it('negative control: retries of one work item, different items, other stages and old notes name nothing', () => {
    expect(envCleanShared([verify(4132, NOTE), verify(4132, NOTE)])).toEqual([]);
    expect(envCleanShared([verify(4132, NOTE), verify(4133, 'exit=20(failed) env-clean-items=home-entries:+other')])).toEqual([]);
    expect(envCleanShared([verify(4132, NOTE), { issue: 4133, stage: 'precheck', result: 'ok', note: NOTE }])).toEqual([]);
    expect(envCleanShared([verify(4132, 'exit=20(failed) passed=lint'), verify(4133, 'env=abc')])).toEqual([]);
  });

  it('run-log.mjs status says it, and --json carries it', () => {
    appendRecord(runDir, '4132-4133', { ...verify(4132, NOTE), head: HEAD_A });
    appendRecord(runDir, '4132-4133', { ...verify(4133, NOTE), head: HEAD_A });
    const status = (...extra: string[]) =>
      spawnSync(process.execPath, [path.join(SCRIPTS, 'run-log.mjs'), 'status', '--run-dir', runDir, '--issues', '4132-4133', ...extra], { encoding: 'utf8' }).stdout;
    expect(status()).toContain('env-clean: home-entries:+.s185h-operator-tests in #4132, #4133 — candidate for an outside cause');
    expect(JSON.parse(status('--json')).envCleanShared).toHaveLength(1);
  });
});

describe('item 2: 全体実行に広がる unit-related', () => {
  it('finds the patterns run-related-unit-tests.mjs would run in full (positive control)', () => {
    for (const pattern of ['scripts/orchestrate/**', 'docs/**', '.claude/commands/orchestrate.md', 'tests/integration/**', 'src/config/slash-commands-catalog.json', 'src/**/*.json', '{src,docs}/**', '**/*.ts']) {
      expect(fullUnitPattern(['src/lib/x/**', pattern])).toBe(pattern);
    }
  });

  it('negative control: code, unit tests and metadata stay related', () => {
    expect(fullUnitPattern(['src/lib/x/**', 'src/app/api/worktrees/[id]/send/**', 'src/hooks/a.ts', 'tests/unit/x.test.ts', 'tests/helpers/**', 'changelog.d/1.md', '{src/a,src/b}/**'])).toBeNull();
  });

  it('notes a contract that runs unit-related, and no other', () => {
    const base = { issue: 1, title: 't', kind: 'feature', agent: 'claude', model: 'opus' };
    expect(fullUnitNote(normalizeConfig({ ...base, scope: ['docs/**'] }))).toContain('under "docs/**"');
    expect(fullUnitNote(normalizeConfig({ ...base, scope: ['src/lib/x/**'] }))).toBeNull();
    expect(fullUnitNote(normalizeConfig({ ...base, scope: ['docs/**'], gates: ['lint', 'typecheck'] }))).toBeNull();
  });

  it('generate says it on stderr and keeps stdout the contract', () => {
    const config = path.join(tmp, 'c.yaml');
    fs.writeFileSync(config, stringify({ issue: 1, title: 't', kind: 'feature', agent: 'claude', model: 'opus', scope: ['docs/**'] }));
    const result = spawnSync(process.execPath, [path.join(SCRIPTS, 'contract.mjs'), 'generate', '--config', config, '--worktree', tmp, '--stdout'], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('contract: note: #1: unit-related runs the whole unit suite');
    expect(parse(result.stdout).version).toBe(1);
  });

  describe('plan-check notice', () => {
    const load = (file: string) => {
      const name = path.basename(file);
      const scope = name.startsWith('full') ? ['docs/**'] : ['src/lib/x/**'];
      return { gates: name.endsWith('gates') ? ['lint', 'typecheck'] : ['lint', 'typecheck', 'unit-related'], scope };
    };
    const plan = (waves: string[][], items: Record<string, unknown>[]) => ({
      version: 1,
      waves: waves.map((members, i) => ({ id: String(i + 1), items: members })),
      items,
    });
    const notices = (p: unknown) => checkPlan(p, { baseDir: tmp, load }).notices;

    it('names two items of a wave that can queue on cpu.heavy (positive control)', () => {
      const p = plan([['a', 'b']], [{ id: 'a', contract: 'full-a' }, { id: 'b', contract: 'full-b' }]);
      expect(notices(p)).toEqual([expect.stringMatching(/^cpu-heavy: wave 1: a \(unit-related, full by docs\/\*\*\), b \(unit-related, full by docs\/\*\*\) can run one at a time/)]);
      expect(checkPlan(p, { baseDir: tmp, load }).violations).toEqual([]);
    });

    it('counts a direct unit gate with a widening item', () => {
      const p = plan([['a', 'u']], [{ id: 'a', contract: 'full-a' }, { id: 'u', gates: ['lint', 'unit'] }]);
      expect(notices(p)[0]).toContain('u (unit)');
    });

    it('negative control: one per wave, related scopes, no test gate and no contract say nothing', () => {
      expect(notices(plan([['a'], ['b']], [{ id: 'a', contract: 'full-a' }, { id: 'b', contract: 'full-b' }]))).toEqual([]);
      expect(notices(plan([['a', 'b']], [{ id: 'a', contract: 'full-a' }, { id: 'b', contract: 'related-b' }]))).toEqual([]);
      expect(notices(plan([['a', 'b']], [{ id: 'a', contract: 'full-a' }, { id: 'b', contract: 'full-gates' }]))).toEqual([]);
      expect(notices(plan([['a', 'b']], [{ id: 'a', contract: 'full-a' }, { id: 'b', gates: ['unit-related'] }]))).toEqual([]);
    });
  });
});

describe('item 3: src/cli/types/** を対で入れる', () => {
  const CLI_TYPES = 'src/cli/types/**';
  const scopeOf = (scope: string[], kind = 'feature') =>
    normalizeConfig({ issue: 1, title: 't', kind, agent: 'claude', model: 'opus', scope, ...(kind === 'refactor' ? { refactor: { mergesCopies: false } } : {}) }).scope;

  it('is added for an API route or CLI code', () => {
    for (const pattern of ['src/app/api/roles/**', 'src/app/api/worktrees/[id]/send/**', 'src/app/api', 'src/app/**', 'src/cli/commands/send.ts', 'src/cli/utils/**', '{src/app/api/a,docs}/**']) {
      expect(scopeOf([pattern])).toContain(CLI_TYPES);
    }
  });

  it('would have held the file #4132 missed', () => {
    expect(scopeOf(['src/app/api/roles/**', 'src/cli/commands/roles.ts', 'src/lib/agent-roles/**'])).toContain(CLI_TYPES);
  });

  it('is allowed in a refactor', () => {
    expect(scopeOf(['src/cli/commands/send.ts'], 'refactor')).toContain(CLI_TYPES);
  });

  it('negative control: other code, lookalikes and a scope that already holds it add nothing', () => {
    for (const pattern of ['src/lib/x/**', 'src/app/worktrees/page.tsx', 'src/app/apis/a.ts', 'src/client/a.ts', 'docs/src/cli/a.md', 'src/**', 'src/cli/**', 'src/cli/', 'src/cli/types/api-responses.ts', '**']) {
      expect(scopeOf([pattern])).not.toContain(CLI_TYPES);
    }
  });

  it('does not duplicate one the config wrote', () => {
    expect(scopeOf(['src/app/api/roles/**', CLI_TYPES]).filter((p: string) => p === CLI_TYPES)).toHaveLength(1);
  });

  describe('a glob, in the meaning the scope gate gives it', () => {
    const admits = (pattern: string, file: string) => !new ScopeMatcher({ allow: [pattern], deny: [] }).isViolation(file);
    const CODE = ['src/app/api/roles/route.ts', 'src/app/api/worktrees/[id]/send/route.ts', 'src/app/api/roles/helpers.ts', 'src/cli/commands/send.ts', 'src/cli/index.ts'];

    it.each([
      ['src/app/**/route.ts', 'src/app/api/roles/route.ts'],
      ['src/**/route.ts', 'src/app/api/roles/route.ts'],
      ['**/route.ts', 'src/app/api/roles/route.ts'],
      ['src/*/api/**', 'src/app/api/roles/route.ts'],
      ['src/app/*/roles/route.ts', 'src/app/api/roles/route.ts'],
      ['src/app/ap?/**', 'src/app/api/roles/route.ts'],
      ['src/app/api/**/route.*', 'src/app/api/roles/route.ts'],
      ['src/app/api/worktrees/[id]/send/route.ts', 'src/app/api/worktrees/[id]/send/route.ts'],
      ['src/{app,lib}/**/route.ts', 'src/app/api/roles/route.ts'],
      ['src/cli/**/*.ts', 'src/cli/commands/send.ts'],
      ['src/*/*.ts', 'src/cli/index.ts'],
      ['src/*/route.ts', 'src/cli/route.ts'],
      ['s*/cli/commands/**', 'src/cli/commands/send.ts'],
      ['**/*.ts', 'src/cli/commands/send.ts'],
      ['**/*.{ts,tsx}', 'src/app/api/roles/route.ts'],
    ])('%s reaches %s, and adds it (positive control)', (pattern, file) => {
      expect(admits(pattern, file)).toBe(true);
      expect(admits(pattern, 'src/cli/types/a-new-copy.json')).toBe(false);
      expect(scopeOf([pattern])).toContain(CLI_TYPES);
    });

    it.each(['src/app/**/page.tsx', 'src/app/*/page.tsx', 'src/*/page.tsx', 'src/lib/**/route.ts', 'src/app/(group)/**', 'src/app/worktrees/**/route.ts', '**/*.md', 'src/**/*.tsx', 'src/cli/types/*.ts', 'src/cli/types/**/*.ts', 'docs/**/route.ts'])(
      '%s reaches no route or CLI code, and adds nothing (negative control)',
      (pattern) => {
        expect(CODE.filter((file) => admits(pattern, file))).toEqual([]);
        expect(scopeOf([pattern])).not.toContain(CLI_TYPES);
      }
    );

    it.each(['src/*/types/**', '**/types/**', 'src/cli/types/*', 'src/cli/*', 'src/**/*', '**/*', 'src/{cli,lib}/**'])('%s holds src/cli/types/ already, and adds nothing', (pattern) => {
      expect(admits(pattern, 'src/cli/types/api-responses.ts')).toBe(true);
      expect(admits(pattern, 'src/cli/types/sub/a.json')).toBe(true);
      expect(scopeOf([pattern])).not.toContain(CLI_TYPES);
    });
  });

  describe('a pattern that cannot be judged', () => {
    const tooWide = `{a,b}${'{c,d}'.repeat(10)}/**`;
    const configOf = (scope: string[]) => normalizeConfig({ issue: 7, title: 't', kind: 'feature', agent: 'claude', model: 'opus', scope });

    it('adds nothing and says so', () => {
      const config = configOf([tooWide]);
      expect(config.scope).not.toContain(CLI_TYPES);
      expect(cliTypesNote(config)).toContain(`#7: scope "${tooWide}" has more than 1024 brace expansions`);
    });

    it('does not stop what the other patterns decide, and then there is nothing to say', () => {
      const config = configOf([tooWide, 'src/app/**/route.ts']);
      expect(config.scope).toContain(CLI_TYPES);
      expect(cliTypesNote(config)).toBeNull();
    });

    it('negative control: every pattern the generator can judge has no note', () => {
      for (const scope of [['src/app/**/route.ts'], ['docs/**'], ['{src,docs}/**'], ['src/{a']]) {
        expect(cliTypesNote(configOf(scope))).toBeNull();
      }
    });

    it('generate prints it on stderr', () => {
      const config = path.join(tmp, 'config.yaml');
      fs.writeFileSync(config, stringify({ issue: 7, title: 't', kind: 'feature', agent: 'claude', model: 'opus', scope: [tooWide] }));
      const out = spawnSync(process.execPath, [path.join(SCRIPTS, 'contract.mjs'), 'generate', '--config', config, '--worktree', worktree, '--stdout'], { encoding: 'utf-8' });
      expect(out.status).toBe(0);
      expect(out.stderr).toContain('src/cli/types/** was not added');
    });
  });
});

describe('item 4: merge-pr の待機', () => {
  const pass = (name: string): Check => ({ name, bucket: 'pass', link: 'https://github.com/Kewton/CommandMate/actions/runs/555/job/1' });
  const pending = (name: string): Check => ({ ...pass(name), bucket: 'pending' });
  const GREEN = [pass('Lint'), pass('Build'), pass('Unit Tests')];
  const argv = (...extra: string[]) => ['--run-dir', runDir, '--issues', '3477', '--issue', '3477', '--worktree', worktree, ...extra];

  function ready() {
    for (const [stage, note] of [['verify', 'exit=0(passed) passed=lint,typecheck failed=-'], ['review', ''], ['findings', ''], ['precheck', 'tsc=ok tests=ok']]) {
      appendRecord(runDir, '3477', { issue: 3477, stage, result: 'ok', head: HEAD_A, note });
    }
  }

  type Run = ReturnType<typeof fakeGit>['run'];
  function runMain(run: Run, ...extra: string[]) {
    const err: string[] = [];
    let clock = Date.UTC(2026, 10, 5, 3, 0);
    const code = mergeMain(argv(...extra), {
      run,
      sleep: (ms: number) => {
        clock += ms;
      },
      now: () => new Date(clock),
      findTestsNaming: () => [],
      log: () => {},
      error: (line: string) => err.push(line),
    });
    return { code, err: err.join('\n'), clock };
  }

  describe('develop moved during the wait', () => {
    it('stops with exit 4 before merging when the base moves after the refresh (positive control)', () => {
      ready();
      const fake = fakeGit({ prs: [openPr()], checks: [[pending('Build')], GREEN] });
      const run: Run = (command, args, opts) => {
        // A PR merged while the first look was out: the next fetch sees the new develop.
        if (command === 'gh' && args[0] === 'pr' && args[1] === 'checks') fake.state.behind = true;
        return fake.run(command, args, opts);
      };
      const { code, err } = runMain(run);
      expect(code).toBe(4);
      expect(err).toContain('moved during the CI wait');
      expect(fake.ghCalls('pr merge')).toHaveLength(0);
      const last = readRecords(runDir, '3477').records.at(-1);
      expect(last).toMatchObject({ stage: 'merge', result: 'fail' });
      expect(last?.note).toContain('base-moved');
    });

    /** develop moves while `gh pr checks` is out: only a fetch after that read can see it. */
    function movesDuringRead(fake: ReturnType<typeof fakeGit>): Run {
      let moved = false;
      return (command, args, opts) => {
        if (command === 'git' && args[2] === 'fetch' && moved) fake.state.behind = true;
        const answer = fake.run(command, args, opts);
        if (command === 'gh' && args[0] === 'pr' && args[1] === 'checks') moved = true;
        return answer;
      };
    }

    it('a green answer does not merge past a base that moved during that very read (positive control)', () => {
      ready();
      const fake = fakeGit({ prs: [openPr()], checks: [GREEN] });
      const { code, err } = runMain(movesDuringRead(fake));
      expect(code).toBe(4);
      expect(err).toContain('moved during the CI wait');
      expect(fake.ghCalls('pr merge')).toHaveLength(0);
      expect(readRecords(runDir, '3477').records.at(-1)?.note).toContain('base-moved');
    });

    it('sends no rerun for a HEAD whose base moved during the read that failed', () => {
      ready();
      const fake = fakeGit({ prs: [openPr()], checks: [[{ ...pass('Build'), bucket: 'fail' }]] });
      expect(runMain(movesDuringRead(fake)).code).toBe(4);
      expect(fake.ghCalls('run rerun')).toHaveLength(0);
    });

    it('a failed fetch after the green answer does not merge on it: the next look reads both again', () => {
      ready();
      const fake = fakeGit({ prs: [openPr()], checks: [GREEN] });
      const order: string[] = [];
      let fetches = 0;
      const run: Run = (command, args, opts) => {
        if (command === 'gh' && args[0] === 'pr' && (args[1] === 'checks' || args[1] === 'merge')) order.push(args[1]);
        if (command === 'git' && args[2] === 'fetch') {
          if (++fetches === 2) {
            order.push('fetch-failed');
            return { status: 1, stdout: '', stderr: 'unreachable' };
          }
          order.push('fetch');
        }
        return fake.run(command, args, opts);
      };
      expect(runMain(run).code).toBe(0);
      // Step 4's fetch, the first look, the second look. The merge follows a fetch that follows a read.
      expect(order).toEqual(['fetch', 'checks', 'fetch-failed', 'checks', 'fetch', 'merge']);
    });

    it('stops on the first look too: the precheck and the push take time', () => {
      ready();
      const fake = fakeGit({ prs: [openPr({ headRefOid: 'e'.repeat(40) })], checks: [GREEN] });
      const run: Run = (command, args, opts) => {
        if (command === 'git' && args[2] === 'push') fake.state.behind = true;
        return fake.run(command, args, opts);
      };
      expect(runMain(run).code).toBe(4);
      expect(fake.ghCalls('pr merge')).toHaveLength(0);
    });

    it('negative control: a base that stayed merges as before', () => {
      ready();
      const fake = fakeGit({ prs: [openPr()], checks: [[pending('Build')], GREEN] });
      expect(runMain(fake.run).code).toBe(0);
      expect(fake.ghCalls('pr merge')).toHaveLength(1);
      expect(fake.gitCalls('fetch').length).toBeGreaterThanOrEqual(2);
    });

    it('a failed fetch never merges on an unread base, and the next look goes on', () => {
      ready();
      const fake = fakeGit({ prs: [openPr()], checks: [GREEN] });
      let fetches = 0;
      const run: Run = (command, args, opts) => {
        // Step 4's fetch is the first; the first look of the wait fails.
        if (command === 'git' && args[2] === 'fetch' && ++fetches === 2) return { status: 1, stdout: '', stderr: 'remote: Internal Server Error' };
        return fake.run(command, args, opts);
      };
      expect(runMain(run).code).toBe(0);
      expect(fetches).toBe(3);
      expect(fake.ghCalls('pr merge')).toHaveLength(1);
    });

    it('a fetch that keeps failing ends in 124, not in a merge', () => {
      ready();
      const fake = fakeGit({ prs: [openPr()], checks: [GREEN] });
      let fetches = 0;
      const run: Run = (command, args, opts) => {
        if (command === 'git' && args[2] === 'fetch' && ++fetches >= 2) return { status: 1, stdout: '', stderr: 'unreachable' };
        return fake.run(command, args, opts);
      };
      const { code, err } = runMain(run, '--ci-timeout', '60');
      expect(code).toBe(124);
      expect(err).toContain('waiting for git fetch origin develop');
      expect(fake.ghCalls('pr merge')).toHaveLength(0);
    });
  });

  describe('--register-timeout', () => {
    /** No checks for `lateLooks` looks, then a green CI: registered after the old single clock ran out. */
    const lateRegistration = (lateLooks: number) => [...Array.from({ length: lateLooks }, () => [] as Check[]), GREEN];

    it('the time before the first check does not use up --ci-timeout (positive control)', () => {
      ready();
      // 5 looks at 30s: 150s without a check, past a --ci-timeout of 120s counted from the start.
      const fake = fakeGit({ prs: [openPr()], checks: lateRegistration(5) });
      expect(runMain(fake.run, '--ci-timeout', '120', '--poll', '30').code).toBe(0);
      expect(fake.ghCalls('pr merge')).toHaveLength(1);
    });

    it('--ci-timeout runs from the first check', () => {
      ready();
      const fake = fakeGit({ prs: [openPr()], checks: [[], [], [pending('Build')]] });
      const { code, err, clock } = runMain(fake.run, '--ci-timeout', '120', '--poll', '30');
      expect(code).toBe(124);
      expect(err).toContain('CI did not settle within 120s (waiting for Build, Unit Tests)');
      // Two looks without a check, then 120s from the first one with a check.
      expect(clock - Date.UTC(2026, 10, 5, 3, 0)).toBe(180_000);
    });

    it('gives up with 124 and says it was the registration', () => {
      ready();
      const fake = fakeGit({ prs: [openPr()], checks: [[]] });
      const { code, err, clock } = runMain(fake.run, '--register-timeout', '120', '--ci-timeout', '7200', '--poll', '30');
      expect(code).toBe(124);
      expect(err).toContain('no CI registered on aaaaaaa within 120s');
      expect(err).not.toContain('did not settle');
      expect(clock - Date.UTC(2026, 10, 5, 3, 0)).toBe(120_000);
      expect(fake.ghCalls('pr merge')).toHaveLength(0);
    });

    it('counts a PR head that has not reached this HEAD as not registered', () => {
      ready();
      const fake = fakeGit({ prs: [openPr({ headRefOid: 'e'.repeat(40) })], pushFails: false, checks: [GREEN] });
      const run: Run = (command, args, opts) => {
        const answer = fake.run(command, args, opts);
        // The push went through, GitHub still shows the old head.
        if (command === 'git' && args[2] === 'push') fake.state.prs[0].headRefOid = 'e'.repeat(40);
        return answer;
      };
      const { code, err } = runMain(run, '--register-timeout', '60');
      expect(code).toBe(124);
      expect(err).toContain('no CI registered on aaaaaaa within 60s (--register-timeout; the PR head is eeeeeee)');
    });

    it('takes seconds only, and defaults to 600', () => {
      const base = ['--run-dir', 'r', '--issues', '1', '--issue', '1', '--worktree', '/w'];
      expect(parseArgs(base).options?.registerTimeout).toBe('600');
      expect(validate(parseArgs([...base, '--register-timeout', '10m']).options)).toMatch(/--register-timeout/);
      expect(validate(parseArgs([...base, '--register-timeout', '30']).options)).toBeNull();
    });
  });
});

describe('item 5: --last の対象が ci-pr.yml だけでよい理由', () => {
  it('no other workflow registers a check on an open PR', () => {
    const dir = path.join(REPO_ROOT, '.github/workflows');
    const openPrEvents = ['pull_request', 'pull_request_target'];
    const others = fs.readdirSync(dir).filter((name) => name.endsWith('.yml') && name !== 'ci-pr.yml');
    expect(others.length).toBeGreaterThan(0);
    for (const name of others) {
      const on: Record<string, { types?: string[] } | null> = parse(fs.readFileSync(path.join(dir, name), 'utf-8')).on;
      for (const event of openPrEvents) {
        if (!(event in on)) continue;
        // Runs only when the PR closes, so there is no open PR to hold back. Anything else: decide about LAST_REQUIRED_CHECKS (ci-merge.md).
        expect(on[event]?.types, `${name} runs on ${event}`).toEqual(['closed']);
      }
    }
  });
});
