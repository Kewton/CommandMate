/**
 * Issue #4532 (r4) — the invariants of the monitor's pane read, pinned on the
 * real scripts. The review raised "the monitor does not read every row of the
 * pane" twice (P1-1, then P1-A), so the invariants are tests first:
 *
 *   N1  unless the worker is NOT_RUNNING, every poll reads `capture --pane` and
 *       the ending is judged on ALL of its rows — for every CLI, not only
 *       Command Code, and not only when `--json` shows no row (T1: codex's split
 *       canvas, where `--json` shows the composer and nothing else).
 *   N2  the permission prompt is read from the pane too, with the marker each
 *       CLI already has (T2). A CLI with no marker of its own is left to the
 *       server's isPromptWaiting — no marker is invented for it.
 *   T3  the DONE shape is the same for wait-verify's DONE_LINE_RE and the
 *       monitor's scan: one table of rows, both readers, the same answers.
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
import { DONE_LINE_RE, normalizePaneLine } from '../../../../scripts/orchestrate/wait-verify.mjs';

const MONITOR = path.join(process.cwd(), '.claude/skills/orchestrate-monitor/scripts/monitor.sh');
const LIB = path.join(process.cwd(), '.claude/skills/orchestrate-monitor/scripts/monitor-lib.sh');
const FIXTURES = path.join(process.cwd(), 'tests/fixtures');

const DONE = 'DONE: #4527 abcdef1 verify exit 0';

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

/** A `capture --json` frame whose `--json` window holds nothing useful. */
function blankFrame(tool: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    isRunning: true,
    cliToolId: tool,
    sessionStatus: 'ready',
    sessionStatusReason: 'input_prompt',
    content: '',
    realtimeSnippet: '   \n  \n',
    thinking: false,
    isPromptWaiting: false,
    promptData: null,
    ...extra,
  };
}

interface RunResult {
  stdout: string;
  captureCalls: string[];
}

/**
 * Run the real loop: `$CM capture … --json` answers `payload`, `$CM capture …
 * --pane` answers `pane` (or fails when `pane` is null).
 */
function runLoop(payload: Record<string, unknown>, pane: string | null, polls: number, args: string[] = []): RunResult {
  const dir = tempDir('monitor-pane-inv-4532-');
  const captureLog = path.join(dir, 'capture.log');
  const frameFile = path.join(dir, 'payload.json');
  const paneFile = path.join(dir, 'pane.txt');
  const cmShim = path.join(dir, 'fake-cm');
  const tmuxShim = path.join(dir, 'tmux');
  writeFileSync(frameFile, JSON.stringify(payload, null, 2));
  writeFileSync(paneFile, pane ?? '');
  writeFileSync(
    cmShim,
    [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> "${captureLog}"`,
      'case " $* " in',
      pane === null ? '  *" --pane "*) exit 1 ;;' : `  *" --pane "*) cat "${paneFile}" ;;`,
      `  *) cat "${frameFile}" ;;`,
      'esac',
      '',
    ].join('\n'),
  );
  writeFileSync(tmuxShim, '#!/bin/sh\nexit 0\n');
  chmodSync(cmShim, 0o755);
  chmodSync(tmuxShim, 0o755);
  writeFileSync(captureLog, '');
  const proc = spawnSync(
    'bash',
    [MONITOR, '--interval', '0', '--idle-threshold', '1', '--max-polls', String(polls), ...args, 'w1'],
    {
      encoding: 'utf8',
      timeout: REAL_SHELL_SUBPROCESS_TIMEOUT_MS,
      env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}`, CM: cmShim },
    },
  );
  assertSubprocessCompleted(proc, 'monitor-pane-invariants-4532.test.ts');
  expect({ status: proc.status, signal: proc.signal }).toEqual({ status: 0, signal: null });
  return {
    stdout: proc.stdout ?? '',
    captureCalls: readFileSync(captureLog, 'utf8').split('\n').filter(Boolean),
  };
}

function endingLines(stdout: string): string[] {
  return stdout.split('\n').filter((line) => /return line (DONE|WAIT|STOP)|SHAPE_OUTSIDE ending/.test(line));
}

describe('T1 (N1, review P1-A): every CLI is read from --pane, all rows', () => {
  it('codex split canvas: the DONE above the blank gap is reported though --json shows the composer', () => {
    // codex 0.160 draws the transcript from the TOP of its 1000-row canvas and
    // the composer at the BOTTOM, blank rows between (#3946). realtimeSnippet is
    // the last 100 rows: the composer and nothing else. content is the delta
    // after the poller's cursor, which is empty once the reply was saved.
    const composer = ['› Ask Codex to do anything', '  gpt-5.6-sol default · ~/repo'];
    const snippet = [...Array.from({ length: 98 }, () => ''), ...composer].join('\n');
    const payload = blankFrame('codex', { content: '', realtimeSnippet: snippet });
    const pane = ['› #4527 を実装する', '• 実装しました。', DONE, '', ...composer].join('\n');

    const run = runLoop(payload, pane, 2);
    expect(run.captureCalls.filter((c) => c.includes('--json'))).toHaveLength(2);
    const reported = endingLines(run.stdout);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain(`return line DONE — ${DONE}`);
  });

  it('claude with visible rows in --json is read from --pane too (no tool or visible-row branch)', () => {
    const payload = blankFrame('claude', { content: '', realtimeSnippet: '❯ \n? for shortcuts' });
    const pane = ['⏺ 直しました', DONE, '', '❯ ', '? for shortcuts'].join('\n');
    const run = runLoop(payload, pane, 1);
    expect(run.captureCalls).toEqual(['capture w1 --json', 'capture w1 --pane']);
    expect(endingLines(run.stdout)).toHaveLength(1);
  });

  it('a NOT_RUNNING worker is not read with --pane (negative control)', () => {
    const run = runLoop({ isRunning: false, cliToolId: 'codex' }, DONE, 1);
    expect(run.captureCalls).toEqual(['capture w1 --json']);
    expect(endingLines(run.stdout)).toEqual([]);
  });

  it('a failing --pane read is announced once per worker, never silently `none`', () => {
    const run = runLoop(blankFrame('codex'), null, 3);
    const warns = run.stdout.split('\n').filter((line) => line.includes('WARN capture --pane failed'));
    expect(warns).toHaveLength(1);
    expect(endingLines(run.stdout)).toEqual([]);
  });
});

