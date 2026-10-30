/**
 * Issue #3946: the upstream-fault reading, in two steps.
 *
 * 1. `api-error` is anchored to a line start: a healthy codex reply that quoted
 *    `• API Error: 500` on an indented continuation row made `ask` exit 11
 *    (2026-10-27, codex-2; the row is copied below verbatim).
 * 2. On codex 0.160's split screen (transcript at the top, composer at the
 *    bottom) the transcript's last row is read too, on the `■ ` error-row rules
 *    only. The capacity frames are SYNTHETIC (tests/fixtures/upstream-faults/README.md).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { matchCodexErrorRowFault, matchUpstreamFault } from '@/lib/detection/upstream-faults';
import { detectSessionStatus } from '@/lib/detection/status-detector';
import {
  buildRealtimeSnippet,
  matchPaneUpstreamFault,
  selectTranscriptTailRow,
} from '@/lib/realtime-snippet';

const FIXTURES = join(__dirname, '../../../fixtures');
const read = (rel: string): string => readFileSync(join(FIXTURES, rel), 'utf8');

const CAPACITY_LINE = '■ Selected model is at capacity. Please try a different model.';
const CAPACITY_FRAME = read('upstream-faults/codex-0.160.0-model-capacity-3946.txt');
const NEXT_TURN_FRAME = read('upstream-faults/codex-0.160.0-model-capacity-next-turn-3946.txt');
const INTERRUPTED_FRAME = read('startup-screen-3293/codex-0.160.0-first-turn-interrupted.txt');
const REPLY_FRAME = read('startup-screen-3293/codex-0.160.0-first-turn-reply.txt');
const CLAUDE_FULLSCREEN = read('claude-model-switch-2361/fullscreen-boot-fable.txt');

/** The row of `review-1.raw.txt:175` that `api-error` matched (measured). */
const MEASURED_QUOTE_ROW =
  '    error:88 (src/lib/detection/upstream-faults.ts:88)には行頭制約がなく、上部の正常な返答にある• API Error: 500 の説明…も拾います。claudeを対象外にするだけでは防げません。引用を除外する方針と、codex';

/** The capacity frame with its transcript's last row (row 11) replaced. */
const withTailRow = (row: string): string => {
  const lines = CAPACITY_FRAME.split('\n');
  lines[10] = row;
  return lines.join('\n');
};

const paneFault = (frame: string, cliToolId = 'codex') =>
  matchPaneUpstreamFault(frame.split('\n'), cliToolId);

describe('step 1: api-error is anchored to a line start (Issue #3946)', () => {
  it('does not match the measured quote on an indented continuation row', () => {
    expect(matchUpstreamFault(MEASURED_QUOTE_ROW)).toBeNull();
    expect(matchUpstreamFault(['• P1：codex限定でも、引用による誤検出が増える方針です。', MEASURED_QUOTE_ROW].join('\n'))).toBeNull();
  });

  it.each([
    ['a codex reply row', '• エラーは API Error: 500 です'],
    ['its indented continuation', '• 返答の説明:\n  API Error: 500 が出ていました'],
    ['a codex input echo', '› 画面の API Error: 500 を調べて'],
    ['a mid-line mention', 'The row says API Error: 401 when the key is wrong.'],
  ])('does not match %s', (_label, frame) => {
    expect(matchUpstreamFault(frame)).toBeNull();
  });

  it.each([
    ['claude’s row', '⏺ API Error: Connection error.'],
    ['a bare row at column 0', 'API Error: 401 Unauthorized'],
    ['a status-code form at column 0', 'API Error 500'],
    ['a row below other rows', '❯ ping\n⏺ API Error: Connection error.\n✻ Sautéed for 1s'],
  ])('still matches %s', (_label, frame) => {
    expect(matchUpstreamFault(frame)?.fault.id).toBe('api-error');
  });

  it('the 529 line is still `overloaded`, ahead of api-error', () => {
    expect(matchUpstreamFault('⏺ API Error: Repeated 529 Overloaded errors.')?.fault.id).toBe('overloaded');
  });

  it('known limit: a claude reply that begins with `⏺ API Error:` cannot be told apart', () => {
    expect(matchUpstreamFault('⏺ API Error: 500 は上流の障害を示す文言です。')?.fault.id).toBe('api-error');
  });
});

