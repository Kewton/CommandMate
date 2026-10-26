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
import { buildRealtimeSnippet } from '@/lib/realtime-snippet';

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
    // the window current-output judges — so on a short session the fault is not
    // published. Kept here so a change to the window shows up; not fixed by #3936.
    const shortSession = read('startup-screen-3293/codex-0.160.0-first-turn-interrupted.txt').replace(
      '■ Conversation interrupted - use /feedback if something went wrong',
      CAPACITY_LINE,
    );
    expect(matchUpstreamFault(shortSession)?.fault.id).toBe('model-capacity');
    expect(matchUpstreamFault(buildRealtimeSnippet(shortSession))).toBeNull();
  });

  it.each([
    ['the 529 storm line (claude), which says "at capacity" too', 'API Error: Repeated 529 Overloaded errors. The API is at capacity.'],
    ['prose about choosing a model', 'Selected model: gpt-5.6-terra. Use /model to switch if the model is at capacity later.'],
    ['the /model picker description', '  /model  choose what model and reasoning effort to use'],
  ])('does not report model-capacity for %s', (_label, frame) => {
    expect(matchUpstreamFault(frame)?.fault.id).not.toBe('model-capacity');
  });
});
