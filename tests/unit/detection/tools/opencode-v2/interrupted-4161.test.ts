/**
 * Issue #4161: an interrupted turn's closing row, `… · 4.5s · interrupted`, is a
 * finished turn. Measured on 2.0.18 at 80x200 in an isolated HOME and private tmux:
 * the first Esc shows `esc again to interrupt` and the reply keeps growing; the
 * second draws the row and the footer loses its hint. The executable draws the
 * suffix after the optional `tok/s`.
 *
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeFrame } from '@/lib/detection/tools/frame';
import {
  endsWithTurnComplete,
  OPENCODE_V2_TURN_COMPLETE_PATTERN,
  opencodeV2StatusDetector,
} from '@/lib/detection/tools/opencode-v2/detect';
import { OPENCODE_TURN_COMPLETE_PATTERN } from '@/lib/detection/tools/opencode/patterns';
import { STATUS_REASON } from '@/lib/detection/status-reason';
import { OPENCODE_V2_THINKING_PATTERN } from '@/lib/detection/tools/opencode-v2/patterns';
import { extractResponse } from '@/lib/polling/response-checker';

const fixture = (rel: string): string => readFileSync(resolve(__dirname, '../../../../fixtures', rel), 'utf8');

const TURN_DONE = fixture('opencode-v2-live-2934/turn-done.txt');
const TURN_RUNNING = fixture('opencode-v2-live-2934/turn-running.txt');
const QUESTION_UNDER = fixture('opencode-v2-dialogs-2984/question-under-quoted-dialog.txt');

const ROW_IN_FIXTURE = '     Build · LongCat 2.5 Preview Free · 41.6s · 13.4 tok/s · interrupted';
const ROW_MEASURED = '     Build · Crouton Alpha Free · 4.5s · interrupted';

/** The measured finished frame with its closing row's tail replaced. */
function doneWith(tail: string): string {
  const next = TURN_DONE.replace(/( · \d[\d.]*s · [\d.]+ tok\/s)/, tail);
  expect(next).not.toBe(TURN_DONE);
  return next;
}

const verdict = (frame: string) => opencodeV2StatusDetector.detect(normalizeFrame(frame));

describe('the interrupted row', () => {
  it('is on the measured fixture, as the row this test reads', () => {
    expect(QUESTION_UNDER).toContain(ROW_IN_FIXTURE);
  });

  it.each([ROW_IN_FIXTURE, ROW_MEASURED, '     Build · m · 1m 5s · interrupted', '     Build · m · 1h 5m · 8.1 tok/s · interrupted'])(
    'reads %s',
    (row) => {
      expect(OPENCODE_V2_TURN_COMPLETE_PATTERN.test(row)).toBe(true);
    }
  );

  it.each([
    ['no duration', '     Build · m · interrupted'],
    ['words after it', '     Build · m · 4.5s · interrupted by the user'],
    ['another suffix', '     Build · m · 4.5s · failed'],
    ['on the gutter', '  ┃  Build · m · 4.5s · interrupted'],
    ['suffix before tok/s', '     Build · m · 4.5s · interrupted · 8.1 tok/s'],
  ])('does not read a row with %s', (_name, row) => {
    expect(OPENCODE_V2_TURN_COMPLETE_PATTERN.test(row)).toBe(false);
  });

  it.each([' · 4.5s · interrupted', ' · 41.6s · 13.4 tok/s · interrupted'])(
    'a frame ending in%s is a finished turn, as one without it is',
    (tail) => {
      const frame = doneWith(tail);
      expect(endsWithTurnComplete(normalizeFrame(frame))).toBe(true);
      expect(verdict(frame).status).toBe('ready');
      expect(verdict(frame).reason).toBe(STATUS_REASON.OPENCODE_RESPONSE_COMPLETE);
    }
  );
});

describe('the counterpart in V1', () => {
  it('already reads the suffix: 1.18.35 draws it too and its pattern is not anchored at the end', () => {
    expect(OPENCODE_TURN_COMPLETE_PATTERN.test('▣  Build · big-pickle · 4.5s · interrupted')).toBe(true);
  });
});

