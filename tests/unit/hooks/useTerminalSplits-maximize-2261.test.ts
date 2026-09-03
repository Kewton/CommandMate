/**
 * Issue #2261: temporarily maximizing one split.
 *
 * The whole point of the feature is that it is TEMPORARY, which in state terms
 * means two things this file pins:
 *   - `maximizedIndex` never reaches localStorage (a reload comes back to the
 *     split layout the user built), and
 *   - every gesture that changes what the split row IS — add, remove, equalize,
 *     switch worktree — drops it, so a maximized index can never outlive the
 *     layout it described.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useTerminalSplits } from '@/hooks/useTerminalSplits';
import { clearTerminalSplitsLocalStorage } from '@tests/helpers/terminal-splits';
import { getTerminalSplitsStorageKey } from '@/config/terminal-split-config';
import type { AgentInstance } from '@/lib/cli-tools/types';

const ROSTER: AgentInstance[] = [
  { id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 },
  { id: 'codex', cliTool: 'codex', alias: 'Codex', order: 1 },
  { id: 'gemini', cliTool: 'gemini', alias: 'Gemini', order: 2 },
];

describe('[#2261] useTerminalSplits maximize', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clearTerminalSplitsLocalStorage();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
    clearTerminalSplitsLocalStorage();
  });

  it('starts with nothing maximized', () => {
    const { result } = renderHook(() => useTerminalSplits('w-1', ROSTER));
    expect(result.current.maximizedIndex).toBeNull();
  });

  it('toggleMaximize(i) maximizes i, and toggling the same index restores', () => {
    const { result } = renderHook(() => useTerminalSplits('w-1', ROSTER));
    act(() => result.current.addSplit()); // -> 2 splits

    act(() => result.current.toggleMaximize(1));
    expect(result.current.maximizedIndex).toBe(1);

    act(() => result.current.toggleMaximize(1));
    expect(result.current.maximizedIndex).toBeNull();
  });

  it('maximizing a DIFFERENT split moves the maximized index rather than restoring', () => {
    const { result } = renderHook(() => useTerminalSplits('w-1', ROSTER));
    act(() => result.current.addSplit());
    act(() => result.current.addSplit()); // -> 3 splits

    act(() => result.current.toggleMaximize(2));
    act(() => result.current.toggleMaximize(0));
    expect(result.current.maximizedIndex).toBe(0);
  });

  it('ignores an out-of-range index', () => {
    const { result } = renderHook(() => useTerminalSplits('w-1', ROSTER));
    act(() => result.current.toggleMaximize(5));
    expect(result.current.maximizedIndex).toBeNull();
    act(() => result.current.toggleMaximize(-1));
    expect(result.current.maximizedIndex).toBeNull();
  });

  it('leaves widths untouched, so restoring returns the exact ratios', () => {
    const { result } = renderHook(() => useTerminalSplits('w-1', ROSTER));
    act(() => result.current.addSplit());
    act(() => result.current.setSplitWidth([0.7, 0.3]));

    act(() => result.current.toggleMaximize(0));
    expect(result.current.widths).toEqual([0.7, 0.3]);

    act(() => result.current.toggleMaximize(0));
    expect(result.current.widths).toEqual([0.7, 0.3]);
  });

  describe('release conditions', () => {
    it('addSplit releases it', () => {
      const { result } = renderHook(() => useTerminalSplits('w-1', ROSTER));
      act(() => result.current.addSplit());
      act(() => result.current.toggleMaximize(1));
      expect(result.current.maximizedIndex).toBe(1);

      act(() => result.current.addSplit()); // -> 3 splits
      expect(result.current.maximizedIndex).toBeNull();
    });

    it('removeSplit releases it even when the maximized index SURVIVES the removal', () => {
      // The one case a "clamp the index into range" implementation would miss:
      // split 0 still exists after removing split 1, so only an explicit release
      // in removeSplit turns this null.
      const { result } = renderHook(() => useTerminalSplits('w-1', ROSTER));
      act(() => result.current.addSplit()); // -> 2 splits
      act(() => result.current.toggleMaximize(0));
      expect(result.current.maximizedIndex).toBe(0);

      act(() => result.current.removeSplit()); // -> 1 split; index 0 still exists
      expect(result.current.maximizedIndex).toBeNull();
    });

    it('removeSplit releases it when the maximized index itself disappears', () => {
      const { result } = renderHook(() => useTerminalSplits('w-1', ROSTER));
      act(() => result.current.addSplit()); // -> 2 splits
      act(() => result.current.toggleMaximize(1));
      expect(result.current.maximizedIndex).toBe(1);

      act(() => result.current.removeSplit()); // -> 1 split; index 1 is gone
      expect(result.current.maximizedIndex).toBeNull();
    });

    it('resetWidths (the equalize button) releases it', () => {
      const { result } = renderHook(() => useTerminalSplits('w-1', ROSTER));
      act(() => result.current.addSplit());
      act(() => result.current.toggleMaximize(1));

      act(() => result.current.resetWidths());
      expect(result.current.maximizedIndex).toBeNull();
    });

    it('switching worktree releases it', () => {
      const { result, rerender } = renderHook(
        ({ id }: { id: string }) => useTerminalSplits(id, ROSTER),
        { initialProps: { id: 'w-1' } },
      );
      act(() => result.current.addSplit());
      act(() => result.current.toggleMaximize(1));
      expect(result.current.maximizedIndex).toBe(1);

      rerender({ id: 'w-2' });
      expect(result.current.maximizedIndex).toBeNull();
    });

    it('a roster shrink that drops the maximized split releases it', () => {
      // #869/#898 reconcile trims the split count without anyone pressing
      // "remove"; a stale index would hide every remaining split.
      const { result, rerender } = renderHook(
        ({ roster }: { roster: AgentInstance[] }) => useTerminalSplits('w-1', roster),
        { initialProps: { roster: ROSTER } },
      );
      act(() => result.current.addSplit()); // -> 2 splits
      act(() => result.current.toggleMaximize(1));
      expect(result.current.maximizedIndex).toBe(1);

      rerender({ roster: [ROSTER[0]] }); // only one instance left -> one split
      expect(result.current.splits).toHaveLength(1);
      expect(result.current.maximizedIndex).toBeNull();
    });
  });

  describe('persistence', () => {
    it('never writes maximizedIndex into the terminal-splits storage key', () => {
      const { result } = renderHook(() => useTerminalSplits('w-1', ROSTER));
      act(() => result.current.addSplit());
      act(() => result.current.toggleMaximize(1));
      expect(result.current.maximizedIndex).toBe(1);

      const raw = window.localStorage.getItem(getTerminalSplitsStorageKey('w-1'));
      expect(raw).toBeTruthy();
      expect(raw).not.toContain('maximizedIndex');
      expect(Object.keys(JSON.parse(raw as string)).sort()).toEqual(['splits', 'widths']);
    });

    it('comes back un-maximized on a remount (what a page reload does)', () => {
      const first = renderHook(() => useTerminalSplits('w-1', ROSTER));
      act(() => first.result.current.addSplit());
      act(() => first.result.current.toggleMaximize(1));
      first.unmount();

      const second = renderHook(() => useTerminalSplits('w-1', ROSTER));
      // The layout survives...
      expect(second.result.current.splits).toHaveLength(2);
      // ...the maximize does not.
      expect(second.result.current.maximizedIndex).toBeNull();
    });
  });
});
