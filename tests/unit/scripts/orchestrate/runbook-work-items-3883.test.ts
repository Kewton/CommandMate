/**
 * The runbook's own shell blocks, run (Issue #3883, review-3883-d1-2 N1–N3).
 *
 * N1: the helpers read and write per work item, but a runbook call without
 * `--item` reads the Issue's own records instead. The blocks of
 * docs/orchestrate/run-log.md "1-5 work item の run の呼び出し" are run here
 * against a tasks.tsv with old 5-column rows and 6-column work item rows, with
 * a fake `node` that records each script call, and every call is fed to the
 * script's own parser (the send record goes through the real run-log CLI).
 *
 * N2 / N3: the manual completion check of docs/orchestrate/antigravity.md took
 * any `head=<sha>`, and its second half read the primary `antigravity` and
 * `../commandmate-issue-<N>`. Its blocks are run against a real git repository
 * and a fake `commandmatedev`, and the signal half is compared with the
 * helper's hasCompletionSignal.
 *
 * N4 (review-3883-d1-3): a run started before #3883 already has a 6th column
 * — a retry label (`3883-d1`, `3883-d1-r2`) — and run records without `item`.
 * Reading that column as the work item made a resumed publish look for
 * another unit's records ("verify: no result"). Only `item=<name>` is a work
 * item; the old run's shape resumes, through the real precheck and publish,
 * without `--item`.
 *
 * N5 (review-3883-d1-4): with rows item=d1 → item=d2 → item=d1 (a retry),
 * 6-2 compared the item name with the Issue's last row and closed the Issue
 * on the first d1 too — before d2 was merged, and again on a resume where d1
 * was already merged. 6-2 now merges each (Issue, work item) once, on its
 * latest row, and closes only on the Issue's last one.
 *
 * N6 (review-3883-d1-5): N5 folded every row without item into one target
 * per Issue, so an old run's second PR of an Issue (#3880: A1 → A2 → an A1
 * retry, each PR its own worktree) was dropped as a retry, and the target
 * left closed the Issue by merge-pr's default. Rows without item are now one
 * target per (Issue, worktree); every target but the Issue's last gets
 * `--close -`.
 *
 * Everything is under os.tmpdir(); bash always, zsh too when it is installed
 * (the orchestrator's shell on macOS).
 *
 * @vitest-environment node
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hasCompletionSignal, parseArgs as parseWaitVerifyArgs } from '../../../../scripts/orchestrate/wait-verify.mjs';
import { parseArgs as parseReviewArgs } from '../../../../scripts/orchestrate/consistency-review.mjs';
import { main as precheck, parseArgs as parsePrecheckArgs } from '../../../../scripts/orchestrate/precheck.mjs';
import { main as publish, parseArgs as parsePublishArgs } from '../../../../scripts/orchestrate/publish-pr.mjs';
import { main as merge, parseArgs as parseMergeArgs } from '../../../../scripts/orchestrate/merge-pr.mjs';
import { DEVELOP, fakeGit, openPr } from './pr-fake';
import { main as runLog, readRecords, summarize } from '../../../../scripts/orchestrate/run-log.mjs';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const read = (file: string) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');

/** The body of the `## <heading>` (or `### <heading>`) section, up to the next heading of that level or higher. */
function section(markdown: string, heading: string): string {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => /^#{2,3} /.test(line) && line.replace(/^#+ /, '').startsWith(heading));
  expect(start, `no heading ${heading}`).toBeGreaterThanOrEqual(0);
  const level = /^#+/.exec(lines[start])![0].length;
  const rest = lines.slice(start + 1);
  // A `# …` line inside a fenced block is a shell comment, not a heading.
  let inFence = false;
  const end = rest.findIndex((line) => {
    if (/^\s*```/.test(line)) inFence = !inFence;
    return !inFence && new RegExp(`^#{1,${level}} `).test(line);
  });
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

/** The ```bash blocks of a section, indented ones included, with their indentation removed. */
function bashBlocks(body: string): string[] {
  return [...body.matchAll(/^( *)```bash\n([\s\S]*?)^\1```/gm)].map((m) =>
    m[2]
      .split('\n')
      .map((line) => (line.startsWith(m[1]) ? line.slice(m[1].length) : line))
      .join('\n')
  );
}

const SHELLS = ['bash', ...(spawnSync('zsh', ['-fc', 'true']).status === 0 ? ['zsh'] : [])];

let tmp: string;
let bin: string;
let fake: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-orchestrate-runbook-'));
  bin = path.join(tmp, 'bin');
  fake = path.join(tmp, 'fake');
  fs.mkdirSync(bin);
  fs.mkdirSync(fake);
  // `node <script> …` is recorded (one JSON array per call); `node -e` runs for real.
  fs.writeFileSync(
    path.join(bin, 'node'),
    `#!/bin/sh
if [ "$1" = "-e" ]; then exec "$REAL_NODE" "$@"; fi
"$REAL_NODE" -e 'require("fs").appendFileSync(process.env.CALLS, JSON.stringify(process.argv.slice(1)) + "\\n")' -- "$@"
`,
    { mode: 0o755 }
  );
  // The CLI answers from files under $FAKE; `reply` with no file is a reply that cannot be read.
  fs.writeFileSync(
    path.join(bin, 'commandmatedev'),
    `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE/calls"
inst=; pane=; prev=
for a in "$@"; do
  [ "$prev" = --instance ] && inst=$a
  [ "$a" = --pane ] && pane=1
  prev=$a
done
case "$1" in
  ls) cat "$FAKE/ls.json" ;;
  task) cat "$FAKE/task.json" ;;
  reply) [ -f "$FAKE/reply-$inst.json" ] || exit 1; cat "$FAKE/reply-$inst.json" ;;
  capture) if [ -n "$pane" ]; then cat "$FAKE/pane-$inst.txt"; else cat "$FAKE/capture-$inst.json"; fi ;;
  verify) cat "$FAKE/verify-$3.json" ;;
  *) exit 2 ;;
esac
`,
    { mode: 0o755 }
  );
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function sh(shell: string, script: string, env: Record<string, string>) {
  const args = shell === 'zsh' ? ['-f', '-c', script] : ['--noprofile', '--norc', '-c', script];
  const result = spawnSync(shell, args, {
    cwd: tmp,
    encoding: 'utf8',
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: tmp,
      REAL_NODE: process.execPath,
      CALLS: path.join(tmp, 'calls.jsonl'),
      FAKE: fake,
      GIT_CONFIG_NOSYSTEM: '1',
      ...env,
    } as unknown as NodeJS.ProcessEnv,
  });
  return result;
}

const calls = (): string[][] => {
  const file = path.join(tmp, 'calls.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
};

const T0 = Date.UTC(2026, 9, 24, 3, 0, 0);
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

/** A git repository whose commits carry the given committer times. Returns the repo and a commit helper. */
function repo(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  const git = (args: string[], env: Record<string, string> = {}) => {
    const r = spawnSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        HOME: tmp,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@example.invalid',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@example.invalid',
        ...env,
      } as unknown as NodeJS.ProcessEnv,
    });
    expect(r.status, r.stderr).toBe(0);
    return r.stdout.trim();
  };
  git(['init', '-q']);
  const commit = (minutes: number) => {
    git(['commit', '-q', '--allow-empty', '-m', `at ${minutes}`], { GIT_COMMITTER_DATE: at(minutes), GIT_AUTHOR_DATE: at(minutes) });
    return git(['rev-parse', 'HEAD']);
  };
  return { git, commit };
}

