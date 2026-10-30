/**
 * scripts/orchestrate/consistency-review.mjs — Issue #3984.
 *
 * How a review ends (exit code, the run record's `review` result, a row in
 * `consistency-review.md`, the `review-<N>…` files left) is one table,
 * `OUTCOMES`. Its only copy for the orchestrator is the table in
 * docs/orchestrate/trials.md; the script header and orchestrate.md 5-2b point
 * at it instead of restating it (they said "exit 0 = a `DONE:` line", which
 * #3883 / #3936 / #3957 made untrue).
 *
 * (a) builds each condition with a stubbed CLI and compares what the review
 * left with its OUTCOMES row; (b) compares the trials.md table with OUTCOMES
 * cell by cell, and checks the other texts point at it.
 *
 * Everything is under os.tmpdir(); `git` / the CLI are injected.
 *
 * @vitest-environment node
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LOCK_OWNER_FILE,
  OUTCOMES,
  OUTCOMES_TABLE_REF,
  START_FILES,
  main,
} from '../../../../scripts/orchestrate/consistency-review.mjs';
import { readRecords } from '../../../../scripts/orchestrate/run-log.mjs';

const ROOT = path.resolve(__dirname, '../../../..');
const HEAD = 'c0ffee1' + '0'.repeat(33);
const READY = { isRunning: true, sessionStatus: 'ready', sessionStatusReason: 'input_prompt' };
const STOPPED = { isRunning: false, sessionStatus: 'idle', sessionStatusReason: 'session_not_running' };

type Result = { status: number; stdout: string; stderr: string };
type Outcome = { id: string; record: 'ok' | 'fail' | null; row: boolean; exit: number; files: readonly string[] };

/** OUTCOMES as the test reads it (the script is plain JS). */
const ROWS = OUTCOMES as unknown as readonly Outcome[];

const askJson = (reply: unknown, extra: Record<string, unknown> = {}): string =>
  `${JSON.stringify({ worktreeId: 'mycodebranchdesk', instanceId: 'codex', reply, ...extra })}\n`;

let tmp: string;
let runDir: string;
let wt: string;
let lock: string;
let gitHead: string;
let captures: () => unknown;
let sendResult: Result;
let askResult: Result;
let duringAsk: () => void;
let clock: number;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-consistency-3984-'));
  runDir = path.join(tmp, 'runs', '2026-10-31');
  wt = path.join(tmp, 'wt');
  fs.mkdirSync(path.join(wt, 'node_modules'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'elsewhere'));
  lock = path.join(tmp, 'proposals', '.lock');
  fs.writeFileSync(path.join(tmp, 'brief.txt'), '不具合修正です。\n');
  gitHead = HEAD;
  captures = () => READY;
  sendResult = { status: 0, stdout: 'task-1\n', stderr: '' };
  askResult = { status: 0, stdout: askJson('指摘なし\n\nDONE: 指摘なし'), stderr: '' };
  duringAsk = () => {};
  clock = Date.UTC(2026, 9, 31);
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const run = (command: string, args: string[]): Result => {
  if (command === 'git' && args.includes('worktree')) return { status: 1, stdout: '', stderr: 'not a repository' };
  if (command === 'git') return { status: 0, stdout: args.includes('--abbrev-ref') ? 'feature/x\n' : `${gitHead}\n`, stderr: '' };
  if (args[0] === 'capture') return { status: 0, stdout: JSON.stringify(captures()), stderr: '' };
  if (args[0] === 'send') return sendResult;
  if (args[0] === 'ask') {
    duringAsk();
    return askResult;
  }
  throw new Error(`unexpected call: ${command} ${args.join(' ')}`);
};

const ARGS = () => [
  '--run-dir', runDir, '--issues', '3984', '--issue', '3984', '--head', HEAD.slice(0, 7),
  '--brief', path.join(tmp, 'brief.txt'), '--worktree', wt, '--lock', lock, '--cli', 'cmd-fake',
];

/** Run a review and read back what it left. */
function go(argv: string[] = ARGS()) {
  const exit = main(argv, {
    run,
    sleep: (ms: number) => {
      clock += ms;
    },
    now: () => new Date(clock),
    cwd: tmp,
    log: () => {},
    error: () => {},
  });
  const records = readRecords(runDir, '3984').records.filter((r: { stage: string }) => r.stage === 'review');
  const table = path.join(runDir, 'consistency-review.md');
  const rows = fs.existsSync(table) ? [...fs.readFileSync(table, 'utf8').matchAll(/^\|\s*\d+\s*\|/gm)].length : 0;
  const files = fs.existsSync(runDir)
    ? fs
        .readdirSync(runDir)
        .filter((name) => name.startsWith('review-3984'))
        .map((name) => name.slice('review-3984'.length))
        .sort()
    : [];
  return { exit, record: records.length === 0 ? null : records.map((r: { result: string }) => r.result).join(','), rows, files };
}

