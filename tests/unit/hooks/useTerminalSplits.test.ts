/**
 * Tests for useTerminalSplits hook (Issue #728)
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useTerminalSplits } from '@/hooks/useTerminalSplits';
import {
  clearTerminalSplitsLocalStorage,
  mockTerminalSplitsLocalStorage,
  readTerminalSplitsLocalStorage,
} from '@tests/helpers/terminal-splits';
import { getTerminalSplitsStorageKey } from '@/config/terminal-split-config';

describe('useTerminalSplits', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clearTerminalSplitsLocalStorage();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    clearTerminalSplitsLocalStorage();
  });

  it('initializes with DEFAULT_SPLIT_CONFIG when nothing is stored', () => {
    const { result } = renderHook(() => useTerminalSplits('w-1'));
    expect(result.current.splits).toEqual([{ cliToolId: 'claude' }]);
    expect(result.current.widths).toEqual([1]);
    expect(result.current.focusedSplitIndex).toBe(0);
  });

  it('restores a valid stored config', () => {
    mockTerminalSplitsLocalStorage('w-1', {
      splits: [{ cliToolId: 'claude' }, { cliToolId: 'codex' }],
      widths: [0.6, 0.4],
    });
    const { result } = renderHook(() => useTerminalSplits('w-1'));
    expect(result.current.splits).toEqual([
      { cliToolId: 'claude' },
      { cliToolId: 'codex' },
    ]);
    expect(result.current.widths).toEqual([0.6, 0.4]);
  });

  it('falls back to DEFAULT when stored splits.length=4', () => {
    mockTerminalSplitsLocalStorage('w-1', {
      splits: [
        { cliToolId: 'claude' },
        { cliToolId: 'codex' },
        { cliToolId: 'gemini' },
        { cliToolId: 'copilot' },
      ],
      widths: [1, 1, 1, 1],
    });
    const { result } = renderHook(() => useTerminalSplits('w-1'));
    expect(result.current.splits).toEqual([{ cliToolId: 'claude' }]);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('falls back to DEFAULT when stored splits.length=0', () => {
    mockTerminalSplitsLocalStorage('w-1', { splits: [], widths: [] });
    const { result } = renderHook(() => useTerminalSplits('w-1'));
    expect(result.current.splits).toEqual([{ cliToolId: 'claude' }]);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('falls back when widths.length !== splits.length', () => {
    mockTerminalSplitsLocalStorage('w-1', {
      splits: [{ cliToolId: 'claude' }, { cliToolId: 'codex' }],
      widths: [1],
    });
    const { result } = renderHook(() => useTerminalSplits('w-1'));
    expect(result.current.splits).toEqual([{ cliToolId: 'claude' }]);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('falls back when widths contain NaN / negative / 0', () => {
    mockTerminalSplitsLocalStorage('w-1', {
      splits: [{ cliToolId: 'claude' }, { cliToolId: 'codex' }],
      widths: [1, Number.NaN],
    });
    const { result: r1 } = renderHook(() => useTerminalSplits('w-1'));
    expect(r1.current.splits).toEqual([{ cliToolId: 'claude' }]);

    mockTerminalSplitsLocalStorage('w-2', {
      splits: [{ cliToolId: 'claude' }, { cliToolId: 'codex' }],
      widths: [1, 0],
    });
    const { result: r2 } = renderHook(() => useTerminalSplits('w-2'));
    expect(r2.current.splits).toEqual([{ cliToolId: 'claude' }]);

    mockTerminalSplitsLocalStorage('w-3', {
      splits: [{ cliToolId: 'claude' }, { cliToolId: 'codex' }],
      widths: [1, -0.2],
    });
    const { result: r3 } = renderHook(() => useTerminalSplits('w-3'));
    expect(r3.current.splits).toEqual([{ cliToolId: 'claude' }]);
  });

  it('falls back when stored JSON is malformed', () => {
    mockTerminalSplitsLocalStorage('w-1', '{not json');
    const { result } = renderHook(() => useTerminalSplits('w-1'));
    expect(result.current.splits).toEqual([{ cliToolId: 'claude' }]);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('addSplit grows to MAX_SPLITS and then no-ops', () => {
    const { result } = renderHook(() => useTerminalSplits('w-1'));

    act(() => result.current.addSplit());
    expect(result.current.splits).toHaveLength(2);

    act(() => result.current.addSplit());
    expect(result.current.splits).toHaveLength(3);

    // upper bound
    act(() => result.current.addSplit());
    expect(result.current.splits).toHaveLength(3);
  });

  it('addSplit picks an unused CLI tool for the new split', () => {
    const { result } = renderHook(() => useTerminalSplits('w-1'));
    act(() => result.current.addSplit());
    const second = result.current.splits[1].cliToolId;
    expect(second).not.toBe(result.current.splits[0].cliToolId);

    act(() => result.current.addSplit());
    const third = result.current.splits[2].cliToolId;
    expect(third).not.toBe(result.current.splits[0].cliToolId);
    expect(third).not.toBe(result.current.splits[1].cliToolId);
  });

  it('addSplit halves the last existing width and assigns the same to the new one', () => {
    const { result } = renderHook(() => useTerminalSplits('w-1'));
    // initial widths: [1]
    act(() => result.current.addSplit());
    expect(result.current.widths).toHaveLength(2);
    // last existing was 1 → halved to 0.5 plus new 0.5
    expect(result.current.widths[0]).toBeCloseTo(0.5);
    expect(result.current.widths[1]).toBeCloseTo(0.5);
    // ratio sanity: every width is finite > 0
    for (const w of result.current.widths) {
      expect(Number.isFinite(w)).toBe(true);
      expect(w).toBeGreaterThan(0);
    }
  });

  it('removeSplit shrinks to MIN_SPLITS and then no-ops', () => {
    const { result } = renderHook(() => useTerminalSplits('w-1'));
    act(() => result.current.addSplit());
    act(() => result.current.addSplit());
    expect(result.current.splits).toHaveLength(3);

    act(() => result.current.removeSplit());
    expect(result.current.splits).toHaveLength(2);

    act(() => result.current.removeSplit());
    expect(result.current.splits).toHaveLength(1);

    act(() => result.current.removeSplit());
    expect(result.current.splits).toHaveLength(1);
  });

  it('setSplitCliTool updates only the indexed split', () => {
    const { result } = renderHook(() => useTerminalSplits('w-1'));
    act(() => result.current.addSplit());

    act(() => result.current.setSplitCliTool(0, 'gemini'));
    expect(result.current.splits[0].cliToolId).toBe('gemini');
    // second untouched
    const secondBefore = result.current.splits[1].cliToolId;
    expect(secondBefore).not.toBe('gemini');
  });

  it('setSplitCliTool refuses a CLI already used by another split', () => {
    const { result } = renderHook(() => useTerminalSplits('w-1'));
    act(() => result.current.addSplit());
    const second = result.current.splits[1].cliToolId;

    // attempt to set index 0 to the cli already in index 1
    act(() => result.current.setSplitCliTool(0, second));
    expect(result.current.splits[0].cliToolId).not.toBe(second);
  });

  it('setSplitWidth replaces widths but leaves splits intact', () => {
    const { result } = renderHook(() => useTerminalSplits('w-1'));
    act(() => result.current.addSplit());
    const splitsBefore = result.current.splits;
    act(() => result.current.setSplitWidth([0.3, 0.7]));
    expect(result.current.widths).toEqual([0.3, 0.7]);
    expect(result.current.splits).toEqual(splitsBefore);
  });

  it('setSplitWidth ignores invalid input (wrong length / non-positive)', () => {
    const { result } = renderHook(() => useTerminalSplits('w-1'));
    act(() => result.current.addSplit());
    const widthsBefore = result.current.widths;
    act(() => result.current.setSplitWidth([1]));
    expect(result.current.widths).toEqual(widthsBefore);
    act(() => result.current.setSplitWidth([0, 1]));
    expect(result.current.widths).toEqual(widthsBefore);
    act(() => result.current.setSplitWidth([Number.NaN, 1]));
    expect(result.current.widths).toEqual(widthsBefore);
  });

  it('availableCliTools excludes CLI used by other splits but allows the current split CLI', () => {
    const { result } = renderHook(() => useTerminalSplits('w-1'));
    act(() => result.current.addSplit());
    const [a, b] = result.current.splits;
    const availableFor0 = result.current.availableCliTools(0);
    expect(availableFor0).toContain(a.cliToolId); // self ok
    expect(availableFor0).not.toContain(b.cliToolId);
  });

  it('focusedSplitIndex starts at 0 and is settable', () => {
    const { result } = renderHook(() => useTerminalSplits('w-1'));
    expect(result.current.focusedSplitIndex).toBe(0);
    act(() => result.current.addSplit());
    act(() => result.current.setFocusedSplitIndex(1));
    expect(result.current.focusedSplitIndex).toBe(1);
  });

  it('focusedSplitIndex clamps when splits shrink below it', () => {
    const { result } = renderHook(() => useTerminalSplits('w-1'));
    act(() => result.current.addSplit()); // -> 2
    act(() => result.current.addSplit()); // -> 3
    act(() => result.current.setFocusedSplitIndex(2));
    expect(result.current.focusedSplitIndex).toBe(2);
    act(() => result.current.removeSplit()); // -> 2; focused should clamp to 1
    expect(result.current.focusedSplitIndex).toBe(1);
    act(() => result.current.removeSplit()); // -> 1; focused should clamp to 0
    expect(result.current.focusedSplitIndex).toBe(0);
  });

  it('1->2->3->2->1 preserves existing index CLI selections', () => {
    const { result } = renderHook(() => useTerminalSplits('w-1'));
    // 1 -> 2
    act(() => result.current.addSplit());
    act(() => result.current.setSplitCliTool(1, 'codex'));
    // 2 -> 3
    act(() => result.current.addSplit());
    act(() => result.current.setSplitCliTool(2, 'gemini'));
    expect(result.current.splits.map(s => s.cliToolId)).toEqual([
      'claude', 'codex', 'gemini',
    ]);
    // 3 -> 2 (drops last)
    act(() => result.current.removeSplit());
    expect(result.current.splits.map(s => s.cliToolId)).toEqual([
      'claude', 'codex',
    ]);
    // 2 -> 1
    act(() => result.current.removeSplit());
    expect(result.current.splits.map(s => s.cliToolId)).toEqual(['claude']);
  });

  it('persists state to localStorage on every change', () => {
    const { result } = renderHook(() => useTerminalSplits('w-1'));
    act(() => result.current.addSplit());

    const stored = readTerminalSplitsLocalStorage('w-1');
    expect(stored).not.toBeNull();
    expect(stored?.splits).toHaveLength(2);

    act(() => result.current.setSplitCliTool(0, 'gemini'));
    const stored2 = readTerminalSplitsLocalStorage('w-1');
    expect(stored2?.splits[0].cliToolId).toBe('gemini');
  });

  it('uses worktreeId-scoped storage key', () => {
    const { result: r1 } = renderHook(() => useTerminalSplits('w-1'));
    act(() => r1.current.addSplit());
    expect(window.localStorage.getItem(getTerminalSplitsStorageKey('w-1'))).not.toBeNull();
    expect(window.localStorage.getItem(getTerminalSplitsStorageKey('w-2'))).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Issue #739: removeSplit must re-normalize widths so their sum stays ~1.0.
  // A sum < 1 makes the lone flex child (flex-grow < 1, flex-basis: 0) occupy
  // only that fraction of the container, leaving empty space.
  // NOTE: assert with toBeCloseTo, never `=== 1.0` — normalized IEEE754 sums
  // are not guaranteed to equal exactly 1.0 (design review S3-001).
  // ---------------------------------------------------------------------------
  const sum = (ws: number[]) => ws.reduce((s, w) => s + w, 0);

  it('removeSplit re-normalizes widths to sum ~1.0 (3->2->1)', () => {
    const { result } = renderHook(() => useTerminalSplits('w-1'));
    act(() => result.current.addSplit()); // 1 -> 2: widths [0.5, 0.5]
    act(() => result.current.addSplit()); // 2 -> 3: widths [0.5, 0.25, 0.25]
    expect(sum(result.current.widths)).toBeCloseTo(1);

    act(() => result.current.removeSplit()); // 3 -> 2
    expect(result.current.widths).toHaveLength(2);
    expect(sum(result.current.widths)).toBeCloseTo(1);

    act(() => result.current.removeSplit()); // 2 -> 1
    expect(result.current.widths).toHaveLength(1);
    expect(sum(result.current.widths)).toBeCloseTo(1);
    // Single remaining split must occupy full width.
    expect(result.current.widths[0]).toBeCloseTo(1);
  });

  it('removeSplit preserves the ratio of the remaining widths', () => {
    const { result } = renderHook(() => useTerminalSplits('w-1'));
    act(() => result.current.addSplit());
    act(() => result.current.addSplit());
    // Set a known, non-uniform ratio across 3 splits (sum = 1.0).
    act(() => result.current.setSplitWidth([0.6, 0.3, 0.1]));
    expect(sum(result.current.widths)).toBeCloseTo(1);

    // Drop last -> remaining [0.6, 0.3] (sum 0.9) re-normalized to sum 1.0,
    // keeping the 2:1 ratio between the first two splits.
    act(() => result.current.removeSplit());
    expect(result.current.widths).toHaveLength(2);
    expect(sum(result.current.widths)).toBeCloseTo(1);
    expect(result.current.widths[0] / result.current.widths[1]).toBeCloseTo(2);
  });

  it('self-heals a persisted single-split width of 0.5 to 1.0 on load', () => {
    // Valid per isValidSplitConfig (length matches, width > 0) but sum=0.5 —
    // exactly the bad state an existing user gets after the buggy removeSplit.
    mockTerminalSplitsLocalStorage('w-heal', {
      splits: [{ cliToolId: 'claude' }],
      widths: [0.5],
    });
    const { result } = renderHook(() => useTerminalSplits('w-heal'));
    expect(result.current.splits).toEqual([{ cliToolId: 'claude' }]);
    expect(result.current.widths[0]).toBeCloseTo(1);
    expect(sum(result.current.widths)).toBeCloseTo(1);
  });

  it('self-heals a persisted multi-split width that sums below 1.0 on load', () => {
    mockTerminalSplitsLocalStorage('w-heal2', {
      splits: [{ cliToolId: 'claude' }, { cliToolId: 'codex' }],
      widths: [0.25, 0.25], // valid (both > 0) but sum = 0.5
    });
    const { result } = renderHook(() => useTerminalSplits('w-heal2'));
    expect(result.current.splits).toHaveLength(2);
    expect(sum(result.current.widths)).toBeCloseTo(1);
    // Equal inputs stay equal after normalization.
    expect(result.current.widths[0]).toBeCloseTo(0.5);
    expect(result.current.widths[1]).toBeCloseTo(0.5);
  });

  it('leaves an already-normalized stored config unchanged on load (no-op)', () => {
    mockTerminalSplitsLocalStorage('w-noop', {
      splits: [{ cliToolId: 'claude' }, { cliToolId: 'codex' }],
      widths: [0.6, 0.4], // sum = 1.0
    });
    const { result } = renderHook(() => useTerminalSplits('w-noop'));
    expect(result.current.widths[0]).toBeCloseTo(0.6);
    expect(result.current.widths[1]).toBeCloseTo(0.4);
    expect(sum(result.current.widths)).toBeCloseTo(1);
  });
});
