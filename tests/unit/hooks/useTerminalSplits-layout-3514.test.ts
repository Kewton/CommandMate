/**
 * Issue #3514: `setSplitCount` (the Action bar's layout icons) and
 * `openInstanceInNewSplit` (the header "+" with the `new-split` placement).
 *
 * Both are built from the same append / drop steps `addSplit` / `removeSplit`
 * use, so the negative controls here pin that the 2x2 grid, its equal widths
 * and the maximize reset are exactly what those produce.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useTerminalSplits } from '@/hooks/useTerminalSplits';
import { clearTerminalSplitsLocalStorage } from '@tests/helpers/terminal-splits';
import type { AgentInstance } from '@/lib/cli-tools/types';

const ROSTER: AgentInstance[] = [
  { id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 },
  { id: 'codex', cliTool: 'codex', alias: 'Codex', order: 1 },
  { id: 'gemini', cliTool: 'gemini', alias: 'Gemini', order: 2 },
  { id: 'claude-2', cliTool: 'claude', alias: 'Review', order: 3 },
  { id: 'copilot', cliTool: 'copilot', alias: 'Copilot', order: 4 },
];

describe('[#3514] useTerminalSplits.setSplitCount', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    clearTerminalSplitsLocalStorage();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
    clearTerminalSplitsLocalStorage();
  });

  it('jumps straight from 1 to the 2x2 grid with equal widths and rows', () => {
    const { result } = renderHook(() => useTerminalSplits('w-1', ROSTER));
    act(() => result.current.setSplitCount(4));
    expect(result.current.splits.map((s) => s.instanceId)).toEqual([
      'claude',
      'codex',
      'gemini',
      'claude-2',
    ]);
    expect(result.current.widths).toEqual([0.25, 0.25, 0.25, 0.25]);
    expect(result.current.rowHeights).toEqual([0.5, 0.5]);
  });

  it('matches pressing add the same number of times (negative control)', () => {
    const viaAdd = renderHook(() => useTerminalSplits('w-a', ROSTER));
    act(() => viaAdd.result.current.addSplit());
    act(() => viaAdd.result.current.addSplit());
    const viaCount = renderHook(() => useTerminalSplits('w-b', ROSTER));
    act(() => viaCount.result.current.setSplitCount(3));
    expect(viaCount.result.current.splits).toEqual(viaAdd.result.current.splits);
    expect(viaCount.result.current.widths).toEqual(viaAdd.result.current.widths);
  });

  it('drops splits off the end and leaves the grid when going down', () => {
    const { result } = renderHook(() => useTerminalSplits('w-1', ROSTER));
    act(() => result.current.setSplitCount(4));
    act(() => result.current.setSplitCount(2));
    expect(result.current.splits.map((s) => s.instanceId)).toEqual(['claude', 'codex']);
    const sum = result.current.widths.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1);
    const stored = JSON.parse(window.localStorage.getItem('commandmate:terminalSplits:w-1')!);
    expect(Object.keys(stored)).not.toContain('rowHeights');
  });

  it('is capped by the roster size (one distinct instance per split)', () => {
    const two = ROSTER.slice(0, 2);
    const { result } = renderHook(() => useTerminalSplits('w-1', two));
    act(() => result.current.setSplitCount(4));
    expect(result.current.splits).toHaveLength(2);
  });

  it('clears a maximized split when the count changes, and is a no-op otherwise', () => {
    const { result } = renderHook(() => useTerminalSplits('w-1', ROSTER));
    act(() => result.current.setSplitCount(2));
    act(() => result.current.toggleMaximize(1));
    act(() => result.current.setSplitCount(2)); // same count
    expect(result.current.maximizedIndex).toBe(1);
    act(() => result.current.setSplitCount(3));
    expect(result.current.maximizedIndex).toBeNull();
  });
});

describe('[#3514] useTerminalSplits.openInstanceInNewSplit', () => {
  beforeEach(() => clearTerminalSplitsLocalStorage());
  afterEach(() => clearTerminalSplitsLocalStorage());

  it('appends a split showing exactly that instance', () => {
    const { result } = renderHook(() => useTerminalSplits('w-1', ROSTER));
    let ok = false;
    act(() => {
      ok = result.current.openInstanceInNewSplit('claude-2');
    });
    expect(ok).toBe(true);
    expect(result.current.splits.map((s) => s.instanceId)).toEqual(['claude', 'claude-2']);
    expect(result.current.splits[1].cliToolId).toBe('claude');
  });

  it('refuses at MAX_SPLITS, for an unknown id, and for an instance already shown', () => {
    const { result } = renderHook(() => useTerminalSplits('w-1', ROSTER));
    expect(result.current.openInstanceInNewSplit('nope')).toBe(false);
    expect(result.current.openInstanceInNewSplit('claude')).toBe(false);
    act(() => result.current.setSplitCount(4));
    expect(result.current.openInstanceInNewSplit('copilot')).toBe(false);
    expect(result.current.splits).toHaveLength(4);
  });
});
