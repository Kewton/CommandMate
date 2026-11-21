/**
 * Issue #4532 — the monitor notices every way a turn ends, for every CLI.
 *
 * The report the month of runs produced: a worker that ended on a permission
 * prompt, or with the runbook's `DONE:` line, was invisible, and a bare
 * `IMPL_COMPLETED` was the only ending the orchestrator looked for — while also
 * being the easiest thing on screen to mistake for a live one. So the goal now
 * ends with `DONE: #<N> <sha> verify exit <n>` / `WAIT: <reason>` /
 * `STOP: <reason>`, and the monitor names the ending it sees.
 *
 * What this pins:
 *   - a 3 × 3 grid (Command Code, claude, codex × DONE, WAIT, STOP) plus the
 *     permission-prompt column (#4532 review P2-1);
 *   - the ending the orchestrator must NOT read as a return line
 *     (`IMPL_COMPLETED`): the loop reports it as SHAPE_OUTSIDE, never completion;
 *   - the ending is read from `capture --pane`, ALL lines (#4532 review P1-1).
 *     A Command Code pane is top-anchored, so `--json`'s content/realtimeSnippet
 *     can be blank padding while the DONE line is on the pane; the control below
 *     shows `--json` alone sees nothing and `--pane` sees it.
 *
 * Every file is under os.tmpdir(); nothing in the repository is written.
 *
 * @vitest-environment node
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  REAL_SHELL_SUBPROCESS_TIMEOUT_MS,
  assertSubprocessCompleted,
} from '@tests/helpers/real-shell-budget';

const MONITOR = path.join(process.cwd(), '.claude/skills/orchestrate-monitor/scripts/monitor.sh');
const LIB = path.join(process.cwd(), '.claude/skills/orchestrate-monitor/scripts/monitor-lib.sh');
const FIXTURES = path.join(process.cwd(), 'tests/fixtures');
const INTERVAL_SEC = 0;
const IDLE_THRESHOLD = 1;
const HARD_TIMEOUT_MS = REAL_SHELL_SUBPROCESS_TIMEOUT_MS;

const HEAD = '00c08aaf7';

/** The three endings, as the goal asks a worker to print them. */
const ENDINGS = {
  DONE: `DONE: #4527 ${HEAD} verify exit 0`,
  WAIT: 'WAIT: verify 前（コミット abc1234）',
  STOP: 'STOP: 前提が変わった（ゲートの定義）',
} as const;

/** The three CLI tool ids of the grid. */
const TOOLS = ['command-code', 'claude', 'codex'] as const;

