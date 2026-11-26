/**
 * Issue #4574 N-E / M1 / D-2 — what the operator reads from a monitor started
 * without `--hooks`, and the closing line the goal asks a worker to print.
 *
 * Scope: what this guards against is the supervisor's status line misreading a
 * worker that has ended (S11: `NOT_STARTED — idle with no work` for 20 minutes
 * over a DONE and a WAIT, because `--hooks` was not passed), and the goal's
 * closing line drifting from the shape the readers accept (`verify exit -`
 * left Command Code's DONE unread by wait-verify for 30 minutes). Running an
 * old version of the tools on purpose is outside this scope.
 *
 * Invariants pinned here:
 *   - E1 (N-E): the two real panes S11 missed (tests/fixtures/orchestrate-monitor-4574,
 *     copied unchanged from the run) are fed to the entry point `monitor.sh`
 *     without `--hooks`, through a fake CLI (the s11 investigation §1.2 shape):
 *     after the ending line, NOT_STARTED is never printed. The verdict does not
 *     become COMPLETE (the ending is a report, not a verdict — #4532). Control:
 *     a pane with no ending still prints NOT_STARTED.
 *   - E2: without `--hooks`, one WARN line at start on stderr; with it, none.
 *   - M1: monitor-lib.sh's `ml__return_line_scan` and wait-verify.mjs's
 *     `returnLineOf` give the same answer on the same panes and lines.
 *   - T1 (D-2): the closing line of templates/goal.md, rendered by contract.mjs
 *     and filled with real values, is a DONE for both readers; `verify exit -`
 *     is not (the negative control), and the template says `<n>` is a number.
 *
 * Every file is under os.tmpdir(); nothing in the repository is written.
 *
 * @vitest-environment node
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  REAL_SHELL_SUBPROCESS_TIMEOUT_MS,
  assertSubprocessCompleted,
} from '@tests/helpers/real-shell-budget';
import { buildContract, normalizeConfig } from '../../../../scripts/orchestrate/contract.mjs';
import { DONE_LINE_RE, returnLineOf } from '../../../../scripts/orchestrate/wait-verify.mjs';

const ROOT = process.cwd();
const MONITOR = path.join(ROOT, '.claude/skills/orchestrate-monitor/scripts/monitor.sh');
const LIB = path.join(ROOT, '.claude/skills/orchestrate-monitor/scripts/monitor-lib.sh');
const OWN = path.join(ROOT, 'tests/fixtures/orchestrate-monitor-4574');
const PANES = {
  4288: path.join(OWN, 'pane-4288-monitor-miss.txt'),
  4558: path.join(OWN, 'pane-4558-monitor-miss.txt'),
} as const;
const HARD_TIMEOUT_MS = REAL_SHELL_SUBPROCESS_TIMEOUT_MS;
const POLLS = 4;
const NO_HOOKS_WARN = /^monitor: WARN no --hooks:/;

const made: string[] = [];
afterEach(() => {
  while (made.length) rmSync(made.pop() as string, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
}

/**
 * The s11 §1.2 fake CLI: `capture --pane` answers the pane file as it is, and
 * `capture --json` an idle claude frame (`❯ `) — the shape the monitor saw.
 */
