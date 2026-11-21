/**
 * #4532 — the return line and the ending the orchestrator must NOT accept.
 *
 * Before #4532 a worker ended a turn with a bare `IMPL_COMPLETED`, and the
 * orchestrator waited on that. Three endings went unnoticed instead: a `DONE:`
 * line (a worker that finished by the runbook's instruction), a `WAIT:`/`STOP:`
 * line, and a worker stopped on a permission prompt. The goal now asks for a
 * return line as the turn's LAST line, and `IMPL_COMPLETED` is a shape-outside
 * ending: reported, never read as completion.
 *
 * Two halves are pinned here, and both are needed:
 *   - `hasCompletionSignal` (wait-verify.mjs) still reads `IMPL_COMPLETED` for a
 *     task sent before #4532, AND now reads a `DONE: #<N> <sha> verify exit <n>`
 *     line keyed to the same HEAD;
 *   - `ml_return_line` (orchestrate-monitor's monitor-lib.sh) names whichever
 *     ending the pane shows, and calls `IMPL_COMPLETED` `SHAPE_OUTSIDE`.
 *
 * The detector is a library function rather than its own `.sh` on purpose: a new
 * shell script under the skill would have to be added to
 * tests/unit/guards/lint-sh-scope.test.ts's exclusion list, which this Issue's
 * scope does not cover.
 *
 * @vitest-environment node
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { hasCompletionSignal } from '../../../../scripts/orchestrate/wait-verify.mjs';

const ROOT = path.resolve(__dirname, '../../../..');
const LIB = path.join(ROOT, '.claude/skills/orchestrate-monitor/scripts/monitor-lib.sh');

const HEAD = '00c08aaf7';

/** A `capture --json` answer whose visible transcript is those rows. */
function answer(rows: string[]): Record<string, unknown> {
  const text = rows.join('\n');
  return { isRunning: true, cliToolId: 'claude', content: text, realtimeSnippet: text, promptData: null };
}

/** Run `ml_return_line` of monitor-lib.sh on a payload, from a temp file. */
function detect(payload: Record<string, unknown>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'return-line-4532-'));
  try {
    const file = path.join(dir, 'payload.json');
    // JSON.stringify(payload, null, 2): byte-identical to `capture --json`.
    writeFileSync(file, JSON.stringify(payload, null, 2));
    const out = spawnSync('bash', ['-c', `. "${LIB}" ; ml_return_line "$1"`, 'bash', file], { encoding: 'utf8' });
    expect(out.status, out.stderr).toBe(0);
    return out.stdout.trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('wait-verify reads the return line and still reads the old ending (#4532)', () => {
  it('a DONE line naming this HEAD completes; one naming another HEAD does not', () => {
    expect(hasCompletionSignal(`work\nDONE: #4527 ${HEAD} verify exit 0\n`, { head: `${HEAD}abc` })).toBe(true);
    expect(hasCompletionSignal(`work\nDONE: #4527 ${'b'.repeat(9)} verify exit 0\n`, { head: `${HEAD}abc` })).toBe(false);
  });

  it('positive control: the old IMPL_COMPLETED line is not removed (a task sent before #4532 waits on it)', () => {
    expect(hasCompletionSignal('done\nIMPL_COMPLETED\n')).toBe(true);
    expect(hasCompletionSignal(`IMPL_COMPLETED head=${HEAD}\n`, { head: `${HEAD}abc` })).toBe(true);
    expect(hasCompletionSignal(`IMPL_COMPLETED head=${'b'.repeat(9)}\n`, { head: `${HEAD}abc` })).toBe(false);
  });

  it('negative control: the goal text that NAMES the shapes is not an ending', () => {
    const goalText = '手番の最後の行は `DONE: #4527 <sha> verify exit <n>`・`WAIT: <理由>`・`STOP: <理由>` のどれかにする';
    expect(hasCompletionSignal(goalText)).toBe(false);
    // `WAIT:` / `STOP:` are the orchestrator's to read off the pane (ml_return_line),
    // not this reader's: they carry no HEAD, so they cannot prove the work tree.
    expect(hasCompletionSignal('WAIT: verify 前\n')).toBe(false);
  });

  it('a DONE line must be the whole line, and name a verify exit', () => {
    expect(hasCompletionSignal(`DONE: #4527 ${HEAD} verify exit 0 (not the last line)`)).toBe(false);
    expect(hasCompletionSignal(`DONE: #4527 ${HEAD}\n`)).toBe(false);
  });

  it('the DONE sha is 7-40 hex, the one shape launch-worker reads too (#4532 review P3-3)', () => {
    expect(hasCompletionSignal('DONE: #4527 a verify exit 0\n')).toBe(false);
    expect(hasCompletionSignal('DONE: #4527 00c08aa verify exit 0\n')).toBe(true);
  });
});

describe('ml_return_line names whichever ending the pane shows (#4532)', () => {
  it('the three return lines', () => {
    expect(detect(answer(['working', `DONE: #4527 ${HEAD} verify exit 0`]))).toBe(`DONE: #4527 ${HEAD} verify exit 0`);
    expect(detect(answer(['working…', 'WAIT: verify 前（コミット abc1234）']))).toBe('WAIT: verify 前（コミット abc1234）');
    expect(detect(answer(['working…', 'STOP: 前提が変わった（ゲートの定義）']))).toBe('STOP: 前提が変わった（ゲートの定義）');
  });

  it('IMPL_COMPLETED is reported as a shape-outside ending, never as a return line', () => {
    expect(detect(answer(['done', 'IMPL_COMPLETED']))).toBe('SHAPE_OUTSIDE IMPL_COMPLETED');
    expect(detect(answer([`done`, `IMPL_COMPLETED head=${HEAD}`]))).toBe(`SHAPE_OUTSIDE IMPL_COMPLETED head=${HEAD}`);
  });

  it('reads the NEWEST ending when several are on screen', () => {
    expect(detect(answer(['WAIT: earlier', 'working', `DONE: #4527 ${HEAD} verify exit 0`]))).toBe(
      `DONE: #4527 ${HEAD} verify exit 0`
    );
  });

  it('negative control: the goal text naming all three shapes is not an ending', () => {
    const goalText = '手番の最後の行は `DONE: #4527 <sha> verify exit <n>`・`WAIT: <理由>`・`STOP: <理由>` のどれかにする';
    expect(detect(answer([goalText]))).toBe('none');
    expect(detect(answer(['still working on the tests']))).toBe('none');
  });

  it('tolerates ANSI escapes and indentation, as a real pane carries them', () => {
    expect(detect(answer([`\u001b[1m   DONE: #4527 ${HEAD} verify exit 20 \u001b[0m`]))).toBe(
      `DONE: #4527 ${HEAD} verify exit 20`
    );
  });
});
