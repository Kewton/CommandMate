/**
 * Issue #3936: codex's "Selected model is at capacity" is an upstream fault
 * (`model-capacity`), and only its error wording is.
 *
 * The capacity frame is SYNTHETIC (tests/fixtures/upstream-faults/README.md):
 * the measured codex 0.155.1 idle frame with its turn-end row replaced by the
 * line quoted in the run summary. It shows that the rule matches the line where
 * `current-output` looks for it (`realtimeSnippet`), not that codex draws it
 * there.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { matchUpstreamFault } from '@/lib/detection/upstream-faults';
import { detectSessionStatus } from '@/lib/detection/status-detector';
import { buildRealtimeSnippet, matchPaneUpstreamFault } from '@/lib/realtime-snippet';

const FIXTURES = join(__dirname, '../../../fixtures');
const read = (rel: string): string => readFileSync(join(FIXTURES, rel), 'utf8');

const CAPACITY_FRAME = read('upstream-faults/codex-model-capacity-3936.txt');
const IDLE_FRAME = read('codex-idle-composer-0155/idle-after-turn.txt');
const CAPACITY_LINE = '■ Selected model is at capacity. Please try a different model.';

describe('model-capacity upstream fault (Issue #3936)', () => {
  it('matches the capacity line, as a fault codex does not retry', () => {
    const match = matchUpstreamFault(CAPACITY_LINE);
    expect(match?.fault.id).toBe('model-capacity');
    expect(match?.fault.selfRetrying).toBe(false);
    expect(match?.matchedText).toBe(CAPACITY_LINE);
  });

  it('matches on the realtimeSnippet of the (synthetic) frame back at the composer', () => {
    const match = matchUpstreamFault(buildRealtimeSnippet(CAPACITY_FRAME));
    expect(match?.fault.id).toBe('model-capacity');
    expect(match?.matchedText).toBe(CAPACITY_LINE);
  });

  it('the frame still reads ready for codex, so wait reaches its upstream-fault stage', () => {
    expect(detectSessionStatus(CAPACITY_FRAME, 'codex').status).toBe('ready');
  });

  it('negative control: the measured healthy codex idle frame has no fault', () => {
    expect(detectSessionStatus(IDLE_FRAME, 'codex').status).toBe('ready');
    expect(matchUpstreamFault(IDLE_FRAME)).toBeNull();
    expect(matchUpstreamFault(buildRealtimeSnippet(IDLE_FRAME))).toBeNull();
  });

  it('known gap: an error row more than 100 rows above the composer is outside realtimeSnippet', () => {
    // codex 0.160.0 measured: a short transcript at the top of the 1000-row
    // pane, the composer at the bottom (startup-screen-3293). The same frame
    // with its `■` row carrying the capacity line matches as a whole, but not on
    // `realtimeSnippet`. Issue #3946 closed the gap without moving the window:
    // current-output and the push poller (`matchPaneUpstreamFault`) also read the
    // transcript's last row on codex's split screen, so the fault is published.
    const shortSession = read('startup-screen-3293/codex-0.160.0-first-turn-interrupted.txt').replace(
      '■ Conversation interrupted - use /feedback if something went wrong',
      CAPACITY_LINE,
    );
    expect(matchUpstreamFault(shortSession)?.fault.id).toBe('model-capacity');
    expect(matchUpstreamFault(buildRealtimeSnippet(shortSession))).toBeNull();
    const published = matchPaneUpstreamFault(shortSession.split('\n'), 'codex');
    expect(published?.fault.id).toBe('model-capacity');
    expect(published?.matchedText).toBe(CAPACITY_LINE);
  });

  // Review of eaeab6d (P1): the wording alone also sits in healthy replies that
  // quote it — this Issue, its review, a reply explaining the error. Only codex's
  // own error row (`■ ` at column 0) is the fault.
  it.each([
    ['a codex reply naming the error', '• エラー名は Selected model is at capacity です。'],
    ['a codex reply quoting the row on an indented line', '• 画面には次の行が出ていました:\n  ■ Selected model is at capacity. Please try a different model.'],
    ['a codex input echo of a brief that quotes it', '› ■ Selected model is at capacity. Please try a different model. を検出してください'],
    ['a claude reply quoting it', '⏺ codex の画面に「■ Selected model is at capacity」が出ていました。'],
    ['a claude continuation line quoting it', '⏺ 引用します:\n  ■ Selected model is at capacity. Please try a different model.'],
    ['a mid-line quote with backticks', 'The row `■ Selected model is at capacity.` is the cue to switch instance.'],
  ])('does not match %s', (_label, frame) => {
    expect(matchUpstreamFault(frame)).toBeNull();
  });

  it('negative control: the synthetic frame with the row quoted by an indented reply line has no fault', () => {
    const quoted = CAPACITY_FRAME.replace(CAPACITY_LINE, `  ${CAPACITY_LINE}`);
    expect(matchUpstreamFault(buildRealtimeSnippet(quoted))).toBeNull();
  });

  it.each([
    ['the 529 storm line (claude), which says "at capacity" too', 'API Error: Repeated 529 Overloaded errors. The API is at capacity.'],
    ['prose about choosing a model', 'Selected model: gpt-5.6-terra. Use /model to switch if the model is at capacity later.'],
    ['the /model picker description', '  /model  choose what model and reasoning effort to use'],
  ])('does not report model-capacity for %s', (_label, frame) => {
    expect(matchUpstreamFault(frame)?.fault.id).not.toBe('model-capacity');
  });
});
