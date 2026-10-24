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
import { parseArgs as parsePrecheckArgs } from '../../../../scripts/orchestrate/precheck.mjs';
import { parseArgs as parsePublishArgs } from '../../../../scripts/orchestrate/publish-pr.mjs';
import { parseArgs as parseMergeArgs } from '../../../../scripts/orchestrate/merge-pr.mjs';
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
        rows.map((row) => [row.issue, row.wt, row.agent, row.task, row.model, row.item].join('\t'))
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
        rows.map((row) => [row.issue, row.wt, row.agent, row.task, row.model, ...(row.item ? [row.item] : [])].join('\t') + '\n').join('')
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
