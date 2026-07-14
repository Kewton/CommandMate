/**
 * Tests for history virtualization helpers (Issue #1123)
 */
import { describe, it, expect } from 'vitest';
import {
  isNearBottom,
  HISTORY_STICK_TO_BOTTOM_THRESHOLD_PX,
  HISTORY_VIRTUAL_OVERSCAN,
  HISTORY_ESTIMATED_PAIR_HEIGHT_PX,
} from '@/lib/history-virtualization';

describe('history-virtualization constants', () => {
  it('exposes sane tuning defaults', () => {
    expect(HISTORY_VIRTUAL_OVERSCAN).toBeGreaterThan(0);
    expect(HISTORY_ESTIMATED_PAIR_HEIGHT_PX).toBeGreaterThan(0);
    expect(HISTORY_STICK_TO_BOTTOM_THRESHOLD_PX).toBeGreaterThan(0);
  });
});

describe('isNearBottom (follow/maintain decision)', () => {
  it('returns true when scrolled to the exact bottom', () => {
    // scrollTop === scrollHeight - clientHeight → distance 0
    expect(
      isNearBottom({ scrollTop: 900, scrollHeight: 1500, clientHeight: 600 })
    ).toBe(true);
  });

  it('returns true when within the stick threshold of the bottom (follow)', () => {
    // distance = 1500 - (900 - 40) - 600 = 40 <= threshold
    expect(
      isNearBottom(
        { scrollTop: 860, scrollHeight: 1500, clientHeight: 600 },
        HISTORY_STICK_TO_BOTTOM_THRESHOLD_PX
      )
    ).toBe(true);
  });

  it('returns false when scrolled up beyond the threshold (maintain)', () => {
    // distance = 1500 - 100 - 600 = 800 > threshold
    expect(
      isNearBottom({ scrollTop: 100, scrollHeight: 1500, clientHeight: 600 })
    ).toBe(false);
  });

  it('honors a custom threshold', () => {
    const metrics = { scrollTop: 700, scrollHeight: 1500, clientHeight: 600 };
    // distance = 200
    expect(isNearBottom(metrics, 150)).toBe(false);
    expect(isNearBottom(metrics, 250)).toBe(true);
  });

  it('treats non-finite geometry as "not at bottom" (never yanks position)', () => {
    expect(
      isNearBottom({ scrollTop: NaN, scrollHeight: 1500, clientHeight: 600 })
    ).toBe(false);
  });
});
