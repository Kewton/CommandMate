/**
 * Tests for useTerminalSplits hook (Issue #728, instance-keyed in Issue #869)
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
import type { AgentInstance } from '@/lib/cli-tools/types';

// Standard 4-instance roster (all primaries: id === cliTool). Issue #869: the
// hook is instance-keyed, so tests pass an explicit roster.
const ROSTER: AgentInstance[] = [
  { id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 },
  { id: 'codex', cliTool: 'codex', alias: 'Codex', order: 1 },
  { id: 'gemini', cliTool: 'gemini', alias: 'Gemini', order: 2 },
  { id: 'copilot', cliTool: 'copilot', alias: 'Copilot', order: 3 },
];

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

  it('initializes with the first roster instance when nothing is stored', () => {
    const { result } = renderHook(() => useTerminalSplits('w-1', ROSTER));
    expect(result.current.splits).toEqual([{ cliToolId: 'claude', instanceId: 'claude' }]);
    expect(result.current.widths).toEqual([1]);
    expect(result.current.focusedSplitIndex).toBe(0);
  });

  it('restores a valid stored config (legacy entries migrate to primary instanceIds)', () => {
    mockTerminalSplitsLocalStorage('w-1', {
      splits: [{ cliToolId: 'claude' }, { cliToolId: 'codex' }],
      widths: [0.6, 0.4],
    });
    const { result } = renderHook(() => useTerminalSplits('w-1', ROSTER));
    expect(result.current.splits).toEqual([
      { cliToolId: 'claude', instanceId: 'claude' },
      { cliToolId: 'codex', instanceId: 'codex' },
    ]);
    expect(result.current.widths).toEqual([0.6, 0.4]);
  });

  it('restores instance-keyed entries (explicit instanceId preserved)', () => {
    mockTerminalSplitsLocalStorage('w-1', {
      splits: [
        { cliToolId: 'claude', instanceId: 'claude' },
        { cliToolId: 'codex', instanceId: 'codex' },
      ],
      widths: [0.5, 0.5],
    });
    const { result } = renderHook(() => useTerminalSplits('w-1', ROSTER));
    expect(result.current.splits).toEqual([
      { cliToolId: 'claude', instanceId: 'claude' },
      { cliToolId: 'codex', instanceId: 'codex' },
    ]);
  });

  it('falls back to default when stored splits.length=4', () => {
    mockTerminalSplitsLocalStorage('w-1', {
      splits: [
        { cliToolId: 'claude' },
        { cliToolId: 'codex' },
        { cliToolId: 'gemini' },
        { cliToolId: 'copilot' },
      ],
      widths: [1, 1, 1, 1],
    });
    const { result } = renderHook(() => useTerminalSplits('w-1', ROSTER));
    expect(result.current.splits).toEqual([{ cliToolId: 'claude', instanceId: 'claude' }]);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('falls back to default when stored splits.length=0', () => {
    mockTerminalSplitsLocalStorage('w-1', { splits: [], widths: [] });
    const { result } = renderHook(() => useTerminalSplits('w-1', ROSTER));
    expect(result.current.splits).toEqual([{ cliToolId: 'claude', instanceId: 'claude' }]);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('falls back when widths.length !== splits.length', () => {
    mockTerminalSplitsLocalStorage('w-1', {
      splits: [{ cliToolId: 'claude' }, { cliToolId: 'codex' }],
      widths: [1],
    });
    const { result } = renderHook(() => useTerminalSplits('w-1', ROSTER));
    expect(result.current.splits).toEqual([{ cliToolId: 'claude', instanceId: 'claude' }]);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('falls back when widths contain NaN / negative / 0', () => {
    mockTerminalSplitsLocalStorage('w-1', {
      splits: [{ cliToolId: 'claude' }, { cliToolId: 'codex' }],
      widths: [1, Number.NaN],
    });
    const { result: r1 } = renderHook(() => useTerminalSplits('w-1', ROSTER));
    expect(r1.current.splits).toEqual([{ cliToolId: 'claude', instanceId: 'claude' }]);

    mockTerminalSplitsLocalStorage('w-2', {
      splits: [{ cliToolId: 'claude' }, { cliToolId: 'codex' }],
      widths: [1, 0],
    });
    const { result: r2 } = renderHook(() => useTerminalSplits('w-2', ROSTER));
    expect(r2.current.splits).toEqual([{ cliToolId: 'claude', instanceId: 'claude' }]);

    mockTerminalSplitsLocalStorage('w-3', {
      splits: [{ cliToolId: 'claude' }, { cliToolId: 'codex' }],
      widths: [1, -0.2],
    });
    const { result: r3 } = renderHook(() => useTerminalSplits('w-3', ROSTER));
    expect(r3.current.splits).toEqual([{ cliToolId: 'claude', instanceId: 'claude' }]);
  });

  it('falls back when stored JSON is malformed', () => {
    mockTerminalSplitsLocalStorage('w-1', '{not json');
    const { result } = renderHook(() => useTerminalSplits('w-1', ROSTER));
    expect(result.current.splits).toEqual([{ cliToolId: 'claude', instanceId: 'claude' }]);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('addSplit grows to MAX_SPLITS and then no-ops', () => {
    const { result } = renderHook(() => useTerminalSplits('w-1', ROSTER));

    act(() => result.current.addSplit());
    expect(result.current.splits).toHaveLength(2);

    act(() => result.current.addSplit());
    expect(result.current.splits).toHaveLength(3);

    // upper bound
    act(() => result.current.addSplit());
    expect(result.current.splits).toHaveLength(3);
  });

  it('addSplit no-ops when no spare instance remains', () => {
    // Roster has exactly one instance → cannot add a second distinct split.
    const single: AgentInstance[] = [{ id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 }];
    const { result } = renderHook(() => useTerminalSplits('w-1', single));
    act(() => result.current.addSplit());
    expect(result.current.splits).toHaveLength(1);
  });

  it('addSplit picks an unused instance for the new split', () => {
    const { result } = renderHook(() => useTerminalSplits('w-1', ROSTER));
    act(() => result.current.addSplit());
    const second = result.current.splits[1].instanceId;
    expect(second).not.toBe(result.current.splits[0].instanceId);

    act(() => result.current.addSplit());
    const third = result.current.splits[2].instanceId;
    expect(third).not.toBe(result.current.splits[0].instanceId);
    expect(third).not.toBe(result.current.splits[1].instanceId);
  });

  it('addSplit halves the last existing width and assigns the same to the new one', () => {
    const { result } = renderHook(() => useTerminalSplits('w-1', ROSTER));
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
    const { result } = renderHook(() => useTerminalSplits('w-1', ROSTER));
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

  it('setSplitInstance updates only the indexed split', () => {
    const { result } = renderHook(() => useTerminalSplits('w-1', ROSTER));
    act(() => result.current.addSplit());

    act(() => result.current.setSplitInstance(0, 'gemini'));
    expect(result.current.splits[0].instanceId).toBe('gemini');
    expect(result.current.splits[0].cliToolId).toBe('gemini');
    // second untouched
    const secondBefore = result.current.splits[1].instanceId;
    expect(secondBefore).not.toBe('gemini');
  });

  it('setSplitInstance refuses an instance already used by another split', () => {
    const { result } = renderHook(() => useTerminalSplits('w-1', ROSTER));
    act(() => result.current.addSplit());
    const second = result.current.splits[1].instanceId;

    // attempt to set index 0 to the instance already in index 1
    act(() => result.current.setSplitInstance(0, second));
    expect(result.current.splits[0].instanceId).not.toBe(second);
  });

  // ---------------------------------------------------------------------------
  // Issue #786 (D-1 / S3-005): setSplitInstance returns a boolean so the drop
  // handler in TerminalSplitContainer has a single source of truth for whether
  // the change was actually applied (success toast + active-instance sync only
  // when applied; no double-judgment desync with the hook's silent no-op guard).
  // ---------------------------------------------------------------------------
  it('setSplitInstance returns true when the change is applied', () => {
    const { result } = renderHook(() => useTerminalSplits('w-1', ROSTER));
    act(() => result.current.addSplit());

    let applied: boolean | undefined;
    act(() => {
      applied = result.current.setSplitInstance(0, 'gemini');
    });
    expect(applied).toBe(true);
    expect(result.current.splits[0].instanceId).toBe('gemini');
  });

  it('setSplitInstance returns false when the instance collides with another split', () => {
    const { result } = renderHook(() => useTerminalSplits('w-1', ROSTER));
    act(() => result.current.addSplit());
    const second = result.current.splits[1].instanceId;

    let applied: boolean | undefined;
    act(() => {
      applied = result.current.setSplitInstance(0, second);
    });
    expect(applied).toBe(false);
    expect(result.current.splits[0].instanceId).not.toBe(second);
  });

  it('setSplitInstance returns false when assigning the split its CURRENT instance (no-op)', () => {
    const { result } = renderHook(() => useTerminalSplits('w-1', ROSTER));
    const current = result.current.splits[0].instanceId;

    let applied: boolean | undefined;
    act(() => {
      applied = result.current.setSplitInstance(0, current);
    });
    expect(applied).toBe(false);
    expect(result.current.splits[0].instanceId).toBe(current);
  });

  it('setSplitInstance returns false for an out-of-range index', () => {
    const { result } = renderHook(() => useTerminalSplits('w-1', ROSTER));
    let applied: boolean | undefined;
    act(() => {
      applied = result.current.setSplitInstance(5, 'gemini');
    });
    expect(applied).toBe(false);
  });

  it('setSplitInstance returns false for an unknown instance id', () => {
    const { result } = renderHook(() => useTerminalSplits('w-1', ROSTER));
    let applied: boolean | undefined;
    act(() => {
      applied = result.current.setSplitInstance(0, 'does-not-exist');
    });
    expect(applied).toBe(false);
  });

  it('setSplitWidth replaces widths but leaves splits intact', () => {
    const { result } = renderHook(() => useTerminalSplits('w-1', ROSTER));
    act(() => result.current.addSplit());
    const splitsBefore = result.current.splits;
    act(() => result.current.setSplitWidth([0.3, 0.7]));
    expect(result.current.widths).toEqual([0.3, 0.7]);
    expect(result.current.splits).toEqual(splitsBefore);
  });

  it('setSplitWidth ignores invalid input (wrong length / non-positive)', () => {
    const { result } = renderHook(() => useTerminalSplits('w-1', ROSTER));
    act(() => result.current.addSplit());
    const widthsBefore = result.current.widths;
    act(() => result.current.setSplitWidth([1]));
    expect(result.current.widths).toEqual(widthsBefore);
    act(() => result.current.setSplitWidth([0, 1]));
    expect(result.current.widths).toEqual(widthsBefore);
    act(() => result.current.setSplitWidth([Number.NaN, 1]));
    expect(result.current.widths).toEqual(widthsBefore);
  });

  it('availableInstanceIds excludes instances used by other splits but allows the current split instance', () => {
    const { result } = renderHook(() => useTerminalSplits('w-1', ROSTER));
    act(() => result.current.addSplit());
    const [a, b] = result.current.splits;
    const availableFor0 = result.current.availableInstanceIds(0);
    expect(availableFor0).toContain(a.instanceId); // self ok
    expect(availableFor0).not.toContain(b.instanceId);
  });

  it('focusedSplitIndex starts at 0 and is settable', () => {
    const { result } = renderHook(() => useTerminalSplits('w-1', ROSTER));
    expect(result.current.focusedSplitIndex).toBe(0);
    act(() => result.current.addSplit());
    act(() => result.current.setFocusedSplitIndex(1));
    expect(result.current.focusedSplitIndex).toBe(1);
  });

  it('focusedSplitIndex clamps when splits shrink below it', () => {
    const { result } = renderHook(() => useTerminalSplits('w-1', ROSTER));
    act(() => result.current.addSplit()); // -> 2
    act(() => result.current.addSplit()); // -> 3
    act(() => result.current.setFocusedSplitIndex(2));
    expect(result.current.focusedSplitIndex).toBe(2);
    act(() => result.current.removeSplit()); // -> 2; focused should clamp to 1
    expect(result.current.focusedSplitIndex).toBe(1);
    act(() => result.current.removeSplit()); // -> 1; focused should clamp to 0
    expect(result.current.focusedSplitIndex).toBe(0);
  });

  it('1->2->3->2->1 preserves existing index instance selections', () => {
    const { result } = renderHook(() => useTerminalSplits('w-1', ROSTER));
    // 1 -> 2
    act(() => result.current.addSplit());
    act(() => result.current.setSplitInstance(1, 'codex'));
    // 2 -> 3
    act(() => result.current.addSplit());
    act(() => result.current.setSplitInstance(2, 'gemini'));
    expect(result.current.splits.map(s => s.instanceId)).toEqual([
      'claude', 'codex', 'gemini',
    ]);
    // 3 -> 2 (drops last)
    act(() => result.current.removeSplit());
    expect(result.current.splits.map(s => s.instanceId)).toEqual([
      'claude', 'codex',
    ]);
    // 2 -> 1
    act(() => result.current.removeSplit());
    expect(result.current.splits.map(s => s.instanceId)).toEqual(['claude']);
  });

  // ---------------------------------------------------------------------------
  // Issue #869: two instances of the SAME CLI tool (claude + claude-2) can
  // occupy separate splits — the split identity is the instanceId, not the
  // backing CLI tool.
  // ---------------------------------------------------------------------------
  it('allows two instances of the same CLI tool in separate splits', () => {
    const dualClaude: AgentInstance[] = [
      { id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 },
      { id: 'claude-2', cliTool: 'claude', alias: 'Claude (review)', order: 1 },
    ];
    const { result } = renderHook(() => useTerminalSplits('w-dual', dualClaude));
    act(() => result.current.addSplit());
    expect(result.current.splits).toHaveLength(2);
    expect(result.current.splits.map(s => s.instanceId)).toEqual(['claude', 'claude-2']);
    // Both splits back the same CLI tool.
    expect(result.current.splits.every(s => s.cliToolId === 'claude')).toBe(true);
  });

  it('persists state to localStorage on every change', () => {
    const { result } = renderHook(() => useTerminalSplits('w-1', ROSTER));
    act(() => result.current.addSplit());

    const stored = readTerminalSplitsLocalStorage('w-1');
    expect(stored).not.toBeNull();
    expect(stored?.splits).toHaveLength(2);

    act(() => result.current.setSplitInstance(0, 'gemini'));
    const stored2 = readTerminalSplitsLocalStorage('w-1');
    expect(stored2?.splits[0].cliToolId).toBe('gemini');
    expect(stored2?.splits[0].instanceId).toBe('gemini');
  });

  it('uses worktreeId-scoped storage key', () => {
    const { result: r1 } = renderHook(() => useTerminalSplits('w-1', ROSTER));
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
    const { result } = renderHook(() => useTerminalSplits('w-1', ROSTER));
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
    const { result } = renderHook(() => useTerminalSplits('w-1', ROSTER));
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
    const { result } = renderHook(() => useTerminalSplits('w-heal', ROSTER));
    expect(result.current.splits).toEqual([{ cliToolId: 'claude', instanceId: 'claude' }]);
    expect(result.current.widths[0]).toBeCloseTo(1);
    expect(sum(result.current.widths)).toBeCloseTo(1);
  });

  it('self-heals a persisted multi-split width that sums below 1.0 on load', () => {
    mockTerminalSplitsLocalStorage('w-heal2', {
      splits: [{ cliToolId: 'claude' }, { cliToolId: 'codex' }],
      widths: [0.25, 0.25], // valid (both > 0) but sum = 0.5
    });
    const { result } = renderHook(() => useTerminalSplits('w-heal2', ROSTER));
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
    const { result } = renderHook(() => useTerminalSplits('w-noop', ROSTER));
    expect(result.current.widths[0]).toBeCloseTo(0.6);
    expect(result.current.widths[1]).toBeCloseTo(0.4);
    expect(sum(result.current.widths)).toBeCloseTo(1);
  });

  // ---------------------------------------------------------------------------
  // Issue #861: resetWidths() equalizes the visible split widths to 1/n while
  // leaving the splits / instance assignments untouched. Sum stays ~1.0.
  // ---------------------------------------------------------------------------
  describe('resetWidths (Issue #861)', () => {
    it('equalizes 3 unequal widths to 1/3 each (sum ~1.0)', () => {
      const { result } = renderHook(() => useTerminalSplits('w-1', ROSTER));
      act(() => result.current.addSplit()); // -> 2
      act(() => result.current.addSplit()); // -> 3
      act(() => result.current.setSplitWidth([0.6, 0.3, 0.1]));

      act(() => result.current.resetWidths());
      expect(result.current.widths).toHaveLength(3);
      for (const w of result.current.widths) {
        expect(w).toBeCloseTo(1 / 3);
      }
      expect(sum(result.current.widths)).toBeCloseTo(1);
    });

    it('equalizes 2 unequal widths to 0.5 each', () => {
      const { result } = renderHook(() => useTerminalSplits('w-1', ROSTER));
      act(() => result.current.addSplit());
      act(() => result.current.setSplitWidth([0.8, 0.2]));

      act(() => result.current.resetWidths());
      expect(result.current.widths[0]).toBeCloseTo(0.5);
      expect(result.current.widths[1]).toBeCloseTo(0.5);
    });

    it('keeps a single split at width 1 (no-op for n=1)', () => {
      const { result } = renderHook(() => useTerminalSplits('w-1', ROSTER));
      act(() => result.current.resetWidths());
      expect(result.current.widths).toEqual([1]);
    });

    it('leaves splits / instance assignments untouched', () => {
      const { result } = renderHook(() => useTerminalSplits('w-1', ROSTER));
      act(() => result.current.addSplit());
      act(() => result.current.setSplitInstance(1, 'codex'));
      const splitsBefore = result.current.splits;

      act(() => result.current.resetWidths());
      expect(result.current.splits).toEqual(splitsBefore);
    });

    it('persists the equalized widths to localStorage', () => {
      const { result } = renderHook(() => useTerminalSplits('w-1', ROSTER));
      act(() => result.current.addSplit());
      act(() => result.current.setSplitWidth([0.8, 0.2]));

      act(() => result.current.resetWidths());
      const stored = readTerminalSplitsLocalStorage('w-1');
      expect(stored?.widths).toHaveLength(2);
      expect(stored?.widths[0]).toBeCloseTo(0.5);
      expect(stored?.widths[1]).toBeCloseTo(0.5);
    });
  });
});
