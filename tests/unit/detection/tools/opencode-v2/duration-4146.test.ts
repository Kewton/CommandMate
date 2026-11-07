/**
 * Issue #4146: every duration OpenCode V2 can draw on its finished-turn row, as
 * V1 reads them since #4134. The forms are read off the 2.0.18 executable; the
 * hour and day forms have no captured frame (未測定), so those rows are built here
 * from the measured `turn-done` frame.
 *
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeFrame } from '@/lib/detection/tools/frame';
import {
  endsWithTurnComplete,
  OPENCODE_V2_TURN_COMPLETE_PATTERN,
  opencodeV2StatusDetector,
} from '@/lib/detection/tools/opencode-v2/detect';

const TURN_DONE = readFileSync(
  join(resolve(__dirname, '../../../../fixtures/opencode-v2-live-2934'), 'turn-done.txt'),
  'utf8'
);
const row = (duration: string, tail = ' · 8.1 tok/s'): string => `     Build · LongCat 2.5 Preview Free · ${duration}${tail}`;

/** The measured frame, with its completion row's duration replaced. */
function frameWithDuration(duration: string): string {
  const next = TURN_DONE.replace(/ · \d[\d.]*s · /, ` · ${duration} · `);
  expect(next).not.toBe(TURN_DONE);
  return next;
}

describe('the finished-turn row', () => {
  it.each(['836ms', '5.2s', '1m 5s', '2m 4s', '1h 5m', '1h 0m', '2d 3h', '12d 0h'])('reads %s', (duration) => {
    expect(OPENCODE_V2_TURN_COMPLETE_PATTERN.test(row(duration))).toBe(true);
    expect(OPENCODE_V2_TURN_COMPLETE_PATTERN.test(row(duration, ''))).toBe(true);
  });

  it.each(['1h', '2d', '1.5h 5m', '1h 5', '1h 5s', '2d 3m', '1h5m', '1h 5m extra', '5 hours'])(
    'does not read %s',
    (duration) => {
      expect(OPENCODE_V2_TURN_COMPLETE_PATTERN.test(row(duration))).toBe(false);
    }
  );
});

describe('a turn of an hour or more, on the measured frame', () => {
  it.each(['1h 5m', '2d 3h'])('%s is a finished turn, as a shorter one is', (duration) => {
    const frame = normalizeFrame(frameWithDuration(duration));
    expect(endsWithTurnComplete(frame)).toBe(true);
    const shorter = opencodeV2StatusDetector.detect(normalizeFrame(TURN_DONE));
    expect(opencodeV2StatusDetector.detect(frame).status).toBe(shorter.status);
    expect(opencodeV2StatusDetector.detect(frame).reason).toBe(shorter.reason);
  });
});