describe('T2 (N2, review P2-A): a permission prompt that is only on the pane is PROMPT', () => {
  it('Command Code (#4434 frame, content empty, snippet blank, isPromptWaiting:false): ml_cc_has_prompt_marker on the pane', () => {
    const pane = readFileSync(path.join(FIXTURES, 'command-code-live-2250/dialog-shell-command.txt'), 'utf8');
    const run = runLoop(blankFrame('command-code'), pane, 2, ['--no-auto-approve']);
    expect(run.stdout).toContain('PROMPT held, no Enter sent');
  });

  it('claude (content empty, snippet blank, isPromptWaiting:false): ml_has_prompt_marker on the pane', () => {
    const fixture = JSON.parse(
      readFileSync(path.join(process.cwd(), 'tests/unit/skills/orchestrate-monitor/fixtures/prompt-yes-no.json'), 'utf8'),
    ) as { realtimeSnippet: string };
    const run = runLoop(blankFrame('claude'), fixture.realtimeSnippet, 2, ['--no-auto-approve']);
    expect(run.stdout).toContain('PROMPT held, no Enter sent');
  });

  it('codex has no marker of its own: left to the server isPromptWaiting (no marker is invented)', () => {
    // codex's picker draws `› 1.`, which no existing marker reads. The server's
    // isPromptWaiting decides; the pane read does not make one up.
    const pane = readFileSync(path.join(FIXTURES, 'codex-live-2310/dialog-permissions-picker.txt'), 'utf8');
    const flagged = runLoop(blankFrame('codex', { isPromptWaiting: true }), pane, 2, ['--no-auto-approve']);
    expect(flagged.stdout).toContain('PROMPT held, no Enter sent');
    const unflagged = runLoop(blankFrame('codex'), pane, 2, ['--no-auto-approve']);
    expect(unflagged.stdout).not.toContain('PROMPT held');
  });

  it('a pane with no dialog does not become PROMPT (negative control)', () => {
    const run = runLoop(blankFrame('command-code'), ['working…', 'still going'].join('\n'), 2, ['--no-auto-approve']);
    expect(run.stdout).not.toContain('PROMPT held');
  });
});

/** Whether monitor-lib's scan reads `row` as a DONE return line. */
function monitorReadsDone(row: string): boolean {
  const dir = tempDir('done-shape-4532-');
  const file = path.join(dir, 'pane.txt');
  writeFileSync(file, `${row}\n`);
  const out = spawnSync('bash', ['-c', `. "${LIB}" ; ml_return_line_text "$1"`, 'bash', file], { encoding: 'utf8' });
  expect(out.status, out.stderr).toBe(0);
  return out.stdout.trim().startsWith('DONE:');
}

describe('T3 (review P3-B): DONE_LINE_RE and the monitor agree on one table', () => {
  const hex40 = '0123456789abcdef0123456789abcdef01234567';
  const rows: Array<[string, string, boolean]> = [
    ['one space', 'DONE: #4527 abcdef1 verify exit 0', true],
    ['two spaces', 'DONE: #4527  abcdef1 verify exit 0', true],
    ['a tab', 'DONE:\t#4527\tabcdef1\tverify exit 0', true],
    ['leading indent', '   DONE: #4527 abcdef1 verify exit 0', true],
    ['sha of 6', 'DONE: #4527 abcdef verify exit 0', false],
    ['sha of 7', 'DONE: #4527 abcdef1 verify exit 0', true],
    ['sha of 40', `DONE: #4527 ${hex40} verify exit 0`, true],
    ['sha of 41', `DONE: #4527 ${hex40}8 verify exit 0`, false],
    // S10 (lead r1): the reply marker is normalized away on both sides, so this
    // row — `false` in r4 — is a DONE now (pane-line-agreement-4532.test.ts).
    ['a prefix', '• DONE: #4527 abcdef1 verify exit 0', true],
    ['a prose prefix', 'note: DONE: #4527 abcdef1 verify exit 0', false],
  ];

  it.each(rows)('%s: both readers give the same answer', (_name, row, expected) => {
    // Both readers see the row after the one normalization (S10).
    expect(DONE_LINE_RE.test(normalizePaneLine(row))).toBe(expected);
    expect(monitorReadsDone(row)).toBe(expected);
  });
});
