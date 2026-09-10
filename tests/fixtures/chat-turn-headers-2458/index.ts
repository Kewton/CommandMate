/**
 * The six-row column Issue #2458's acceptance names.
 *
 * SYNTHETIC — see `./README.md` for what each row is for, why the timestamps
 * carry no timezone, and why this fixture is hand-written where its #2245
 * sibling is a verbatim capture.
 */

import type { ChatMessage } from '@/types/models';
import rows from './turn-headers.json';

/** A row as the API serializes it: `timestamp` is a string, not a `Date`. */
type RawMessage = Omit<ChatMessage, 'timestamp'> & { timestamp: string };

/**
 * The column, hydrated the way `ChatTranscript` receives it.
 *
 * A fresh array of fresh objects on every call, so a suite that mutates a row
 * to build a variant — flipping `archived`, dropping a `requestId` — cannot
 * leak that into the next test.
 */
export function turnHeaderMessages(): ChatMessage[] {
  return (rows as RawMessage[]).map((row) => ({
    ...row,
    timestamp: new Date(row.timestamp),
  }));
}

/** The instant every row in the fixture was written on, as a local `Date`. */
export const TURN_HEADERS_DAY = new Date(2026, 8, 7);

/** A `now` on the fixture's own day, for `vi.setSystemTime`. */
export const TURN_HEADERS_NOW = new Date(2026, 8, 7, 22, 0, 0);