describe('selectTranscriptTailRow (Issue #3946)', () => {
  const blanks = (n: number): string[] => new Array(n).fill('');

  it('returns the last content row above a blank run that reaches the window top', () => {
    const lines = ['head', 'tail row', ...blanks(980), 'composer', 'footer'];
    expect(selectTranscriptTailRow(lines)).toBe('tail row');
  });

  it.each([
    ['the window top carries content', [...new Array(200).fill('row')]],
    ['the whole tail is blank (#2768 already anchors it)', ['head', 'tail row', ...blanks(200)]],
    ['nothing above the blank run', [...blanks(950), 'composer']],
    ['the capture is no longer than the window', ['tail row', ...blanks(50), 'composer']],
  ])('returns null when %s', (_label, lines) => {
    expect(selectTranscriptTailRow(lines as string[])).toBeNull();
  });

  it('reads the synthetic 0.160 capacity frame’s row 11', () => {
    expect(selectTranscriptTailRow(CAPACITY_FRAME.split('\n'))).toBe(CAPACITY_LINE);
  });
});

describe('step 2: codex 0.160 split screen reads the transcript’s last row (Issue #3946)', () => {
  it('premise: the capacity row is outside realtimeSnippet, and the frame reads ready', () => {
    expect(matchUpstreamFault(CAPACITY_FRAME)?.fault.id).toBe('model-capacity');
    expect(matchUpstreamFault(buildRealtimeSnippet(CAPACITY_FRAME))).toBeNull();
    expect(detectSessionStatus(CAPACITY_FRAME, 'codex').status).toBe('ready');
  });

  it('reports model-capacity with the row as matchedText', () => {
    const match = paneFault(CAPACITY_FRAME);
    expect(match?.fault.id).toBe('model-capacity');
    expect(match?.matchedText).toBe(CAPACITY_LINE);
  });

  it('past turn: a healthy next turn after the capacity row reports nothing', () => {
    expect(matchUpstreamFault(NEXT_TURN_FRAME)?.fault.id).toBe('model-capacity');
    expect(paneFault(NEXT_TURN_FRAME)).toBeNull();
  });

  it.each([
    ['a codex reply quoting API Error', '\u001b[2m• \u001b[0mエラーは API Error: 500 です'],
    ['an indented capacity row', `  ${CAPACITY_LINE}`],
    ['a codex reply naming the capacity error', '• 画面に ■ Selected model is at capacity が出ていました'],
    ['a bare API Error row (not a `■ ` rule)', 'API Error: 500 Internal Server Error'],
  ])('quote control: null when the last row is %s', (_label, row) => {
    expect(paneFault(withTailRow(row))).toBeNull();
  });

  it.each([
    ['the measured interrupted frame (`■ Conversation interrupted`)', INTERRUPTED_FRAME],
    ['the measured first-turn reply frame', REPLY_FRAME],
  ])('negative control: %s has no fault', (_label, frame) => {
    expect(paneFault(frame)).toBeNull();
  });

  it('negative control: a bottom-anchored frame is judged on its last 100 rows only', () => {
    const rows = [CAPACITY_LINE, ...new Array(150).fill('  transcript row')];
    expect(paneFault(rows.join('\n'))).toBeNull();
  });

  it('negative control: a non-codex split screen does not get the extra row', () => {
    const lines = CLAUDE_FULLSCREEN.split('\n');
    lines[3] = CAPACITY_LINE;
    // Premise: the same layout — the row is the one codex would have read.
    expect(selectTranscriptTailRow(lines)).toBe(CAPACITY_LINE);
    expect(matchPaneUpstreamFault(lines, 'codex')?.fault.id).toBe('model-capacity');
    expect(matchPaneUpstreamFault(lines, 'claude')).toBeNull();
  });

  it('the extra row only carries the `■ ` error-row rules', () => {
    expect(matchCodexErrorRowFault(CAPACITY_LINE)?.fault.id).toBe('model-capacity');
    expect(matchCodexErrorRowFault('⏺ API Error: Connection error.')).toBeNull();
    expect(matchCodexErrorRowFault('Claude usage limit reached.')).toBeNull();
  });

  it('the window is still judged first, on every rule', () => {
    const lines = CAPACITY_FRAME.split('\n');
    lines[lines.length - 5] = '✻ 529 Overloaded · Retrying in 34s · attempt 9/10';
    expect(matchPaneUpstreamFault(lines, 'codex')?.fault.id).toBe('overloaded');
  });
});
