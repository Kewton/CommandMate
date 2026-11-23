/**
 * #4532 — launch-worker names a shape-outside ending instead of reading it as
 * completion.
 *
 * The session a launch starts is read with `capture --json` for the model, role
 * and composer checks. Since #4532 the goal's last line is a return line
 * (`DONE:` / `WAIT:` / `STOP:`), and `IMPL_COMPLETED` is the OLD ending: a session
 * that shows it must be named, not counted. The detector runs on the answer the
 * launch already reads — no extra capture, so no pinned argv changes.
 *
 * The fixture shape is a `capture --json` payload (`content` / `realtimeSnippet`
 * carrying the escaped transcript, ANSI intact), the same way the monitor reads
 * it. Positive controls: the three return lines are recognised; the goal text
 * naming them is not.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';

import { endingOfAnswer, shapeOutsideWarning } from '../../../../scripts/orchestrate/launch-worker.mjs';

const HEAD = '00c08aaf7';

/** A `capture --json` answer whose visible transcript is those rows. */
function answer(rows: string[]): Record<string, unknown> {
  const text = rows.join('\n');
  return {
    isRunning: true,
    cliToolId: 'command-code',
    sessionStatus: 'ready',
    content: text,
    realtimeSnippet: text,
    promptData: null,
  };
}

describe('endingOfAnswer reads the goal\'s return line (#4532)', () => {
  it('names each of the three return lines', () => {
    expect(endingOfAnswer(answer(['working…', `DONE: #4527 ${HEAD} verify exit 0`]))).toEqual({
      kind: 'DONE',
      line: `DONE: #4527 ${HEAD} verify exit 0`,
    });
    expect(endingOfAnswer(answer(['WAIT: verify 前（コミット abc1234）']))).toEqual({
      kind: 'WAIT',
      line: 'WAIT: verify 前（コミット abc1234）',
    });
    expect(endingOfAnswer(answer(['STOP: 前提が変わった']))).toEqual({ kind: 'STOP', line: 'STOP: 前提が変わった' });
  });

  it('calls IMPL_COMPLETED a shape-outside ending, never a return line', () => {
    expect(endingOfAnswer(answer(['done', 'IMPL_COMPLETED']))).toEqual({ kind: 'SHAPE_OUTSIDE', line: 'IMPL_COMPLETED' });
    expect(endingOfAnswer(answer([`IMPL_COMPLETED head=${HEAD}`]))).toEqual({
      kind: 'SHAPE_OUTSIDE',
      line: `IMPL_COMPLETED head=${HEAD}`,
    });
  });

  it('reads the NEWEST ending when several are on screen', () => {
    expect(endingOfAnswer(answer(['IMPL_COMPLETED', 'working', `DONE: #4527 ${HEAD} verify exit 0`])).kind).toBe('DONE');
    expect(endingOfAnswer(answer([`DONE: #4527 ${HEAD} verify exit 0`, 'working', 'STOP: 前提が変わった'])).kind).toBe('STOP');
  });

  it('negative controls: no ending, and the goal text naming all three shapes', () => {
    expect(endingOfAnswer(answer(['still working on the tests'])).kind).toBe('none');
    expect(endingOfAnswer({})).toEqual({ kind: 'none', line: '' });
    const goalText =
      '手番の最後の行は `DONE: #4527 <sha> verify exit <n>`・`WAIT: <理由>`・`STOP: <理由>` のどれかにする';
    expect(endingOfAnswer(answer([goalText])).kind).toBe('none');
  });

  it('a DONE line must be the whole line', () => {
    expect(endingOfAnswer(answer([`DONE: #4527 ${HEAD} verify exit 0 (trailing prose)`])).kind).toBe('none');
    expect(endingOfAnswer(answer([`note: DONE: #4527 ${HEAD} verify exit 0`])).kind).toBe('none');
  });

  it('the DONE sha is 7-40 hex, the same shape wait-verify reads (#4532 review P3-3)', () => {
    expect(endingOfAnswer(answer(['DONE: #4527 a verify exit 0'])).kind).toBe('none');
    expect(endingOfAnswer(answer(['DONE: #4527 00c08aa verify exit 0'])).kind).toBe('DONE');
  });

  it('tolerates the escaped form and ANSI a raw capture carries', () => {
    // JSON.stringify leaves ANSI as `\u001b[1m` and newlines as `\n`; the monitor
    // normalizes both, and so does this reader.
    const raw = `\\u001b[1m\\u001b[0m  IMPL_COMPLETED \\u001b[0m`;
    expect(endingOfAnswer({ realtimeSnippet: raw }).kind).toBe('SHAPE_OUTSIDE');
    expect(endingOfAnswer({ content: `working\\nDONE: #4527 ${HEAD} verify exit 0` }).kind).toBe('DONE');
  });
});

describe('shapeOutsideWarning names the old ending and nothing else (#4532)', () => {
  it('warns only on IMPL_COMPLETED', () => {
    expect(shapeOutsideWarning(answer(['IMPL_COMPLETED']), 'w1@command-code')).toContain('IMPL_COMPLETED');
    expect(shapeOutsideWarning(answer(['IMPL_COMPLETED']), 'w1@command-code')).toContain('not a return line');
  });

  it('stays silent for a return line, a busy turn and a missing answer (negative controls)', () => {
    expect(shapeOutsideWarning(answer([`DONE: #4527 ${HEAD} verify exit 0`]), 'w')).toBeNull();
    expect(shapeOutsideWarning(answer(['WAIT: verify 前']), 'w')).toBeNull();
    expect(shapeOutsideWarning(answer(['still working']), 'w')).toBeNull();
    expect(shapeOutsideWarning(null, 'w')).toBeNull();
  });
});
