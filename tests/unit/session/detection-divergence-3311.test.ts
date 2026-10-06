/**
 * Issue #3311: the per-target record of when the current disagreement between
 * the screen and the agent began.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { resetDetectionDivergenceTracking, trackDetectionDivergence } from '@/lib/session/detection-divergence';

beforeEach(() => resetDetectionDivergenceTracking());

describe('trackDetectionDivergence (Issue #3311)', () => {
  it('reports the length from the first diverging poll to the first agreeing one, once', () => {
    expect(trackDetectionDivergence('wt-1', 'claude', 'claude', true, 1_000)).toBeNull();
    expect(trackDetectionDivergence('wt-1', 'claude', 'claude', true, 3_000)).toBeNull();
    expect(trackDetectionDivergence('wt-1', 'claude', 'claude', true, 5_000)).toBeNull();

    expect(trackDetectionDivergence('wt-1', 'claude', 'claude', false, 6_500)).toEqual({ durationMs: 5_500, polls: 3 });
    expect(trackDetectionDivergence('wt-1', 'claude', 'claude', false, 8_000)).toBeNull();
  });

  it('keeps each instance apart', () => {
    trackDetectionDivergence('wt-1', 'claude', 'claude', true, 1_000);
    trackDetectionDivergence('wt-1', 'claude', 'cc-2', true, 2_000);

    expect(trackDetectionDivergence('wt-1', 'claude', 'cc-2', false, 2_500)).toEqual({ durationMs: 500, polls: 1 });
    expect(trackDetectionDivergence('wt-1', 'claude', 'claude', true, 3_000)).toBeNull();
    expect(trackDetectionDivergence('wt-1', 'claude', 'claude', false, 4_000)).toEqual({ durationMs: 3_000, polls: 2 });
  });

  it('reports nothing for polls that always agreed (control)', () => {
    expect(trackDetectionDivergence('wt-1', 'codex', 'codex', false, 1_000)).toBeNull();
    expect(trackDetectionDivergence('wt-1', 'codex', 'codex', false, 2_000)).toBeNull();
  });
});