describe('negative: not read as finished', () => {
  it('a question opened after an interrupted row', () => {
    expect(endsWithTurnComplete(normalizeFrame(QUESTION_UNDER))).toBe(false);
    expect(verdict(QUESTION_UNDER).status).toBe('waiting');
  });

  it('a later turn thinking under an interrupted row', () => {
    const frame = QUESTION_UNDER.split(ROW_IN_FIXTURE)[0] + ROW_IN_FIXTURE + '\n\n  ┃\n  ┃  next prompt\n  ┃\n\n     + Thought · 2.9s\n';
    expect(endsWithTurnComplete(normalizeFrame(frame))).toBe(false);
  });

  it('a running turn whose footer still has its hint, with the row above it', () => {
    const frame = TURN_RUNNING.replace(/(\n[^\n]*esc interrupt)/, `\n${ROW_MEASURED}$1`);
    expect(frame).toContain(ROW_MEASURED);
    expect(verdict(frame).status).toBe('running');
  });

  it('the window after the first Esc, while the reply is still being written', () => {
    expect(TURN_RUNNING).toContain('esc interrupt');
    const frame = TURN_RUNNING.replace('esc interrupt', 'esc again to interrupt');
    expect(verdict(frame).status).toBe('running');
  });
});

describe('the running hint is the footer, not a row of the reply', () => {
  /** The footer measured after the first Esc on 2.0.18, 80 columns. */
  const FOOTER_AFTER_ESC = '   ⬝⬝⬝⬝⬝⬝⬝⬝ esc again to interrupt           shift+tab agents  ctrl+p commands';

  const BODY_ROWS = [
    ['in a sentence', '     One Esc shows "esc again to interrupt", and the next one stops the turn.'],
    ['at the head of the row', '     esc again to interrupt is what the footer says after one Esc.'],
    ['alone on the row', '     esc again to interrupt'],
    ['the first hint', '     The footer reads esc interrupt while a turn runs.'],
  ] as const;

  /** A finished turn's reply with `row` as one of its lines. */
  const finishedWith = (row: string): string => {
    const next = TURN_DONE.replace('     OK\n', `     OK\n${row}\n`);
    expect(next).not.toBe(TURN_DONE);
    return next;
  };

  it.each([
    ['the measured running frame', TURN_RUNNING.split('\n').find((row) => row.includes('esc interrupt')) ?? ''],
    ['the frame measured after the first Esc', FOOTER_AFTER_ESC],
    ['a spinner run in other cells', '   ⬝■■■■■■⬝ esc again to interrupt   8.8K (1%)  ctrl+p commands'],
  ])('reads %s', (_name, row) => {
    expect(row).not.toBe('');
    expect(OPENCODE_V2_THINKING_PATTERN.test(row)).toBe(true);
  });

  it.each([
    ['prose naming both', '     esc again to interrupt and ctrl+p commands'],
    ['the hint without the footer\'s end', '   ⬝⬝⬝⬝⬝⬝⬝⬝ esc again to interrupt   shift+tab agents'],
    ['words after the footer\'s end', '   ⬝⬝⬝⬝ esc interrupt  ctrl+p commands opens the palette'],
    ['the hint inside a word', '   not-esc interrupt  ctrl+p commands'],
  ])('does not read %s', (_name, row) => {
    expect(OPENCODE_V2_THINKING_PATTERN.test(row)).toBe(false);
  });

  it('the frame after the first Esc, measured footer in place, is still running', () => {
    const frame = TURN_RUNNING.replace(/^.*esc interrupt.*$/m, FOOTER_AFTER_ESC);
    expect(frame).toContain(FOOTER_AFTER_ESC);
    expect(verdict(frame).status).toBe('running');
  });

  it.each(BODY_ROWS)('a finished reply with the words %s is finished', (_name, row) => {
    const frame = finishedWith(row);
    expect(endsWithTurnComplete(normalizeFrame(frame))).toBe(true);
    expect(verdict(frame).status).toBe('ready');
    expect(verdict(frame).reason).toBe(STATUS_REASON.OPENCODE_RESPONSE_COMPLETE);
  });

  it.each(BODY_ROWS)('the extracted reply keeps the row with the words %s', (_name, row) => {
    const result = extractResponse(finishedWith(row), 0, 'opencode-v2');
    expect(result?.response).toContain(row.trim());
  });

  it('a reply still being written keeps that row, and the footer stays out', () => {
    const row = BODY_ROWS[0][1];
    const frame = TURN_RUNNING.replace(/^(\s*┃\s*tools\.\n\s*┃\n)/m, `$1\n${row}\n`);
    expect(frame).toContain(row);
    const result = extractResponse(frame, 0, 'opencode-v2');
    expect(result?.isComplete).toBe(false);
    expect(result?.response).toContain(row.trim());
    expect(result?.response).not.toContain('ctrl+p commands');
  });
});
