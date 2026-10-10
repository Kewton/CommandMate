/**
 * scripts/orchestrate/consistency-review.mjs — the 5-2b consistency review by Codex (Issue #3528).
 *
 * The hand-written review-<N>.sh cut the reply at the first `> **Thinking`, so a
 * review that quoted `> **Thinking**` lost its findings and its `DONE:` line.
 * Every file here is under os.tmpdir(); `git` / `commandmatedev` are injected
 * (no real Codex, no real CLI).
 *
 * @vitest-environment node
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildPrompt,
  extractReplyBody,
  findDoneLine,
  findingCount,
  main,
  nextReviewLabel,
  parseArgs,
  renderTemplate,
} from '../../../scripts/orchestrate/consistency-review.mjs';
import { readRecords } from '../../../scripts/orchestrate/run-log.mjs';

const FIXTURES = path.resolve(__dirname, '../../fixtures/orchestrate-consistency-review-3528');
const reply = (name: string): string => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8')).reply;
const HEAD = 'c0ffee1' + '0'.repeat(33);

/** The hand-written extraction this script replaces (review-3503.sh). */
const handWrittenBody = (text: string): string => text.split('> **Thinking')[0];

describe('extractReplyBody: the answer ends only at the thinking section', () => {
  it('keeps the findings and the DONE: line when the answer quotes `> **Thinking**`', () => {
    const text = reply('reply-quotes-thinking.json');
    const body = extractReplyBody(text);
    expect(body).toContain('先頭の `> **Thinking**` 内の図');
    expect(body).toContain('> **Thinking** の節を引用した行');
    expect(body).toContain('確信度 **高**');
    expect(findDoneLine(body)).toBe('DONE: 指摘 1 件（この PR で直すべきもの 1 件）');
    expect(body).not.toContain('前回の指摘の経路と照合します');
  });

  it('positive control: the hand-written split loses the DONE: line on the same reply', () => {
    const body = handWrittenBody(reply('reply-quotes-thinking.json'));
    expect(findDoneLine(body)).toBeNull();
    expect(body).not.toContain('確信度 **高**');
  });

  it('negative control: without a quote, the answer is the same as before and the thinking is dropped', () => {
    const text = reply('reply-plain.json');
    expect(extractReplyBody(text)).toBe(handWrittenBody(text).trimEnd());
    expect(findDoneLine(extractReplyBody(text))).toBe('DONE: 指摘なし');
    // The DONE: line inside the thinking is not the answer's.
    expect(extractReplyBody(text)).not.toContain('思考の中の行');
  });

  it('keeps a DONE: line that is the last line of a reply without thinking', () => {
    const text = reply('reply-done-last.json');
    expect(extractReplyBody(text)).toBe(text);
    expect(findDoneLine(extractReplyBody(text))).toBe('DONE: 前回の指摘は解消。新しい指摘 1 件（この PR で直すべきもの 0 件）');
  });

  it('reads the finding count of a DONE: line', () => {
    expect(findingCount('DONE: 指摘 2 件（うち、この PR で直すべきもの 1 件）')).toBe(2);
    expect(findingCount('DONE: 指摘なし')).toBe(0);
    expect(findingCount('DONE: 判断不能 — 差分が読めない')).toBeNull();
  });
});