// Each test spawns a shell, git and node a few dozen times: seconds, more on a loaded machine.
describe('the work item blocks of the runbook pass the same --item to every stage (#3883 N1)', { timeout: 30_000 }, () => {
  const doc = section(read('docs/orchestrate/run-log.md'), '1-5 work item の run の呼び出し');
  const blocks = bashBlocks(doc);
  const DATE = '2026-10-24';
  const RUN_ISSUES = '3700-3883';
  const rows = [
    // An old tasks.tsv row (no item column): the Issue is the work item, no --item.
    { issue: '3700', wt: 'wt-a', agent: 'claude', task: 'task-a', model: 'opus', item: '' },
    { issue: '3883', wt: 'wt-d1', agent: 'antigravity-2', task: 'task-d1', model: '-', item: 'd1' },
    { issue: '3883', wt: 'wt-d2', agent: 'claude', task: 'task-d2', model: 'sonnet', item: 'd2' },
  ];

  function setUp() {
    const ls: { id: string; path: string }[] = [];
    for (const row of rows) {
      const dir = path.join(tmp, 'worktrees', row.wt);
      repo(dir).commit(1);
      ls.push({ id: row.wt, path: dir });
    }
    fs.writeFileSync(path.join(fake, 'ls.json'), JSON.stringify(ls));
    const runDir = path.join(tmp, 'workspace', 'orchestration', 'runs', DATE);
    fs.mkdirSync(runDir, { recursive: true });
    return { runDir, dirOf: (wt: string) => ls.find((w) => w.id === wt)!.path };
  }

  const env = { DATE, RUN_ISSUES };

  it('has the 3-1, 3-3, 5-2b, 5-3/6-1-1/6-1 and 6-2 blocks', () => {
    expect(blocks).toHaveLength(5);
    expect(blocks[0]).toContain('printf');
    expect(blocks[1]).toContain('scripts/orchestrate/wait-verify.mjs');
    expect(blocks[2]).toContain('scripts/orchestrate/consistency-review.mjs');
    expect(blocks[3]).toContain('scripts/orchestrate/publish-pr.mjs');
    expect(blocks[4]).toContain('scripts/orchestrate/merge-pr.mjs');
    for (const block of blocks) expect(block).not.toContain('${ITEM:+--item');
  });

  for (const shell of SHELLS) {
    it(`${shell}: send writes the 6th column and records each work item; the old 5-column row stays the Issue's`, () => {
      const { runDir, dirOf } = setUp();
      for (const row of rows) {
        const r = sh(shell, blocks[0], {
          ...env,
          issue: row.issue,
          WT: row.wt,
          AGENT: row.agent,
          TASK_ID: row.task,
          MODEL: row.model,
          ITEM: row.item,
          SENT: 'ok',
          CONTRACT: `.commandmate/tasks/issue-${row.issue}${row.item ? `-${row.item}` : ''}.yaml`,
          WT_DIR: dirOf(row.wt),
        });
        expect(r.stderr).toBe('');
        expect(r.status).toBe(0);
      }
      expect(fs.readFileSync(path.join(runDir, 'tasks.tsv'), 'utf8').split('\n').filter(Boolean)).toEqual(
        rows.map((row) => [row.issue, row.wt, row.agent, row.task, row.model, `item=${row.item}`].join('\t'))
      );
      // The recorded send calls go through the real run-log CLI, into a run record under os.tmpdir().
      for (const argv of calls()) {
        expect(argv[0]).toBe('scripts/orchestrate/run-log.mjs');
        const args = argv.slice(1).map((a) => (a === `workspace/orchestration/runs/${DATE}` ? runDir : a));
        expect(runLog(args)).toBe(0);
      }
      const records = readRecords(runDir, RUN_ISSUES).records;
      expect(records.map((r) => [r.issue, r.item ?? null, r.stage])).toEqual([
        [3700, null, 'send'],
        [3883, 'd1', 'send'],
        [3883, 'd2', 'send'],
      ]);
      expect(summarize(records).map((s) => [s.issue, s.item ?? null, s.next])).toEqual([
        [3700, null, 'verify'],
        [3883, 'd1', 'verify'],
        [3883, 'd2', 'verify'],
      ]);
    });

    it(`${shell}: wait, review, findings, precheck, publish and merge get the row's --item, and none for the old row`, () => {
      const { runDir, dirOf } = setUp();
      fs.writeFileSync(
        path.join(runDir, 'tasks.tsv'),
        // The old row has five columns, exactly as 3-1 of the runbook writes it.
        rows.map((row) => [row.issue, row.wt, row.agent, row.task, row.model, ...(row.item ? [`item=${row.item}`] : [])].join('\t') + '\n').join('')
      );
      for (const block of blocks.slice(1)) {
        const r = sh(shell, block, env);
        expect(r.stderr).toBe('');
        expect(r.status).toBe(0);
      }
      const brief = path.join(tmp, 'brief.txt');
      fs.writeFileSync(brief, 'brief\n');
      const parsers: Record<string, (argv: string[]) => { error?: string; options?: Record<string, unknown> }> = {
        'scripts/orchestrate/wait-verify.mjs': parseWaitVerifyArgs,
        'scripts/orchestrate/consistency-review.mjs': (argv) =>
          parseReviewArgs(argv.map((a, i) => (argv[i - 1] === '--brief' ? brief : a))),
        // run-log's append is checked through its CLI in the send test; here only its --item is read.
        'scripts/orchestrate/run-log.mjs': (argv) => ({ options: { item: argv.includes('--item') ? argv[argv.indexOf('--item') + 1] : undefined } }),
        'scripts/orchestrate/precheck.mjs': parsePrecheckArgs,
        'scripts/orchestrate/publish-pr.mjs': parsePublishArgs,
        'scripts/orchestrate/merge-pr.mjs': parseMergeArgs,
      };
      const seen = calls().map((argv) => {
        const parsed = parsers[argv[0]](argv.slice(1));
        expect(parsed.error, `${argv.join(' ')}`).toBeUndefined();
        const value = (flag: string) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
        return { script: path.basename(argv[0], '.mjs'), issue: value('--issue'), item: (parsed.options?.item as string | undefined) ?? null, argv };
      });
      expect(seen.map((c) => `${c.script} #${c.issue}/${c.item ?? '-'}`)).toEqual([
        'wait-verify #3700/-',
        'wait-verify #3883/d1',
        'wait-verify #3883/d2',
        'consistency-review #3700/-',
        'consistency-review #3883/d1',
        'consistency-review #3883/d2',
        'run-log #3700/-',
        'precheck #3700/-',
        'publish-pr #3700/-',
        'run-log #3883/d1',
        'precheck #3883/d1',
        'publish-pr #3883/d1',
        'run-log #3883/d2',
        'precheck #3883/d2',
        'publish-pr #3883/d2',
        'merge-pr #3700/-',
        'merge-pr #3883/d1',
        'merge-pr #3883/d2',
      ]);
      // The old row has no --item at all, and its model is the 5th column as it was.
      for (const c of seen.filter((s) => s.issue === '3700')) expect(c.argv).not.toContain('--item');
      const wait = (item: string | null) => seen.find((c) => c.script === 'wait-verify' && c.item === item)!.argv;
      expect(wait(null)[wait(null).indexOf('--model') + 1]).toBe('opus');
      expect(wait('d1')[wait('d1').indexOf('--model') + 1]).toBe('-');
      expect(wait('d1')[wait('d1').indexOf('--instance') + 1]).toBe('antigravity-2');
      // The review looks at the work item's own worktree.
      for (const c of seen.filter((s) => s.script === 'consistency-review')) {
        const wt = rows.find((row) => row.issue === c.issue && (row.item || null) === c.item)!.wt;
        expect(c.argv[c.argv.indexOf('--worktree') + 1]).toBe(dirOf(wt));
      }
      // Only the Issue's last work item closes it; the old row keeps merge-pr's default.
      const close = (item: string | null) => {
        const argv = seen.find((c) => c.script === 'merge-pr' && c.item === item)!.argv;
        return argv.includes('--close') ? argv[argv.indexOf('--close') + 1] : undefined;
      };
      expect([close(null), close('d1'), close('d2')]).toEqual([undefined, undefined, '3883']);
      expect(parseMergeArgs(seen.find((c) => c.script === 'merge-pr' && c.item === 'd1')!.argv.slice(1)).options?.close).toBe('-');
    });
  }

  it('the runbook names the rule, points at these blocks and reads the work item fragment copy', () => {
    const body = read('.claude/commands/orchestrate.md');
    expect(body).toContain('**同じ Issue の PR が 2 本以上ある run は、3-1 の送信から 6-2 のマージまで全段に同じ `--item` を渡す**');
    expect(body.split('docs/orchestrate/run-log.md#1-5-work-item-の-run-の呼び出し').length - 1).toBeGreaterThanOrEqual(3);
    expect(body).toContain('cat "workspace/orchestration/runs/$DATE/module-reference-<N>-<item>.md"');
  });

  it('negative control: the runbook’s 5-column 3-3 block with the old tasks.tsv still calls without --item', () => {
    const entry = read('.claude/commands/orchestrate.md');
    const block = bashBlocks(section(entry, '3-3.')).find((b) => b.includes('scripts/orchestrate/wait-verify.mjs'))!;
    const { runDir } = setUp();
    fs.writeFileSync(path.join(runDir, 'tasks.tsv'), '3700\twt-a\tclaude\ttask-a\topus\n');
    const r = sh('bash', block, env);
    expect(r.status).toBe(0);
    const [argv] = calls();
    expect(argv).not.toContain('--item');
    expect(argv[argv.indexOf('--model') + 1]).toBe('opus');
    expect(parseWaitVerifyArgs(argv.slice(1)).error).toBeUndefined();
  });

  it('why the work item rows need the 6-column block: the 5-column read joins the item onto the model', () => {
    const entry = read('.claude/commands/orchestrate.md');
    const block = bashBlocks(section(entry, '3-3.')).find((b) => b.includes('scripts/orchestrate/wait-verify.mjs'))!;
    const { runDir } = setUp();
    fs.writeFileSync(path.join(runDir, 'tasks.tsv'), '3883\twt-d1\tclaude\ttask-d1\topus\td1\n');
    expect(sh('bash', block, env).status).toBe(0);
    const [argv] = calls();
    expect(argv[argv.indexOf('--model') + 1]).toBe('opus\td1');
  });
});

