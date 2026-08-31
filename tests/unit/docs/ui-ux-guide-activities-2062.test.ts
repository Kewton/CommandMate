/**
 * `docs/UI_UX_GUIDE.md`'s Activity Bar list matches `ACTIVITIES` (Issue #2062).
 *
 * ## What this catches
 *
 * The guide said "6 Activity: Files / Git / Notes / Schedules / Agent / Timer"
 * while `src/config/activity-bar-config.ts` had ten entries — `todo` (#1015),
 * `skills` (#1441), `verification` (#1816) and `env` (#1968) had all shipped
 * without the doc following. Nothing reported it, because prose about a
 * constant is invisible to tsc, lint and the unit suite alike.
 *
 * ## Why the ids and not just the count
 *
 * A count alone goes green if somebody adds an activity and deletes another, or
 * renames one. The list in the guide is described there as a *copy* of
 * `ACTIVITIES`, so the assertion is the copy relation itself: same ids, same
 * order, same length — and the order matters twice over, because it is the
 * ArrowUp/ArrowDown navigation order the guide documents two lines below.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { ACTIVITIES } from '@/config/activity-bar-config';

const GUIDE_PATH = path.resolve(__dirname, '../../../docs/UI_UX_GUIDE.md');

/**
 * The guide writes each activity as `  N. \`<id>\` — <label>`. The id is
 * back-ticked precisely so a reader (and this test) can tell the identifier
 * from the human label beside it.
 */
const ACTIVITY_LINE = /^\s+\d+\.\s+`([a-z-]+)`\s+—/;

function documentedActivityIds(): string[] {
  return readFileSync(GUIDE_PATH, 'utf-8')
    .split('\n')
    .map((line) => ACTIVITY_LINE.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => match[1]);
}

describe('docs/UI_UX_GUIDE.md Activity Bar list (Issue #2062)', () => {
  it('lists exactly the activities ACTIVITIES declares, in the same order', () => {
    expect(documentedActivityIds()).toEqual(ACTIVITIES.map((activity) => activity.id));
  });

  it('states the same count in prose as the list carries', () => {
    const guide = readFileSync(GUIDE_PATH, 'utf-8');
    expect(guide).toContain(`${ACTIVITIES.length} Activity`);
    // The stale sentence this Issue replaced, pinned so it cannot come back.
    expect(guide).not.toContain('6 Activity: Files / Git / Notes / Schedules / Agent / Timer');
  });

  it('names activity-bar-config.ts as the single source', () => {
    expect(readFileSync(GUIDE_PATH, 'utf-8')).toContain('src/config/activity-bar-config.ts');
  });
});