const row = (id: string): Outcome => {
  const found = ROWS.find((o) => o.id === id);
  expect(found, `no OUTCOMES row ${id}`).toBeDefined();
  return found as Outcome;
};

/** What a review that ended at `id` must have left (`started`: the starting message was sent). */
function expectOutcome(left: ReturnType<typeof go>, id: string, started = false) {
  const o = row(id);
  const files = started ? [...new Set([...o.files, ...START_FILES])] : o.files;
  expect(left).toEqual({ exit: o.exit, record: o.record, rows: o.row ? 1 : 0, files: [...files].sort() });
}

describe('OUTCOMES: each way a review ends leaves what its row says (#3984 (a))', () => {
  it('usage: nothing sent, recorded or kept, exit 2', () => {
    const left = go(ARGS().filter((a, i, all) => a !== '--head' && all[i - 1] !== '--head'));
    expectOutcome(left, 'usage');
    expect(left.exit).toBe(2);
  });

  it('head-mismatch: the worktree is at another HEAD', () => {
    gitHead = 'beef000' + '0'.repeat(33);
    expectOutcome(go(), 'head-mismatch');
  });

  it('exception: the lock held by a live owner is waited out', () => {
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(
      path.join(lock, LOCK_OWNER_FILE),
      JSON.stringify({ pid: process.pid, host: os.hostname(), startedAt: new Date(clock).toISOString() })
    );
    expectOutcome(go(), 'exception');
  });

  it('start-failed: the starting send failed, nothing else sent', () => {
    captures = () => STOPPED;
    sendResult = { status: 99, stdout: '', stderr: 'prompt not ready' };
    expectOutcome(go(), 'start-failed');
  });

  it('not-ready: never ready; after a start the start files are kept too', () => {
    captures = () => ({ isRunning: true, sessionStatus: 'running' });
    expectOutcome(go(), 'not-ready');
    fs.rmSync(runDir, { recursive: true, force: true });
    captures = () => STOPPED;
    expectOutcome(go(), 'not-ready', true);
  });

  it('dependency-links: exit 1, review=fail, no row, the answer only in the .json (no .md)', () => {
    duringAsk = () => fs.symlinkSync(path.join(tmp, 'elsewhere'), path.join(wt, 'node_modules', 'foreign'));
    const left = go();
    expectOutcome(left, 'dependency-links');
    expect(left).toMatchObject({ exit: 1, record: 'fail', rows: 0 });
    expect(left.files).not.toContain('.md');
    expect(left.files).toContain('.json');
  });

  it('upstream-fault: ask exit 11 is exit 1, review=fail, no row, no .md', () => {
    askResult = { status: 11, stdout: askJson(null, { upstreamFault: { id: 'model-capacity' } }), stderr: 'upstream fault' };
    const left = go();
    expectOutcome(left, 'upstream-fault');
    expect(left).toMatchObject({ exit: 1, record: 'fail', rows: 0 });
    expect(left.files).not.toContain('.md');
  });

  it('ask-failed: another non-zero ask exit', () => {
    askResult = { status: 1, stdout: '', stderr: 'boom' };
    expectOutcome(go(), 'ask-failed');
  });

  it('no-reply: ask --json without a reply string', () => {
    askResult = { status: 0, stdout: 'not json', stderr: '' };
    expectOutcome(go(), 'no-reply');
  });

  it('no-done: an answer without a DONE: line', () => {
    askResult = { status: 0, stdout: askJson('途中で終わった'), stderr: '' };
    expectOutcome(go(), 'no-done');
  });

  it('overlapped: a DONE: line, still exit 1, review=fail, no row, the .md kept', () => {
    askResult = { status: 0, stdout: askJson('指摘なし\n\nDONE: 指摘なし', { overlapped: true }), stderr: '' };
    const left = go();
    expectOutcome(left, 'overlapped');
    expect(left).toMatchObject({ exit: 1, record: 'fail', rows: 0 });
    expect(left.files).toContain('.md');
  });

  it('ok (negative control): exit 0, review=ok, one row', () => {
    const left = go();
    expectOutcome(left, 'ok');
    expect(left).toMatchObject({ exit: 0, record: 'ok', rows: 1 });
  });

  it('every row is reached by a test above, and only ok exits 0', () => {
    const ids = ROWS.map((o) => o.id);
    expect(ids).toEqual([
      'usage', 'head-mismatch', 'exception', 'start-failed', 'not-ready', 'dependency-links',
      'upstream-fault', 'ask-failed', 'no-reply', 'no-done', 'overlapped', 'ok',
    ]);
    expect(ROWS.filter((o) => o.exit === 0).map((o) => o.id)).toEqual(['ok']);
    expect(ROWS.filter((o) => o.record === 'ok').map((o) => o.id)).toEqual(['ok']);
  });
});

// ---------------------------------------------------------------------------
// (b) the documents

const HEADING = '### 5-2b 終了コードと記録の条件表';