// The shape of runs/2026-10-24: tasks.tsv rows with a retry label in the 6th column, run records without item.
describe('an old run whose 6th column is a retry label resumes without --item (#3883 N4)', { timeout: 30_000 }, () => {
  const blocks = bashBlocks(section(read('docs/orchestrate/run-log.md'), '1-5 work item の run の呼び出し'));
  const DATE = '2026-10-24';
  const RUN_ISSUES = '3880-3884';
  const env = { DATE, RUN_ISSUES };
  const rows = [
    ['3882', 'commandmate-issue-3882', 'claude', 'task-3882', 'sonnet', '3882'],
    ['3883', 'commandmate-issue-3883-d1', 'claude', 'task-d1', 'opus', '3883-d1'],
    ['3883', 'commandmate-issue-3883-d1', 'claude', 'task-d1-r2', 'opus', '3883-d1-r2'],
    // `item=` with no name, and a label after it, is still no work item.
    ['3884', 'commandmate-issue-3884', 'claude', 'task-3884', 'opus', 'item=', '3884-r2'],
  ];

  function setUp() {
    const ls: { id: string; path: string }[] = [];
    const heads: Record<string, string> = {};
    for (const wt of new Set(rows.map((row) => row[1]))) {
      const dir = path.join(tmp, 'worktrees', wt);
      heads[wt] = repo(dir).commit(1);
      fs.mkdirSync(path.join(dir, 'dev-reports', 'module-reference'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'dev-reports', 'module-reference', 'issue-3883.md'), '旧い run の追記\n');
      ls.push({ id: wt, path: dir });
    }
    fs.writeFileSync(path.join(fake, 'ls.json'), JSON.stringify(ls));
    const runDir = path.join(tmp, 'workspace', 'orchestration', 'runs', DATE);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'tasks.tsv'), rows.map((row) => row.join('\t') + '\n').join(''));
    // The records of the old run: send (label as note), then verify and review of the retry, all without item.
    const head = heads['commandmate-issue-3883-d1'];
    const append = (stage: string, extra: string[]) =>
      expect(runLog(['append', '--run-dir', runDir, '--issues', RUN_ISSUES, '--issue', '3883', '--stage', stage, '--result', 'ok', ...extra])).toBe(0);
    append('send', ['--head', DEVELOP, '--task', 'task-d1', '--agent', 'claude', '--model', 'opus', '--note', '3883-d1']);
    append('send', ['--head', DEVELOP, '--task', 'task-d1-r2', '--agent', 'claude', '--model', 'opus', '--note', '3883-d1-r2']);
    append('verify', ['--head', head, '--task', 'task-d1-r2', '--note', 'exit=0(passed) result=passed basis=hook_stop passed=lint,typecheck,unit-related failed=-']);
    append('review', ['--head', head]);
    return { runDir, head, dirOf: (wt: string) => ls.find((w) => w.id === wt)!.path };
  }

  for (const shell of SHELLS) {
    it(`${shell}: wait, findings, precheck, publish and merge of every old row get no --item, and the model stays the 5th column`, () => {
      setUp();
      for (const block of [blocks[1], blocks[3], blocks[4]]) {
        const r = sh(shell, block, env);
        expect(r.stderr).toBe('');
        expect(r.status).toBe(0);
      }
      const seen = calls();
      expect(seen.map((argv) => `${path.basename(argv[0], '.mjs')} #${argv[argv.indexOf('--issue') + 1]}`)).toEqual([
        'wait-verify #3882',
        'wait-verify #3883',
        'wait-verify #3883',
        'wait-verify #3884',
        ...['3882', '3883', '3883', '3884'].flatMap((issue) => [`run-log #${issue}`, `precheck #${issue}`, `publish-pr #${issue}`]),
        // 6-2 merges each (Issue, work item) once, on its latest row: the retry row of #3883 is not merged twice.
        'merge-pr #3882',
        'merge-pr #3883',
        'merge-pr #3884',
      ]);
      for (const argv of seen) {
        expect(argv, argv.join(' ')).not.toContain('--item');
        expect(argv).not.toContain('--close');
      }
      const models = seen.filter((argv) => argv[0].endsWith('wait-verify.mjs')).map((argv) => argv[argv.indexOf('--model') + 1]);
      expect(models).toEqual(['sonnet', 'opus', 'opus', 'opus']);
      for (const argv of seen.filter((a) => a[0].endsWith('wait-verify.mjs'))) expect(parseWaitVerifyArgs(argv.slice(1)).error).toBeUndefined();
    });
  }

  it('the resumed calls, replayed through the real run-log, precheck and publish, find the old run’s records; the label as --item does not', () => {
    const { runDir, head } = setUp();
    expect(sh('bash', blocks[3], env).status).toBe(0);
    const mapped = (argv: string[]) => argv.slice(1).map((a) => (a === `workspace/orchestration/runs/${DATE}` ? runDir : a));
    // The first #3883 row: findings, precheck, publish.
    const [findings, precheckArgv, publishArgv] = calls().filter((argv) => argv[argv.indexOf('--issue') + 1] === '3883').slice(0, 3);
    const fakeOf = () =>
      fakeGit({
        head,
        branch: 'feature/3883-d1',
        firstParent: [`${head} ${DEVELOP}`],
        commitFiles: { [head]: ['scripts/orchestrate/wait-verify.mjs', 'changelog.d/3883.md'] },
        changelogStatus: 'A\tchangelog.d/3883.md',
        changed: ['scripts/orchestrate/wait-verify.mjs', 'changelog.d/3883.md'],
      });
    const run = (fn: typeof precheck, argv: string[]) => {
      const err: string[] = [];
      let clock = Date.UTC(2026, 9, 24, 9, 0);
      const code = fn(argv, {
        run: fakeOf().run,
        sleep: (ms: number) => {
          clock += ms;
        },
        now: () => new Date(clock),
        findTestsNaming: () => [],
        log: () => undefined,
        error: (l: string) => err.push(l),
      } as Parameters<typeof precheck>[1]);
      return { code, err: err.join('\n') };
    };
    expect(runLog(mapped(findings))).toBe(0);
    expect(run(precheck, mapped(precheckArgv)).code).toBe(0);

    // Before N4 the label was the work item: the same publish with --item <label> finds no verify of its own.
    const asItem = run(publish, [...mapped(publishArgv), '--item', '3883-d1-r2']);
    expect(asItem.code).toBe(1);
    expect(asItem.err).toMatch(/verify: no result for/);

    const published = run(publish, mapped(publishArgv));
    expect(published.err).toBe('');
    expect(published.code).toBe(0);
    const records = readRecords(runDir, RUN_ISSUES).records;
    expect(records.every((r) => r.item === undefined || r.item === null)).toBe(true);
    expect(summarize(records).map((s) => [s.issue, s.item ?? null, s.reached])).toEqual([[3883, null, 'pr']]);
  });

  it('a row that names its work item with item=<name> still gets it, next to the old rows', () => {
    const { runDir } = setUp();
    fs.appendFileSync(path.join(runDir, 'tasks.tsv'), '3883\tcommandmate-issue-3883-d1\tclaude\ttask-d2\topus\titem=d2\n');
    expect(sh('bash', blocks[1], env).status).toBe(0);
    const items = calls().map((argv) => (argv.includes('--item') ? argv[argv.indexOf('--item') + 1] : null));
    expect(items).toEqual([null, null, null, null, 'd2']);
  });
});