function runMonitor(paneFile: string, args: string[] = []): { stdout: string; stderr: string; status: number | null } {
  const dir = tmp('monitor-no-hooks-4574-');
  const cm = path.join(dir, 'fake-cm');
  const frame = path.join(dir, 'frame.json');
  writeFileSync(
    frame,
    JSON.stringify({ isRunning: true, cliToolId: 'claude', content: '❯ ', realtimeSnippet: '❯ ', isPromptWaiting: false, promptData: null }, null, 2),
  );
  writeFileSync(cm, ['#!/bin/sh', 'case " $* " in', `  *" --pane "*) cat "${paneFile}" ;;`, `  *) cat "${frame}" ;;`, 'esac', ''].join('\n'));
  writeFileSync(path.join(dir, 'tmux'), '#!/bin/sh\nexit 0\n');
  chmodSync(cm, 0o755);
  chmodSync(path.join(dir, 'tmux'), 0o755);
  const proc = spawnSync(
    'bash',
    [MONITOR, '--interval', '0', '--idle-threshold', '1', '--max-polls', String(POLLS), '--no-auto-approve', ...args, 'commandmate-issue-4574@claude'],
    { encoding: 'utf8', timeout: HARD_TIMEOUT_MS, env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}`, CM: cm } },
  );
  assertSubprocessCompleted(proc, 'monitor-no-hooks-return-line-4574.test.ts');
  return { stdout: proc.stdout ?? '', stderr: proc.stderr ?? '', status: proc.status };
}

/** monitor-lib.sh's reader over a pane file: `ml_return_line_text` (ANSI stripped, then `ml__return_line_scan`). */
function shellReturnLine(file: string): string {
  const out = spawnSync('bash', ['-c', `. "${LIB}"; ml_return_line_text "$1"`, 'bash', file], { encoding: 'utf8' });
  expect(out.status, out.stderr).toBe(0);
  return out.stdout.trim();
}

/** The same text through wait-verify.mjs's reader, in the shell reader's words. */
function jsReturnLine(text: string): string {
  const found = returnLineOf(text);
  if (found.kind === 'none') return 'none';
  return found.kind === 'SHAPE_OUTSIDE' ? `SHAPE_OUTSIDE ${found.line}` : found.line;
}

/** One line through both readers. */
function bothRead(line: string): { shell: string; js: string } {
  const file = path.join(tmp('return-line-4574-'), 'pane.txt');
  writeFileSync(file, `${line}\n`);
  return { shell: shellReturnLine(file), js: jsReturnLine(line) };
}

const ENDING_REPORT = /return line (DONE|WAIT|STOP)|SHAPE_OUTSIDE ending/;
/** The NOT_STARTED status line itself (the ENDED line says "not NOT_STARTED" in its text). */
const STATUS_NOT_STARTED = /\]: NOT_STARTED — /;

describe('E1 (N-E): an ending on the pane is never followed by NOT_STARTED without --hooks', () => {
  for (const [issue, file] of Object.entries(PANES)) {
    it(`pane ${issue}: the ending is reported, then no NOT_STARTED; the verdict stays short of COMPLETE`, () => {
      const run = runMonitor(file);
      const lines = run.stdout.split('\n');
      const reported = lines.findIndex((line) => ENDING_REPORT.test(line));

      expect(reported, run.stdout).toBeGreaterThanOrEqual(0);
      expect(lines.slice(reported).filter((line) => STATUS_NOT_STARTED.test(line)), run.stdout).toEqual([]);
      // The status line names the ending instead, once per ending.
      expect(lines.filter((line) => /\]: ENDED \(/.test(line)), run.stdout).toHaveLength(1);
      // Nothing claims completion from the ending (#4532: a report, not a verdict).
      expect(run.stdout).not.toMatch(/all 1 worker\(s\) complete/);
      expect(run.stdout).toContain(`monitor: reached --max-polls (${POLLS})`);
      expect(run.status).toBe(0);
    }, HARD_TIMEOUT_MS);
  }

  it('control: a pane with no ending still says NOT_STARTED (the line is unchanged there)', () => {
    const file = path.join(tmp('monitor-no-ending-4574-'), 'pane.txt');
    writeFileSync(file, '❯ \n');
    const run = runMonitor(file);
    expect(run.stdout).toMatch(/NOT_STARTED — idle with no work; check the composer \/ Enter/);
    expect(run.stdout).not.toMatch(ENDING_REPORT);
    expect(run.status).toBe(0);
  }, HARD_TIMEOUT_MS);
});

describe('E2: starting without --hooks says so once, on stderr', () => {
  it('no --hooks: exactly one WARN line naming the hooks to pass', () => {
    const file = path.join(tmp('monitor-e2-4574-'), 'pane.txt');
    writeFileSync(file, '❯ \n');
    const run = runMonitor(file);
    const warns = run.stderr.split('\n').filter((line) => NO_HOOKS_WARN.test(line));
    expect(warns, run.stderr).toHaveLength(1);
    expect(warns[0]).toContain('--hooks');
    expect(warns[0]).toContain('hooks-git.sh');
    // stderr only: the stdout stream an operator greps stays as it was.
    expect(run.stdout).not.toMatch(/WARN no --hooks/);
  }, HARD_TIMEOUT_MS);

  it('with --hooks: no such line', () => {
    const dir = tmp('monitor-e2-hooks-4574-');
    const hooks = path.join(dir, 'hooks.sh');
    writeFileSync(hooks, 'count_commits() { echo 0; }\ncount_uncommitted() { echo 0; }\n');
    const file = path.join(dir, 'pane.txt');
    writeFileSync(file, '❯ \n');
    const run = runMonitor(file, ['--hooks', hooks]);
    expect(run.stderr).not.toMatch(/WARN no --hooks/);
  }, HARD_TIMEOUT_MS);
});

describe('M1: the two readers give the same answer', () => {
  it('on the two real panes (4288: SHAPE_OUTSIDE after `verify exit -`; 4558: the WAIT beside the panel)', () => {
    const answers = Object.fromEntries(
      Object.entries(PANES).map(([issue, file]) => [issue, { shell: shellReturnLine(file), js: jsReturnLine(readFileSync(file, 'utf8')) }]),
    );
    for (const { shell, js } of Object.values(answers)) expect(js).toBe(shell);
    // 4288 needed no change to the readers: its DONE has `-` and is not a DONE,
    // and the IMPL_COMPLETED after it is the ending (rule (a) of the brief).
    expect(answers[4288].shell).toBe('SHAPE_OUTSIDE IMPL_COMPLETED');
    expect(answers[4558].shell).toMatch(/^WAIT: #4560 /);
  });
});

describe('T1 (D-2): the goal\'s closing line, filled in, is a DONE for both readers', () => {
  const ISSUE = 4574;
  const goal: string = buildContract(
    normalizeConfig({ issue: ISSUE, title: 't', scope: ['scripts/orchestrate/contract.mjs'], decisions: ['d'], issueBody: 'b' }),
  ).goal;
  const closing = goal.split('\n').find((line) => line.startsWith('- 手番の最後の行は')) ?? '';
  const template = /`(DONE: #\d+ <sha> verify exit ([^`]+))`/.exec(closing);

  it('the closing line names a DONE whose exit is the placeholder <n>', () => {
    expect(closing).not.toBe('');
    expect(template?.[1]).toBe(`DONE: #${ISSUE} <sha> verify exit <n>`);
    expect(template?.[2]).toBe('<n>');
  });

  it('the goal says <n> is the self-check\'s exit as a number, and not `-`', () => {
    const rule = goal.split('\n').find((line) => line.includes('verify exit <n>') && line.includes('数字')) ?? '';
    expect(rule, goal).not.toBe('');
    expect(rule).toContain('自己確認');
    expect(rule).toMatch(/`0`/);
    expect(rule).toMatch(/`1`/);
    expect(rule).toMatch(/`-`/);
    expect(rule).toMatch(/使わない/);
  });

  const SHAS = ['0123456789abcdef0123456789abcdef01234567', '60082d4'];
  for (const sha of SHAS) {
    for (const n of ['0', '1']) {
      it(`filled with a ${sha.length}-hex sha and n=${n}: DONE for DONE_LINE_RE and ml__return_line_scan`, () => {
        const line = (template?.[1] ?? '').replace('<sha>', sha).replace('<n>', n);
        expect(line).toBe(`DONE: #${ISSUE} ${sha} verify exit ${n}`);
        expect(DONE_LINE_RE.test(line)).toBe(true);
        const { shell, js } = bothRead(line);
        expect(shell).toBe(line);
        expect(js).toBe(shell);
      });
    }
  }

  it('negative control: `verify exit -` is a DONE for neither reader', () => {
    const line = `DONE: #${ISSUE} 60082d48f verify exit -`;
    expect(DONE_LINE_RE.test(line)).toBe(false);
    expect(bothRead(line)).toEqual({ shell: 'none', js: 'none' });
  });
});
