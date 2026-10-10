/**
 * Issue #3514: the layout icons and the header "+" placement rules.
 *
 * The one rule the Issue asks to be fixed by a test: at the split ceiling
 * `new-split` cannot be chosen and the "+" form starts on `replace`.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import {
  AGENT_PLACEMENTS,
  MAX_SPLITS,
  MIN_SPLITS,
  SPLIT_LAYOUT_COUNTS,
  isAgentPlacementAvailable,
  resolveDefaultAgentPlacement,
} from '@/config/terminal-split-config';

describe('[#3514] split layout icons', () => {
  it('offers one icon per split count, MIN..MAX, in order', () => {
    expect(SPLIT_LAYOUT_COUNTS).toEqual([1, 2, 3, 4]);
    expect(SPLIT_LAYOUT_COUNTS[0]).toBe(MIN_SPLITS);
    expect(SPLIT_LAYOUT_COUNTS[SPLIT_LAYOUT_COUNTS.length - 1]).toBe(MAX_SPLITS);
  });
});

describe('[#3514] agent placement', () => {
  it('lists new split / replace / add only, in that order', () => {
    expect(AGENT_PLACEMENTS).toEqual(['new-split', 'replace', 'roster-only']);
  });

  it('defaults to a new split while there is room', () => {
    for (let count = MIN_SPLITS; count < MAX_SPLITS; count++) {
      expect(resolveDefaultAgentPlacement(count)).toBe('new-split');
      expect(isAgentPlacementAvailable('new-split', count)).toBe(true);
    }
  });

  it('at the ceiling, new split cannot be chosen and the default is replace', () => {
    expect(isAgentPlacementAvailable('new-split', MAX_SPLITS)).toBe(false);
    expect(resolveDefaultAgentPlacement(MAX_SPLITS)).toBe('replace');
  });

  it('replace and add only are always available', () => {
    for (const count of [MIN_SPLITS, 2, 3, MAX_SPLITS]) {
      expect(isAgentPlacementAvailable('replace', count)).toBe(true);
      expect(isAgentPlacementAvailable('roster-only', count)).toBe(true);
    }
  });
});