describe('6-2 closes the Issue only on its last work item, whatever rows a retry adds (#3883 N5)', { timeout: 30_000 }, () => {
  const blocks = bashBlocks(section(read('docs/orchestrate/run-log.md'), '1-5 work item の run の呼び出し'));
  const mergeBlock = blocks[4];
  const DATE = '2026-10-24';
  const env = { DATE, RUN_ISSUES: '3700-3883' };

  function setUp(rows: string[][]) {
    const ls = [...new Set(rows.map((row) => row[1]))].map((wt) => ({ id: wt, path: path.join(tmp, 'worktrees', wt) }));
    fs.writeFileSync(path.join(fake, 'ls.json'), JSON.stringify(ls));
    const runDir = path.join(tmp, 'workspace', 'orchestration', 'runs', DATE);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'tasks.tsv'), rows.map((row) => row.join('\t') + '\n').join(''));
    return { runDir, dirOf: (wt: string) => ls.find((w) => w.id === wt)!.path };
  }
  const merges = (dirOf: (wt: string) => string, wts: string[]) => {
    const value = (argv: string[], flag: string) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : '-');
    return calls().map((argv) => {
      expect(parseMergeArgs(argv.slice(1)).error).toBeUndefined();
      const wt = wts.find((w) => dirOf(w) === value(argv, '--worktree')) ?? '?';
      return `#${value(argv, '--issue')}/${value(argv, '--item')} ${wt} close=${value(argv, '--close')}`;
    });
  };

  for (const shell of SHELLS) {
    it(`${shell}: d1, d2, then a d1 retry — d1 once on its retry row, then d2 with --close; the first d1 does not close`, () => {
      const rows = [
        ['3883', 'wt-d1', 'antigravity', 'task-d1', '-', 'item=d1'],
        ['3700', 'wt-a', 'claude', 'task-a', 'opus'],
        ['3883', 'wt-d2', 'claude', 'task-d2', 'opus', 'item=d2'],
        // The retry of d1 (switched to Claude in another worktree: switching.md appends the row, keeping the first).
        ['3883', 'wt-d1-claude', 'claude', 'task-d1-r2', 'opus', 'item=d1', '3883-d1-r2'],
      ];
      const { dirOf } = setUp(rows);
      const r = sh(shell, mergeBlock, env);
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      expect(merges(dirOf, ['wt-d1', 'wt-a', 'wt-d2', 'wt-d1-claude'])).toEqual([
        '#3883/d1 wt-d1-claude close=-',
        '#3700/- wt-a close=-',
        '#3883/d2 wt-d2 close=3883',
      ]);
    });

    it(`${shell}: d1, d2, then a d2 retry — d1, then d2 once on its retry row with --close`, () => {
      const rows = [
        ['3883', 'wt-d1', 'claude', 'task-d1', 'opus', 'item=d1'],
        ['3883', 'wt-d2', 'claude', 'task-d2', 'opus', 'item=d2'],
        ['3883', 'wt-d2-b', 'claude', 'task-d2-r2', 'opus', 'item=d2'],
      ];
      const { dirOf } = setUp(rows);
      expect(sh(shell, mergeBlock, env).status).toBe(0);
      expect(merges(dirOf, ['wt-d1', 'wt-d2', 'wt-d2-b'])).toEqual(['#3883/d1 wt-d1 close=-', '#3883/d2 wt-d2-b close=3883']);
    });
  }

  it('a stop on d1 does not reach d2, so no call closes the Issue', () => {
    const { dirOf } = setUp([
      ['3883', 'wt-d1', 'claude', 'task-d1', 'opus', 'item=d1'],
      ['3883', 'wt-d2', 'claude', 'task-d2', 'opus', 'item=d2'],
      ['3883', 'wt-d1', 'claude', 'task-d1-r2', 'opus', 'item=d1'],
    ]);
    // The fake node fails merge-pr: the loop stops on the first target.
    fs.writeFileSync(path.join(bin, 'node'), `#!/bin/sh\n"$REAL_NODE" -e 'require("fs").appendFileSync(process.env.CALLS, JSON.stringify(process.argv.slice(1)) + "\\n")' -- "$@"\nexit 1\n`, { mode: 0o755 });
    const r = sh('bash', mergeBlock, env);
    expect(r.stdout).toContain('merge exit=1 issue=3883 item=d1');
    expect(merges(dirOf, ['wt-d1', 'wt-d2'])).toEqual(['#3883/d1 wt-d1 close=-']);
  });

  it('a resume where d1 is already merged: the real merge-pr records d1 and leaves the Issue open; the old --close on d1 would close it', () => {
    const { runDir } = setUp([
      ['3883', 'wt-d1', 'claude', 'task-d1', 'opus', 'item=d1'],
      ['3883', 'wt-d2', 'claude', 'task-d2', 'opus', 'item=d2'],
      ['3883', 'wt-d1', 'claude', 'task-d1-r2', 'opus', 'item=d1'],
    ]);
    expect(sh('bash', mergeBlock, env).status).toBe(0);
    const d1 = calls()[0].slice(1).map((a) => (a === `workspace/orchestration/runs/${DATE}` ? runDir : a));
    expect(d1).toContain('d1');
    const replay = (argv: string[]) => {
      const merged = openPr({ number: 9001, state: 'MERGED', headRefName: 'feature/3883-d1', title: 'fix(orchestrate): d1 (#3883)' });
      const fakeOf = fakeGit({ branch: 'feature/3883-d1', prs: [merged] });
      const err: string[] = [];
      const code = merge(argv, { run: fakeOf.run, sleep: () => undefined, now: () => new Date(Date.UTC(2026, 9, 24, 9)), log: () => undefined, error: (l: string) => err.push(l) } as Parameters<typeof merge>[1]);
      return { code, err: err.join('\n'), fakeOf };
    };
    const resumed = replay(d1);
    expect(resumed.err).toBe('');
    expect(resumed.code).toBe(0);
    expect(resumed.fakeOf.state.issueState).toBe('OPEN');
    expect(resumed.fakeOf.ghCalls('issue close')).toEqual([]);
    expect(readRecords(runDir, '3700-3883').records.map((rec) => [rec.item, rec.stage, rec.result])).toEqual([['d1', 'merge', 'ok']]);
    // Before N5 the first d1 row got --close 3883 (its name was the last row's): that call closes the Issue before d2.
    const before = replay([...d1, '--close', '3883']);
    expect(before.code).toBe(0);
    expect(before.fakeOf.state.issueState).toBe('CLOSED');
  });
});