describe('the brief is built from the templates', () => {
  const input = {
    issue: 3528,
    head: HEAD,
    worktree: '/work/commandmate-issue-3528',
    branch: 'feature/3528-work',
    brief: '機能追加です。特に見たいのは: (1) 返答の取り出し',
  };

  it('fills the initial template', () => {
    const prompt = buildPrompt(input);
    expect(prompt).toContain('【依頼】Issue #3528 の修正を');
    expect(prompt).toContain('/work/commandmate-issue-3528（branch: feature/3528-work。HEAD: ' + HEAD);
    expect(prompt).toContain('.commandmate/tasks/issue-3528.yaml の goal');
    expect(prompt).toContain('機能追加です。特に見たいのは: (1) 返答の取り出し');
    expect(prompt).toContain('最後に `DONE:` で始まる1行');
    expect(prompt).not.toContain('{{');
    expect(prompt).not.toContain('【再レビュー】');
  });

  it('fills the re-review template: the previous findings come first, then the whole review', () => {
    const prompt = buildPrompt({ ...input, previous: reply('reply-quotes-thinking.json') });
    const rereview = prompt.indexOf('【再レビュー】');
    const previous = prompt.indexOf('P2：引用・思考の図で検索先が食い違う');
    const judge = prompt.indexOf('(0) 前回の指摘の判定');
    const review = prompt.indexOf('【依頼】Issue #3528 の修正を');
    expect(rereview).toBe(0);
    expect(previous).toBeGreaterThan(rereview);
    expect(judge).toBeGreaterThan(previous);
    expect(review).toBeGreaterThan(judge);
    // The previous answer is passed without its thinking.
    expect(prompt).not.toContain('前回の指摘の経路と照合します');
    expect(prompt).not.toContain('{{');
  });

  it('a placeholder without a value is an error', () => {
    expect(() => renderTemplate('Issue #{{ISSUE}} at {{HEAD}}', { ISSUE: 1 })).toThrow(/HEAD/);
    expect(() => buildPrompt(input, { initial: 'Issue #{{ISSUE}} {{UNKNOWN}}' })).toThrow(/UNKNOWN/);
  });

  it('a "{{" that is not a placeholder is an error', () => {
    expect(() => renderTemplate('Issue #{{ ISSUE }}', { ISSUE: 1 })).toThrow(/\{\{/);
    expect(() => buildPrompt(input, { initial: 'Issue #{{issue}}' })).toThrow(/\{\{/);
  });

  it('a value that contains "{{" is sent as it is', () => {
    expect(renderTemplate('brief: {{BRIEF}}', { BRIEF: 'uses {{x}}' })).toBe('brief: uses {{x}}');
  });
});

interface Call {
  command: string;
  args: string[];
}

describe('main', () => {
  let tmp: string;
  let runDir: string;
  let brief: string;
  let lock: string;
  let calls: Call[];
  let errors: string[];

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-consistency-review-3528-'));
    runDir = path.join(tmp, 'runs', '2026-10-10');
    brief = path.join(tmp, 'brief.txt');
    fs.writeFileSync(brief, '機能追加です。\n');
    lock = path.join(tmp, 'proposals', '2026-10-10', '.lock');
    calls = [];
    errors = [];
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const fakeRun =
    (ask: { status: number; stdout: string; stderr?: string }, captures: string[] = ['ready']) =>
    (command: string, args: string[]) => {
      calls.push({ command, args });
      if (command === 'git' && args.includes('--abbrev-ref')) return { status: 0, stdout: 'feature/3528-work\n', stderr: '' };
      if (command === 'git') return { status: 0, stdout: `${HEAD}\n`, stderr: '' };
      if (args[0] === 'capture') {
        const status = captures.length > 1 ? captures.shift() : captures[0];
        return { status: 0, stdout: JSON.stringify({ sessionStatus: status }), stderr: '' };
      }
      if (args[0] === 'ask') return { stderr: '', ...ask };
      throw new Error(`unexpected call: ${command} ${args.join(' ')}`);
    };

  const argv = (extra: string[] = []) => [
    '--run-dir', runDir, '--issues', '3528', '--issue', '3528', '--head', HEAD.slice(0, 7),
    '--brief', brief, '--worktree', path.join(tmp, 'wt'), '--lock', lock, '--cli', 'cmd-fake', ...extra,
  ];
  const deps = (run: ReturnType<typeof fakeRun>) => ({
    run,
    sleep: () => {},
    now: () => new Date(Date.UTC(2026, 9, 10, 0, 0)),
    cwd: tmp,
    log: () => {},
    error: (line: string) => errors.push(line),
  });
  const reviewRecords = () => readRecords(runDir, '3528').records.filter((r) => r.stage === 'review');

  it.each([
    [[] as string[], '--run-dir is required'],
    [['--run-dir', 'r', '--issues', '3528', '--issue', '3528', '--head', 'nothex', '--brief', 'b'], '--head'],
    [['--run-dir', 'r', '--issues', 'x', '--issue', '3528', '--head', 'abcdef1', '--brief', 'b'], '--issues'],
    [['--bogus'], 'unknown'],
  ])('a usage error exits 2 without sending or recording (%j)', (args, message) => {
    expect(main(args, deps(fakeRun({ status: 0, stdout: '' })))).toBe(2);
    expect(errors.join('\n')).toContain(message);
    expect(calls).toEqual([]);
  });

  it('--rereview without --previous, --previous without --rereview, and a missing --brief exit 2', () => {
    const run = fakeRun({ status: 0, stdout: '' });
    expect(main(argv(['--rereview']), deps(run))).toBe(2);
    expect(main(argv(['--previous', brief]), deps(run))).toBe(2);
    expect(parseArgs(argv().map((a) => (a === brief ? path.join(tmp, 'missing.txt') : a))).error).toMatch(/--brief/);
    expect(calls).toEqual([]);
    expect(fs.existsSync(runDir)).toBe(false);
  });

  it('a failed ask records review=fail and adds no row', () => {
    const code = main(argv(), deps(fakeRun({ status: 124, stdout: '', stderr: 'timed out' })));
    expect(code).toBe(1);
    const records = reviewRecords();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ issue: 3528, stage: 'review', result: 'fail', head: HEAD, agent: 'codex' });
    expect(records[0].note).toContain('ask exit=124');
    expect(fs.existsSync(path.join(runDir, 'consistency-review.md'))).toBe(false);
    expect(fs.readFileSync(path.join(runDir, 'review-3528.err'), 'utf8')).toBe('timed out');
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('an answer without a DONE: line records review=fail', () => {
    const stdout = JSON.stringify({ reply: '途中までの返答\n\n> **Thinking (1)**\n>\n> DONE: 思考の中' });
    expect(main(argv(), deps(fakeRun({ status: 0, stdout })))).toBe(1);
    expect(reviewRecords()[0]).toMatchObject({ result: 'fail' });
    expect(reviewRecords()[0].note).toContain('no DONE: line');
    expect(fs.existsSync(path.join(runDir, 'consistency-review.md'))).toBe(false);
  });

  it('a successful review records review=ok and appends one row to consistency-review.md', () => {
    const table = path.join(runDir, 'consistency-review.md');
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(
      table,
      '| # | Issue | 担当 | 依頼した HEAD | 時間（待ちを含む） | 指摘 | 独自の発見（重複・既報を除く） | 種類（動作／説明／テスト） | 新規／既存 | 再判定 | 処置 | 事前レビューの有無 |\n' +
        '|---|---|---|---|---|---|---|---|---|---|---|---|\n' +
        '| 1 | #3411 | Codex | f787547 | 390 秒 | 0 | 0 | — | — | — | なし | なし |\n'
    );
    const stdout = fs.readFileSync(path.join(FIXTURES, 'reply-quotes-thinking.json'), 'utf8');
    // ready, busy, then ready three times: the streak restarts after "running".
    const run = fakeRun({ status: 0, stdout }, ['ready', 'running', 'ready', 'ready', 'ready']);
    expect(main(argv(), deps(run))).toBe(0);

    const records = reviewRecords();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ result: 'ok', head: HEAD, agent: 'codex' });
    expect(records[0].note).toContain('DONE: 指摘 1 件');

    const rows = fs.readFileSync(table, 'utf8').trimEnd().split('\n');
    expect(rows).toHaveLength(4);
    expect(rows[3]).toMatch(/^\| 2 \| #3528 \| Codex \| c0ffee1 \| 0 秒 \| 1（DONE: 指摘 1 件（この PR で直すべきもの 1 件）） \|/);
    expect(rows[3].split(' | ')).toHaveLength(12);

    const body = fs.readFileSync(path.join(runDir, 'review-3528.md'), 'utf8');
    expect(findDoneLine(body)).toBe('DONE: 指摘 1 件（この PR で直すべきもの 1 件）');
    expect(fs.readFileSync(path.join(runDir, 'review-3528.prompt.txt'), 'utf8')).toContain('【依頼】Issue #3528');

    expect(calls.filter((c) => c.args[0] === 'capture')).toHaveLength(5);
    const ask = calls.find((c) => c.args[0] === 'ask');
    expect(ask?.command).toBe('cmd-fake');
    expect(ask?.args).toEqual([
      'ask', 'mycodebranchdesk', expect.stringContaining('【依頼】Issue #3528'),
      '--instance', 'codex', '--timeout', '2400', '--json',
    ]);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('a re-review sends the re-review brief, writes the next label and marks the row', () => {
    const stdout = fs.readFileSync(path.join(FIXTURES, 'reply-done-last.json'), 'utf8');
    fs.mkdirSync(runDir, { recursive: true });
    const previous = path.join(runDir, 'review-3528.md');
    fs.writeFileSync(previous, extractReplyBody(reply('reply-quotes-thinking.json')));
    expect(nextReviewLabel(runDir, 3528)).toBe('review-3528b');

    expect(main(argv(['--rereview', '--previous', previous]), deps(fakeRun({ status: 0, stdout })))).toBe(0);
    const prompt = fs.readFileSync(path.join(runDir, 'review-3528b.prompt.txt'), 'utf8');
    expect(prompt.startsWith('【再レビュー】')).toBe(true);
    expect(prompt).toContain('P2：引用・思考の図で検索先が食い違う');
    const table = fs.readFileSync(path.join(runDir, 'consistency-review.md'), 'utf8').trimEnd().split('\n');
    expect(table).toHaveLength(3);
    expect(table[2]).toMatch(/^\| 1 \| #3528 再レビュー \| Codex \|/);
  });

  it('does not ask when the worktree is at another HEAD', () => {
    const run = fakeRun({ status: 0, stdout: '' });
    expect(main(argv().map((a) => (a === HEAD.slice(0, 7) ? 'abcdef1' : a)), deps(run))).toBe(1);
    expect(calls.some((c) => c.args[0] === 'ask')).toBe(false);
    expect(reviewRecords()[0]).toMatchObject({ result: 'fail' });
  });

  it('does not ask when Codex never reads ready three times in a row', () => {
    const run = fakeRun({ status: 0, stdout: '' }, ['running']);
    expect(main(argv(), deps(run))).toBe(1);
    expect(calls.some((c) => c.args[0] === 'ask')).toBe(false);
    expect(reviewRecords()[0].note).toContain('not ready');
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('waits for a lock another ask holds', () => {
    fs.mkdirSync(lock, { recursive: true });
    let slept = 0;
    const stdout = fs.readFileSync(path.join(FIXTURES, 'reply-plain.json'), 'utf8');
    const code = main(argv(), {
      ...deps(fakeRun({ status: 0, stdout })),
      sleep: () => {
        slept++;
        if (slept === 2) fs.rmdirSync(lock);
      },
    });
    expect(code).toBe(0);
    expect(slept).toBeGreaterThanOrEqual(2);
    expect(fs.existsSync(lock)).toBe(false);
  });
});