/** A capture frame for a tool, with the given rows as its visible transcript. */
function frame(tool: string, rows: string[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  const text = rows.join('\n');
  return {
    isRunning: true,
    cliToolId: tool,
    sessionStatus: 'ready',
    sessionStatusReason: 'input_prompt',
    content: text,
    realtimeSnippet: text,
    thinking: false,
    isPromptWaiting: false,
    promptData: null,
    ...extra,
  };
}

/** A permission-prompt frame for each tool (#4532 review P2-1). */
function promptFrame(tool: (typeof TOOLS)[number]): Record<string, unknown> {
  if (tool === 'command-code') {
    // The CLI's own numbered approval dialog (`❯ 1. …`).
    const rows = readFileSync(path.join(FIXTURES, 'command-code-live-2250/dialog-shell-command.txt'), 'utf8').split('\n');
    return frame(tool, rows);
  }
  if (tool === 'claude') {
    const fixture = JSON.parse(
      readFileSync(path.join(process.cwd(), 'tests/unit/skills/orchestrate-monitor/fixtures/prompt-yes-no.json'), 'utf8'),
    ) as { realtimeSnippet: string };
    return frame(tool, fixture.realtimeSnippet.split('\n'), { isPromptWaiting: true });
  }
  // codex: the server reports the open dialog with isPromptWaiting; codex's
  // picker uses `› 1.`, not the Claude `❯ 1.` marker.
  const rows = readFileSync(path.join(FIXTURES, 'codex-live-2310/dialog-permissions-picker.txt'), 'utf8').split('\n');
  return frame(tool, rows, { isPromptWaiting: true });
}

interface RunResult {
  stdout: string;
  status: number | null;
  signal: NodeJS.Signals | null;
  captureCalls: string[];
}

interface RunOptions {
  /** Extra monitor flags (e.g. `--no-auto-approve`). */
  args?: string[];
  /** What `capture --pane` answers. Defaults to the payload's visible text. */
  pane?: string;
}

/** Run the loop against a fixed payload for `polls` rounds, with logging shims. */
function runLoop(payload: Record<string, unknown>, polls: number, opts: RunOptions = {}): RunResult {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'monitor-return-line-4532-'));
  try {
    const tmuxLog = path.join(dir, 'tmux.log');
    const captureLog = path.join(dir, 'capture.log');
    const frameFile = path.join(dir, 'payload.json');
    const paneFile = path.join(dir, 'pane.txt');
    const tmuxShim = path.join(dir, 'tmux');
    const cmShim = path.join(dir, 'fake-cm');

    // JSON.stringify(payload, null, 2): byte-identical to `capture --json`, which
    // is what ml_json_scalar's two-space anchor and ml_strip_ansi expect.
    writeFileSync(frameFile, JSON.stringify(payload, null, 2));
    // The loop reads the ending from `capture --pane`, so the shim serves the
    // pane for that flag and the JSON frame for `--json`. The default pane text
    // is what the payload's own window holds, so a tool's grid reads the same
    // rows either way.
    const paneText = opts.pane ?? String(payload.content || payload.realtimeSnippet || '');
    writeFileSync(paneFile, paneText);
    writeFileSync(tmuxShim, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${tmuxLog}"\nexit 0\n`);
    writeFileSync(
      cmShim,
      [
        '#!/bin/sh',
        `printf '%s\\n' "$*" >> "${captureLog}"`,
        'case " $* " in',
        `  *" --pane "*) cat "${paneFile}" ;;`,
        `  *) cat "${frameFile}" ;;`,
        'esac',
        '',
      ].join('\n'),
    );
    chmodSync(tmuxShim, 0o755);
    chmodSync(cmShim, 0o755);
    writeFileSync(tmuxLog, '');
    writeFileSync(captureLog, '');

    const proc = spawnSync(
      'bash',
      [
        MONITOR,
        '--interval',
        String(INTERVAL_SEC),
        '--idle-threshold',
        String(IDLE_THRESHOLD),
        '--max-polls',
        String(polls),
        ...(opts.args ?? []),
        'w1',
      ],
      { encoding: 'utf8', timeout: HARD_TIMEOUT_MS, env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}`, CM: cmShim } },
    );
    assertSubprocessCompleted(proc, 'monitor-return-line-4532.test.ts');

    return {
      stdout: proc.stdout ?? '',
      status: proc.status,
      signal: proc.signal,
      captureCalls: readFileSync(captureLog, 'utf8').split('\n').filter(Boolean),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The `capture --json` polls, one per round (a pane read is additional). */
function jsonPolls(run: RunResult): string[] {
  return run.captureCalls.filter((call) => call.includes('--json'));
}

/** Line(s) the loop printed for the ending; the report is once per ending. */
function reportLines(stdout: string): string[] {
  return stdout.split('\n').filter((line) => /return line (DONE|WAIT|STOP)|SHAPE_OUTSIDE ending/.test(line));
}

/** `ml_return_line` of monitor-lib.sh, stood up in a temp dir so the control reads exactly what the loop reads. */
function mlReturnLine(payload: Record<string, unknown>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'return-line-lib-4532-'));
  try {
    const file = path.join(dir, 'payload.json');
    writeFileSync(file, JSON.stringify(payload, null, 2));
    const out = spawnSync(
      'bash',
      ['-c', `. "${LIB}" ; ml_return_line "$1"`, 'bash', file],
      { encoding: 'utf8' },
    );
    expect(out.status, out.stderr).toBe(0);
    return out.stdout.trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('the monitor names the ending of every CLI (Issue #4532, 3 × 3)', () => {
  it.each(TOOLS)('on %s: all three endings are reported, each once', (tool) => {
    for (const [shape, line] of Object.entries(ENDINGS)) {
      // Two polls: enough for the report to be fired and then not repeated.
      const run = runLoop(frame(tool, ['working…', line]), 2);
      expect({ status: run.status, signal: run.signal }).toEqual({ status: 0, signal: null });
      // Prove the loop really polled the frame before believing its stdout.
      expect(jsonPolls(run)).toHaveLength(2);

      const reported = reportLines(run.stdout);
      expect(reported, `${tool} / ${shape}`).toHaveLength(1);
      expect(reported[0]).toContain(line);
      expect(reported[0]).toMatch(new RegExp(`return line ${shape}`));
    }
  });

  it.each(TOOLS)('on %s: a permission prompt is reported as PROMPT (#4532 review P2-1)', (tool) => {
    const run = runLoop(promptFrame(tool), 2, { args: ['--no-auto-approve'] });
    expect(jsonPolls(run)).toHaveLength(2);
    // The hold is the visible report (auto-approve would be silent, by design).
    expect(run.stdout).toContain('PROMPT held, no Enter sent');
  });

  it.each(TOOLS)('on %s: IMPL_COMPLETED is reported as SHAPE_OUTSIDE, never as a return line', (tool) => {
    const run = runLoop(frame(tool, ['done', 'IMPL_COMPLETED']), 2);
    expect(jsonPolls(run)).toHaveLength(2);

    expect(run.stdout).toContain('monitor[w1]: SHAPE_OUTSIDE ending — IMPL_COMPLETED (not a return line; not completion)');
    // The shape-outside ending must never be dressed up as any of the three.
    expect(reportLines(run.stdout)).toHaveLength(1);
    expect(run.stdout).not.toMatch(/return line (DONE|WAIT|STOP)/);
  });

  it.each(TOOLS)('on %s: a turn that has not ended reports nothing (negative control)', (tool) => {
    const run = runLoop(frame(tool, ['still working on the tests']), 2);
    expect(jsonPolls(run)).toHaveLength(2);
    expect(reportLines(run.stdout)).toEqual([]);
  });
});

describe('the ending is read from `capture --pane`, all lines (#4532 review P1-1)', () => {
  it('a Command Code pane whose --json window is blank: --json alone sees nothing, --pane sees the DONE', () => {
    // #4434's frame: content is empty (the CLI prints "No transcript yet") and
    // realtimeSnippet is blank padding (top-anchored 200x1000 pane, #4245). The
    // return line is on the pane and nowhere in the `--json` window.
    const payload = { ...frame('command-code', []), content: '', realtimeSnippet: '   \n  \n' };
    const pane = ['working…', `DONE: #4527 ${HEAD} verify exit 0`].join('\n');
    // Control: the reader the loop used before the fix finds nothing.
    expect(mlReturnLine(payload)).toBe('none');

    const run = runLoop(payload, 2, { pane });
    // The same payload the loop already polls, plus the pane read.
    expect(run.captureCalls).toEqual([
      'capture w1 --json',
      'capture w1 --pane',
      'capture w1 --json',
      'capture w1 --pane',
    ]);
    const reported = reportLines(run.stdout);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain(`DONE: #4527 ${HEAD} verify exit 0`);
  });

  it('a claude pane with no visible rows in --json is re-read with --pane too (#4532 review P1-1)', () => {
    const payload = { ...frame('claude', []), content: '', realtimeSnippet: '  \n' };
    expect(mlReturnLine(payload)).toBe('none');
    const pane = ['working…', `DONE: #4527 ${HEAD} verify exit 0`].join('\n');
    const run = runLoop(payload, 1, { pane });
    expect(run.captureCalls).toEqual(['capture w1 --json', 'capture w1 --pane']);
    expect(reportLines(run.stdout)).toHaveLength(1);
  });

  it('Command Code is read from --pane even when --json carries the line (argv is pinned)', () => {
    const run = runLoop(frame('command-code', ['working…', ENDINGS.DONE]), 1);
    expect(run.captureCalls).toEqual(['capture w1 --json', 'capture w1 --pane']);
  });

  it('the goal text that NAMES the three shapes is not read as an ending', () => {
    // The instruction itself is in the pane (the worker echoes its contract), and
    // a substring match would report a DONE the worker never printed.
    const goalText =
      '手番の最後の行は `DONE: #4527 <sha> verify exit <n>`・`WAIT: <理由>`・`STOP: <理由>` のどれかにする';
    const run = runLoop(frame('claude', [goalText]), 2);
    expect(jsonPolls(run)).toHaveLength(2);
    expect(reportLines(run.stdout)).toEqual([]);
  });
});

describe('the DONE shape is one definition for the monitor and wait-verify (#4532 review P3-3)', () => {
  it('a 7-40 hex sha is a DONE; a 1-character token is not', () => {
    const seven = '00c08aa';
    const ok = runLoop(frame('command-code', [`DONE: #4527 ${seven} verify exit 0`]), 2);
    expect(reportLines(ok.stdout)).toHaveLength(1);
    expect(reportLines(ok.stdout)[0]).toContain('return line DONE');

    const short = runLoop(frame('command-code', ['DONE: #4527 a verify exit 0']), 2);
    expect(reportLines(short.stdout)).toEqual([]);
  });
});