describe('6-2 keeps each old PR of an Issue, one per worktree, and closes on the last only (#3883 N6)', { timeout: 30_000 }, () => {
  const mergeBlock = bashBlocks(section(read('docs/orchestrate/run-log.md'), '1-5 work item の run の呼び出し'))[4];
  const DATE = '2026-10-24';
  const env = { DATE, RUN_ISSUES: '3880-3884' };
  // The rows of runs/2026-10-24/tasks.tsv: retry labels in the 6th column, no item=.
  const OLD_RUN = [
    ['3880', 'commandmate-issue-3880-a1', 'claude', 'task-a1', 'opus', '3880-a1'],
    ['3881', 'commandmate-issue-3881-b1', 'claude', 'task-b1', 'opus', '3881-b1'],
    ['3882', 'commandmate-issue-3882', 'claude', 'task-3882', 'sonnet', '3882'],
    ['3883', 'commandmate-issue-3883-d1', 'claude', 'task-d1', 'opus', '3883-d1'],
    ['3880', 'commandmate-issue-3880-a2', 'claude', 'task-a2', 'opus', '3880-a2'],
    ['3880', 'commandmate-issue-3880-a1', 'claude', 'task-a1-r2', 'opus', '3880-a1-r2'],
    ['3881', 'commandmate-issue-3881-b1', 'claude', 'task-b1-r2', 'opus', '3881-b1-r2'],
    ['3881', 'commandmate-issue-3881-b1', 'claude', 'task-b1-r3', 'opus', '3881-b1-r3'],
    ['3882', 'commandmate-issue-3882', 'claude', 'task-3882-r3', 'opus', '3882-r3'],
    ['3883', 'commandmate-issue-3883-d1', 'claude', 'task-d1-r2', 'opus', '3883-d1-r2'],
  ];

  function setUp(rows: string[][]) {
    const wts = [...new Set(rows.map((row) => row[1]))];
    fs.writeFileSync(path.join(fake, 'ls.json'), JSON.stringify(wts.map((wt) => ({ id: wt, path: path.join(tmp, 'worktrees', wt) }))));
    const runDir = path.join(tmp, 'workspace', 'orchestration', 'runs', DATE);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'tasks.tsv'), rows.map((row) => row.join('\t') + '\n').join(''));
    return { runDir };
  }
  /** `#<issue>/<item|-> <worktree> close=<value>`, and `close=(default)` when merge-pr gets no --close. */
  const merges = () =>
    calls().map((argv) => {
      expect(parseMergeArgs(argv.slice(1)).error).toBeUndefined();
      const value = (flag: string) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
      return `#${value('--issue')}/${value('--item') ?? '-'} ${path.basename(value('--worktree')!)} close=${value('--close') ?? '(default)'}`;
    });

  for (const shell of SHELLS) {
    it(`${shell}: the old run — #3880's A1 (its retry row) with --close -, then A2 with the default close; same-worktree retries and single PRs once, default`, () => {
      setUp(OLD_RUN);
      const r = sh(shell, mergeBlock, env);
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      expect(merges()).toEqual([
        '#3880/- commandmate-issue-3880-a1 close=-',
        '#3881/- commandmate-issue-3881-b1 close=(default)',
        '#3882/- commandmate-issue-3882 close=(default)',
        '#3883/- commandmate-issue-3883-d1 close=(default)',
        '#3880/- commandmate-issue-3880-a2 close=(default)',
      ]);
    });

    it(`${shell}: one Issue with rows with and without item cannot tell its last PR: none of them closes it`, () => {
      setUp([
        ['3880', 'wt-old', 'claude', 'task-old', 'opus', '3880-a1'],
        ['3880', 'wt-d1', 'claude', 'task-d1', 'opus', 'item=d1'],
        ['3880', 'wt-d2', 'claude', 'task-d2', 'opus', 'item=d2'],
      ]);
      expect(sh(shell, mergeBlock, env).status).toBe(0);
      expect(merges()).toEqual(['#3880/- wt-old close=-', '#3880/d1 wt-d1 close=-', '#3880/d2 wt-d2 close=-']);
    });
  }

  it('the explicit work items keep their own close: d1, d2, a d1 retry → d1 (default: open), d2 --close', () => {
    setUp([
      ['3883', 'wt-d1', 'claude', 'task-d1', 'opus', 'item=d1'],
      ['3883', 'wt-d2', 'claude', 'task-d2', 'opus', 'item=d2'],
      ['3883', 'wt-d1', 'claude', 'task-d1-r2', 'opus', 'item=d1'],
    ]);
    expect(sh('bash', mergeBlock, env).status).toBe(0);
    expect(merges()).toEqual(['#3883/d1 wt-d1 close=(default)', '#3883/d2 wt-d2 close=3883']);
    expect(parseMergeArgs(calls()[0].slice(1)).options?.close).toBe('-');
  });

  it('replayed through the real merge-pr with A1 already merged: A1 leaves #3880 open (N5 closed it), A2 closes it', () => {
    const { runDir } = setUp(OLD_RUN);
    expect(sh('bash', mergeBlock, env).status).toBe(0);
    const argvOf = (wt: string) =>
      calls()
        .find((argv) => path.basename(argv[argv.indexOf('--worktree') + 1]) === wt)!
        .slice(1)
        .map((a) => (a === `workspace/orchestration/runs/${DATE}` ? runDir : a));
    const replay = (argv: string[], branch: string, number: number) => {
      const merged = openPr({ number, state: 'MERGED', headRefName: branch, title: `fix: ${branch} (#3880)` });
      const fakeOf = fakeGit({ branch, prs: [merged] });
      const err: string[] = [];
      const code = merge(argv, { run: fakeOf.run, sleep: () => undefined, now: () => new Date(Date.UTC(2026, 9, 24, 9)), log: () => undefined, error: (l: string) => err.push(l) } as Parameters<typeof merge>[1]);
      return { code, err: err.join('\n'), issueState: fakeOf.state.issueState };
    };
    const a1 = argvOf('commandmate-issue-3880-a1');
    expect(replay(a1, 'feature/3880-a1', 9101)).toEqual({ code: 0, err: '', issueState: 'OPEN' });
    // N5's A1 call had no --close: merge-pr's default closed #3880 before A2.
    const withoutKeep = a1.filter((a, i) => !(a === '--close' || a1[i - 1] === '--close'));
    expect(withoutKeep).not.toContain('--close');
    expect(replay(withoutKeep, 'feature/3880-a1', 9101).issueState).toBe('CLOSED');
    expect(replay(argvOf('commandmate-issue-3880-a2'), 'feature/3880-a2', 9102)).toEqual({ code: 0, err: '', issueState: 'CLOSED' });
  });
});

