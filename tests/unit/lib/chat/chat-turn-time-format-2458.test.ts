/**
 * How a chat turn's clock is written (Issue #2458).
 *
 * `formatChatTurnTime` lives in `src/lib/date-utils.ts` beside its siblings —
 * one module owns this repository's `date-fns` patterns — but it is asserted
 * from `tests/unit/lib/chat/` because the shapes it produces are the chat
 * transcript's contract and nothing else's. `tests/unit/lib/date-utils.test.ts`
 * keeps pinning the three older helpers, all of which this Issue leaves
 * untouched.
 *
 * ## What each group is guarding
 *
 *  - **the two shapes** — `18:18 → 18:33` and `18:59` — are the Issue's
 *    acceptance conditions written out literally, including the arrow;
 *  - **collapsing** stops `18:33 → 18:33`, which reads as a rendering fault;
 *  - **the day boundary** is the case where a bare `HH:mm` would actively
 *    mislead: `23:58 → 00:04` looks like six hours BACKWARDS;
 *  - **ja / en** assert that the output does not move with the locale, which
 *    is a claim about the helper rather than an accident of it — the same
 *    decision `formatSessionNoteTimestamp` (#2427) documents;
 *  - **timezone** is handled by constructing every `Date` from local
 *    components. The repository pins no `TZ` for vitest, so a UTC instant would
 *    render as a different clock on every contributor's machine, and a test
 *    written that way would either be flaky or would be asserting the runner's
 *    timezone rather than the helper.
 *
 * ## Non-vacuity
 *
 * Every negative has its positive beside it: the collapsed pair is asserted
 * against a one-minute-apart pair that does NOT collapse, the dateless shape
 * against the dated one built from the same instants, and `''` against a
 * neighbouring call on the same `Date` that returns a stamp.
 */

import { describe, expect, it } from 'vitest';
import { ja, enUS } from 'date-fns/locale';
import { format } from 'date-fns';
import {
  CHAT_TURN_TIME_SEPARATOR,
  formatChatTurnTime,
  formatMessageTimestamp,
} from '@/lib/date-utils';

/** Local wall-clock, so the rendered `HH:mm` is the same in every timezone. */
function at(hour: number, minute: number, day = 7): Date {
  return new Date(2026, 8, day, hour, minute, 0);
}

/** A `now` on the same day as the fixtures, well after them. */
const TODAY = at(22, 0);

describe('[#2458] the two shapes the Issue names', () => {
  it('writes a range when the prompt is known', () => {
    expect(formatChatTurnTime(at(18, 33), at(18, 18), TODAY)).toBe('18:18 → 18:33');
  });

  it('writes the end alone when it is not', () => {
    expect(formatChatTurnTime(at(18, 59), null, TODAY)).toBe('18:59');
    expect(formatChatTurnTime(at(19, 14), undefined, TODAY)).toBe('19:14');
  });

  it('separates the two ends with the exported arrow', () => {
    // Asserted through the constant so a change to a hyphen fails here rather
    // than passing under a test that had spelled the arrow out itself.
    expect(CHAT_TURN_TIME_SEPARATOR).toBe(' → ');
    expect(formatChatTurnTime(at(18, 33), at(18, 18), TODAY)).toBe(
      `18:18${CHAT_TURN_TIME_SEPARATOR}18:33`,
    );
  });

  it('is one line: no newline, whatever the shape', () => {
    const shapes = [
      formatChatTurnTime(at(18, 33), at(18, 18), TODAY),
      formatChatTurnTime(at(18, 59), null, TODAY),
      formatChatTurnTime(at(0, 4), at(23, 58, 6), at(12, 0)),
    ];
    for (const shape of shapes) expect(shape).not.toContain('\n');
  });
});

describe('[#2458] a turn that opened and closed inside one minute', () => {
  it('collapses to a single stamp', () => {
    expect(formatChatTurnTime(at(18, 33), at(18, 33), TODAY)).toBe('18:33');
  });

  it('collapses when only the seconds differ', () => {
    const opened = new Date(2026, 8, 7, 18, 33, 2);
    const closed = new Date(2026, 8, 7, 18, 33, 57);
    expect(formatChatTurnTime(closed, opened, TODAY)).toBe('18:33');
  });

  it('does NOT collapse one minute apart', () => {
    // The positive control: without it the case above would pass against a
    // helper that had stopped rendering ranges altogether.
    expect(formatChatTurnTime(at(18, 34), at(18, 33), TODAY)).toBe('18:33 → 18:34');
  });
});

