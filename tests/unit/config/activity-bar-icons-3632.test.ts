/**
 * ACTIVITIES icons (Issue #2616, restored by Issue #3632).
 *
 * At 20px the single-sheet `File` the file tree used to show and the
 * `StickyNote` of notes were the same dog-eared page. Moved from the deleted
 * ActivityBar.test.tsx (#3620): these check the config, not the component.
 */

import { describe, it, expect } from 'vitest';
import { Files, StickyNote } from 'lucide-react';
import { ACTIVITIES, type ActivityDefinition } from '@/config/activity-bar-config';

function hasDuplicateIcons(list: readonly ActivityDefinition[]): boolean {
  const icons = list.map((a) => a.icon);
  return new Set(icons).size !== icons.length;
}

describe('ACTIVITIES icons (Issue #2616)', () => {
  it('configures the file tree with the two-sheet `Files` icon', () => {
    const files = ACTIVITIES.find((a) => a.id === 'files');
    expect(files?.icon).toBe(Files);
  });

  it('keeps the file tree and notes on different icons', () => {
    const files = ACTIVITIES.find((a) => a.id === 'files');
    const notes = ACTIVITIES.find((a) => a.id === 'notes');
    expect(notes?.icon).toBe(StickyNote);
    expect(files?.icon).not.toBe(notes?.icon);
  });

  it('uses no icon twice across the activities', () => {
    const icons = ACTIVITIES.map((a) => a.icon);
    expect(new Set(icons).size).toBe(icons.length);
    expect(icons).toHaveLength(10);
    expect(hasDuplicateIcons(ACTIVITIES)).toBe(false);
  });

  it('detects a duplicated icon (positive control on a copy, config untouched)', () => {
    const broken = ACTIVITIES.map((a) => (a.id === 'files' ? { ...a, icon: StickyNote } : a));
    expect(hasDuplicateIcons(broken)).toBe(true);
  });
});