describe('the manual completion check names this task, this instance and this worktree (#3883 N2, N3)', { timeout: 30_000 }, () => {
  const doc = section(read('docs/orchestrate/antigravity.md'), '3-3 完了の合図を手で確かめる');
  const [signalHalf, timingHalf] = bashBlocks(doc);

  /**
   * One worktree: an earlier commit (P, before the task) and the work (A, after it).
   * The task was created at T0; the verification started at T0+10.
   */
  function setUp() {
    const dir = path.join(tmp, 'worktrees', 'agy-d1');
    const { git, commit } = repo(dir);
    const p = commit(-10);
    const a = commit(5);
    fs.writeFileSync(path.join(fake, 'task.json'), JSON.stringify({ task: { id: 'task-1', createdAt: at(0) } }));
    fs.writeFileSync(path.join(fake, 'verify-42.json'), JSON.stringify({ startedAt: at(10) }));
    fs.writeFileSync(path.join(fake, 'pane-antigravity-2.txt'), 'working…\n');
    const waitLog = path.join(tmp, 'wait-3883-d1.log');
    fs.writeFileSync(waitLog, 'Waiting…\nVerifying: wt-agy (run 42)\n');
    // The primary instance stopped long ago; the instance of this task stopped after the verification started.
    fs.writeFileSync(path.join(fake, 'capture-antigravity.json'), JSON.stringify({ lastStopEventAt: T0 - 60 * 60_000 }));
    fs.writeFileSync(path.join(fake, 'capture-antigravity-2.json'), JSON.stringify({ lastStopEventAt: T0 + 20 * 60_000 }));
    const reply = (text: string | null) => fs.writeFileSync(path.join(fake, 'reply-antigravity-2.json'), JSON.stringify({ reply: text }));
    const env = { WT: 'wt-agy', INSTANCE: 'antigravity-2', WT_DIR: dir, TASK_ID: 'task-1', WAIT_LOG: waitLog };
    return { dir, git, commit, p, a, reply, env };
  }

  function check(shell: string, env: Record<string, string>, between = '') {
    const r = sh(shell, `${signalHalf}\n${between}\n${timingHalf}`, env);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const lines = r.stdout.trim().split('\n');
    return { signal: lines.find((l) => l.startsWith('signal:')), verdict: lines.find((l) => l.includes('verdict=')) };
  }

  it('has the two halves, and neither names the primary instance or the Issue worktree', () => {
    expect(signalHalf).toContain('--instance "$INSTANCE"');
    expect(timingHalf).toContain('--instance "$INSTANCE"');
    for (const half of [signalHalf, timingHalf]) {
      expect(half).not.toMatch(/--instance antigravity\b/);
      expect(half).not.toContain('commandmate-issue-');
      expect(half).toContain('git -C "$WT_DIR"');
    }
  });

  for (const shell of SHELLS) {
    it(`${shell}: the reply's signal is decided as hasCompletionSignal decides it, for this HEAD`, () => {
      const { a, p, reply, env } = setUp();
      const replies = [
        'done\nIMPL_COMPLETED',
        `IMPL_COMPLETED head=${a.slice(0, 7)}`,
        `  IMPL_COMPLETED head=${a}  `,
        `IMPL_COMPLETED head=${p.slice(0, 7)}`,
        `IMPL_COMPLETED head=${p}`,
        `IMPL_COMPLETED head=${p.slice(0, 7)}\nIMPL_COMPLETED`,
        `IMPL_COMPLETED head=${p.slice(0, 7)}\nIMPL_COMPLETED head=${a.slice(0, 9)}`,
        '最後に `IMPL_COMPLETED` とだけ出力する。',
        'IMPL_COMPLETED.',
        `IMPL_COMPLETED head=${a.slice(0, 6)}`,
        '\u001b[1mIMPL_COMPLETED\u001b[0m',
        'still working',
        '',
      ];
      for (const text of replies) {
        reply(text);
        const expected = hasCompletionSignal(text, { head: a });
        expect(check(shell, env).signal, JSON.stringify(text)).toBe(expected ? `signal: done head=${a}` : 'signal: not yet');
      }
    });

    it(`${shell}: a reply naming another HEAD is not yet, and so is the verdict (N2)`, () => {
      const { p, reply, env } = setUp();
      reply(`IMPL_COMPLETED head=${p.slice(0, 7)}`);
      expect(check(shell, env)).toEqual({ signal: 'signal: not yet', verdict: 'verdict=not-yet (no signal for this task and HEAD)' });
    });

    it(`${shell}: the matching HEAD, unmoved, is judged with this instance's last stop (N3: before-signal, not the primary's after-signal)`, () => {
      const { a, reply, env } = setUp();
      reply(`IMPL_COMPLETED head=${a.slice(0, 7)}`);
      expect(check(shell, env)).toEqual({ signal: `signal: done head=${a}`, verdict: 'timing=before-signal verdict=adopt' });
      const asked = fs.readFileSync(path.join(fake, 'calls'), 'utf8');
      expect(asked).toMatch(/^capture wt-agy --instance antigravity-2 --json$/m);
      expect(asked).not.toMatch(/--instance antigravity( |$)/m);
    });

    it(`${shell}: the stop times reversed between the primary and this instance reverse the timing with them`, () => {
      const { a, reply, env } = setUp();
      fs.writeFileSync(path.join(fake, 'capture-antigravity.json'), JSON.stringify({ lastStopEventAt: T0 + 20 * 60_000 }));
      fs.writeFileSync(path.join(fake, 'capture-antigravity-2.json'), JSON.stringify({ lastStopEventAt: T0 + 2 * 60_000 }));
      reply(`IMPL_COMPLETED head=${a.slice(0, 7)}`);
      expect(check(shell, env).verdict).toBe('timing=after-signal verdict=adopt');
    });

    it(`${shell}: a before-signal verification with work left in the tree is verified again; the contract file alone is not work`, () => {
      const { dir, git, reply, env } = setUp();
      // As in the repository, .commandmate/ has tracked files, so the contract shows as .commandmate/tasks/<file>.
      fs.mkdirSync(path.join(dir, '.commandmate', 'tasks'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.commandmate', 'verify.yaml'), 'gates: []\n');
      git(['add', '.commandmate/verify.yaml']);
      git(['commit', '-q', '-m', 'verify.yaml'], { GIT_COMMITTER_DATE: at(5), GIT_AUTHOR_DATE: at(5) });
      reply(`IMPL_COMPLETED head=${git(['rev-parse', 'HEAD']).slice(0, 7)}`);
      fs.writeFileSync(path.join(dir, '.commandmate', 'tasks', 'issue-3883-d1.yaml'), 'goal: x\n');
      expect(check(shell, env).verdict).toBe('timing=before-signal verdict=adopt');
      fs.writeFileSync(path.join(dir, 'half-done.ts'), 'x\n');
      expect(check(shell, env).verdict).toBe('timing=before-signal verdict=reverify(dirty-before-signal)');
    });

    it(`${shell}: the HEAD moving after the signal is not the HEAD the signal named — verify again`, () => {
      const { reply, env, dir } = setUp();
      reply('IMPL_COMPLETED');
      // Committed after the signal was read, but dated before the verification started: only the move tells.
      const between = `GIT_COMMITTER_DATE=${at(6)} GIT_AUTHOR_DATE=${at(6)} GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.invalid GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.invalid git -C "${dir}" commit -q --allow-empty -m moved`;
      expect(check(shell, env, between).verdict).toBe('timing=before-signal verdict=reverify(head-moved-since-signal)');
    });

    it(`${shell}: a commit after the verification started is verified again`, () => {
      const { commit, reply, env } = setUp();
      commit(15);
      reply('IMPL_COMPLETED');
      expect(check(shell, env).verdict).toBe('timing=before-signal verdict=reverify(committed-after-start)');
    });

    it(`${shell}: no reply yet — the pane counts only a line naming this HEAD, committed after the task was created`, () => {
      const { a, p, git, reply, env } = setUp();
      reply(null);
      fs.writeFileSync(path.join(fake, 'pane-antigravity-2.txt'), 'IMPL_COMPLETED\n');
      expect(check(shell, env).signal).toBe('signal: not yet');
      fs.writeFileSync(path.join(fake, 'pane-antigravity-2.txt'), `IMPL_COMPLETED head=${p.slice(0, 7)}\n`);
      expect(check(shell, env).signal).toBe('signal: not yet');
      fs.writeFileSync(path.join(fake, 'pane-antigravity-2.txt'), `IMPL_COMPLETED head=${a.slice(0, 7)}\n`);
      expect(check(shell, env).signal).toBe(`signal: done head=${a}`);
      // The same line when this HEAD is the earlier commit, from before the task: not this task's.
      git(['reset', '-q', '--hard', p]);
      fs.writeFileSync(path.join(fake, 'pane-antigravity-2.txt'), `IMPL_COMPLETED head=${p.slice(0, 7)}\n`);
      expect(check(shell, env).signal).toBe('signal: not yet');
    });

    it(`${shell}: an unreadable reply falls to the same pane rule; an empty reply is a reply and does not`, () => {
      const { a, env } = setUp();
      fs.writeFileSync(path.join(fake, 'pane-antigravity-2.txt'), `IMPL_COMPLETED head=${a.slice(0, 7)}\n`);
      // No reply file: `reply` exits 1.
      expect(check(shell, env).signal).toBe(`signal: done head=${a}`);
      fs.writeFileSync(path.join(fake, 'reply-antigravity-2.json'), JSON.stringify({ reply: '' }));
      expect(check(shell, env).signal).toBe('signal: not yet');
    });
  }
});