describe('[#2458] dates appear exactly when the clock alone would mislead', () => {
  it('dates both ends of a range that crosses midnight', () => {
    const opened = at(23, 58, 6);
    const closed = at(0, 4, 7);
    expect(formatChatTurnTime(closed, opened, at(12, 0))).toBe('9/6 23:58 → 9/7 00:04');
  });

  it('dates a stamp that is not from the reference day', () => {
    expect(formatChatTurnTime(at(18, 59, 6), null, TODAY)).toBe('9/6 18:59');
  });

  it('dates both ends of a same-day range that is not today', () => {
    // Symmetry is the point: `9/6 18:18 → 18:33` makes the reader work out
    // whether the second stamp is the 6th or the 7th.
    expect(formatChatTurnTime(at(18, 33, 6), at(18, 18, 6), TODAY)).toBe(
      '9/6 18:18 → 9/6 18:33',
    );
  });

  it('omits the date when everything is on the reference day', () => {
    expect(formatChatTurnTime(at(18, 33), at(18, 18), TODAY)).not.toContain('/');
    expect(formatChatTurnTime(at(18, 59), null, TODAY)).not.toContain('/');
  });

  it('reads "now" off the clock when none is given', () => {
    const now = new Date();
    const closed = new Date(now.getTime() - 60_000);
    expect(formatChatTurnTime(closed, null)).toBe(format(closed, 'HH:mm'));
  });

  it('falls back to the real clock when "now" is itself unusable', () => {
    const now = new Date();
    const closed = new Date(now.getTime() - 60_000);
    expect(formatChatTurnTime(closed, null, new Date('nonsense'))).toBe(
      format(closed, 'HH:mm'),
    );
  });
});

describe('[#2458] the output does not move with the locale', () => {
  it('renders the same string whichever locale the surface is in', () => {
    // The helper takes no `Locale` on purpose (see its docblock): the header
    // shares one line with a role label in a 360px pane and can hold two
    // stamps. This asserts the decision rather than assuming it — a switch to
    // `'PPp'` would make these two disagree.
    const range = formatChatTurnTime(at(18, 33), at(18, 18), TODAY);
    const single = formatChatTurnTime(at(18, 59, 6), null, TODAY);
    expect(range).toBe('18:18 → 18:33');
    expect(single).toBe('9/6 18:59');

    // The positive control for "these locales really do differ": the older
    // helper on the same instants renders two different strings.
    expect(formatMessageTimestamp(at(18, 33), ja)).not.toBe(
      formatMessageTimestamp(at(18, 33), enUS),
    );
  });

  it('never spends columns on AM/PM', () => {
    expect(formatChatTurnTime(at(14, 32), null, TODAY)).toBe('14:32');
    expect(formatChatTurnTime(at(9, 5), null, TODAY)).toBe('09:05');
  });
});

describe('[#2458] unusable input degrades quietly', () => {
  it('renders nothing at all for an unusable end', () => {
    expect(formatChatTurnTime(new Date('nonsense'), at(18, 18), TODAY)).toBe('');
    expect(formatChatTurnTime(undefined as unknown as Date, null, TODAY)).toBe('');
    expect(formatChatTurnTime('2026-09-07T18:33:00' as unknown as Date, null, TODAY)).toBe('');
  });

  it('treats an unusable start as an absent one, and still renders the end', () => {
    expect(formatChatTurnTime(at(18, 33), new Date('nonsense'), TODAY)).toBe('18:33');
    expect(formatChatTurnTime(at(18, 33), 0 as unknown as Date, TODAY)).toBe('18:33');
  });

  it('never renders the string "Invalid Date"', () => {
    const outputs = [
      formatChatTurnTime(new Date('nonsense'), new Date('nonsense'), TODAY),
      formatChatTurnTime(at(18, 33), new Date('nonsense'), TODAY),
      formatChatTurnTime(new Date('nonsense'), at(18, 18), TODAY),
    ];
    for (const output of outputs) expect(output).not.toContain('Invalid');
  });
});
