/**
 * Issue #3612: a lone split can never enter the maximized state (source of
 * truth for the bar, the "…" menu and Mod+Shift+Enter alike).
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
];

describe('[#3612] maximize with a single split', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    clearTerminalSplitsLocalStorage();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
    clearTerminalSplitsLocalStorage();
  });

  it('toggleMaximize(0) does not enter the state with one split', () => {
    const { result } = renderHook(() => useTerminalSplits('w-3612', ROSTER));
    expect(result.current.splits).toHaveLength(1);
    act(() => result.current.toggleMaximize(0));
    expect(result.current.maximizedIndex).toBeNull();
  });

  it('still maximizes and restores with two splits (negative control)', () => {
    const { result } = renderHook(() => useTerminalSplits('w-3612', ROSTER));
    act(() => result.current.addSplit());
    act(() => result.current.toggleMaximize(0));
    expect(result.current.maximizedIndex).toBe(0);
    act(() => result.current.toggleMaximize(0));
    expect(result.current.maximizedIndex).toBeNull();
  });

  it('leaves no maximized state after closing down to one split', () => {
    const { result } = renderHook(() => useTerminalSplits('w-3612', ROSTER));
    act(() => result.current.addSplit());
    act(() => result.current.toggleMaximize(0));
    act(() => result.current.removeSplit());
    expect(result.current.splits).toHaveLength(1);
    expect(result.current.maximizedIndex).toBeNull();
  });
});