/** The rows of the first markdown table after `heading`, as trimmed cells. */
function tableAfter(markdown: string, heading: string): string[][] {
  const start = markdown.indexOf(`\n${heading}\n`);
  if (start === -1) return [];
  const lines = markdown.slice(start + heading.length + 2).split('\n');
  const first = lines.findIndex((l) => l.startsWith('|'));
  if (first === -1) return [];
  const end = lines.findIndex((l, i) => i > first && !l.startsWith('|'));
  return lines
    .slice(first, end === -1 ? undefined : end)
    .map((l) => l.replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
}

const cellWord = (cell: string): string => cell.replace(/`/g, '').trim();
const cellFiles = (cell: string): string[] => (cellWord(cell) === 'なし' ? [] : [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]).sort());

/** The trials.md table, compared with OUTCOMES row by row and column by column; the problems found. */
function tableProblems(markdown: string): string[] {
  const table = tableAfter(markdown, HEADING);
  if (table.length < 2) return [`no table under ${HEADING}`];
  const [header, , ...body] = table;
  const expectedHeader = ['条件', 'id', '記録（review）', '表に行', 'exit', '残るファイル'];
  const problems: string[] = [];
  if (header.map(cellWord).join('|') !== expectedHeader.join('|')) problems.push(`header ${header.join('|')}`);
  const outcomes = ROWS;
  if (body.length !== outcomes.length) problems.push(`${body.length} rows, OUTCOMES has ${outcomes.length}`);
  outcomes.forEach((o, i) => {
    const cells = body[i] ?? [];
    const id = cellWord(cells[1] ?? '');
    if (id !== o.id) problems.push(`row ${i + 1}: id ${id}, OUTCOMES ${o.id}`);
    if (cellWord(cells[2] ?? '') !== (o.record ?? 'なし')) problems.push(`${o.id}: 記録 ${cells[2]}`);
    if (cellWord(cells[3] ?? '') !== (o.row ? '1 行' : 'なし')) problems.push(`${o.id}: 表に行 ${cells[3]}`);
    if (cellWord(cells[4] ?? '') !== String(o.exit)) problems.push(`${o.id}: exit ${cells[4]}`);
    if (cellFiles(cells[5] ?? '').join(' ') !== [...o.files].sort().join(' ')) problems.push(`${o.id}: 残るファイル ${cells[5]}`);
  });
  return problems;
}

const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');

describe('the condition table is copied once, in trials.md, and pointed at (#3984 (b))', () => {
  const trials = read('docs/orchestrate/trials.md');

  it('trials.md has the table, matching OUTCOMES cell by cell', () => {
    expect(tableProblems(trials)).toEqual([]);
  });

  it('positive control: one changed cell is caught', () => {
    const changed = trials.replace(/(\| `overlapped` \| fail \| )なし( \|)/, '$11 行$2');
    expect(changed).not.toBe(trials);
    expect(tableProblems(changed)).toEqual(['overlapped: 表に行 1 行']);
    const swapped = trials.replace(/(\| `ok` \| ok \| 1 行 \| )0( \|)/, '$11$2');
    expect(tableProblems(swapped)).toEqual(['ok: exit 1']);
  });

  it('positive control: the text before #3984 (no table, "exit は 0（`DONE:` あり）") fails', () => {
    const before = trials.slice(0, trials.indexOf(`\n${HEADING}\n`)) + '\n  `DONE:` 行があれば下の表に 1 行を足し、run の記録に `review=ok`。exit は 0（`DONE:` あり）\n';
    expect(tableProblems(before)).not.toEqual([]);
  });

  it('the 5-2b procedure no longer says a DONE: line means exit 0, and says to resend an overlapped one by one', () => {
    expect(trials).not.toContain('exit は 0（`DONE:` あり）');
    expect(trials).toContain('同じ `--instance` に重ねず、1 本ずつ送り直す');
  });

  it('the anchor the others use is the heading of the table', () => {
    expect(OUTCOMES_TABLE_REF).toBe('docs/orchestrate/trials.md#5-2b-終了コードと記録の条件表');
  });

  it('orchestrate.md 5-2b points at the table and holds no exit numbers of its own', () => {
    const body = read('.claude/commands/orchestrate.md');
    const start = body.indexOf('### 5-2b.');
    const section = body.slice(start, body.indexOf('\n### ', start + 1));
    const call = section.split('\n').find((l) => l.startsWith('- **呼び出し:**')) ?? '';
    expect(call).toContain(OUTCOMES_TABLE_REF);
    expect(call).toContain('0 は `review=ok` のときだけ');
    expect(call).not.toMatch(/[012]=/);
  });

  it('the script header points at OUTCOMES and the table instead of restating exit codes', () => {
    const script = read('scripts/orchestrate/consistency-review.mjs');
    const header = script.slice(0, script.indexOf('\nimport '));
    expect(header).toContain('OUTCOMES');
    expect(header).toContain(OUTCOMES_TABLE_REF);
    expect(header).not.toMatch(/exit [01]\b/);
    expect(header).not.toContain('0 the answer has a `DONE:` line');
  });
});
