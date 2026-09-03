/**
 * `useSplitSurfaceModes` — the Action bar's view of each split's output surface
 * (Issue #2259).
 *
 * The bar disables its History toggle while every split is in chat mode, and
 * the modes live one level BELOW it (each `TerminalSplitPaneContent` owns its
 * own). This hook is the seam: persisted values on mount, a CustomEvent for
 * every later change. Two properties are load-bearing and each fails silently
 * if it regresses —
 *
 *  1. an event for a DIFFERENT worktree must not move this worktree's verdict
 *     (two sessions can be mounted while a sidebar switch is in flight), and
 *  2. an index outside the current split count must be ignored rather than
 *     grow the array, or removing a split would leave a phantom mode behind
 *     and pin the toggle to the wrong verdict.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import {
  useSplitSurfaceModes,
  emitSurfaceModeChange,
  SURFACE_MODE_CHANGE_EVENT,
} from '@/hooks/useSplitSurfaceModes';
import { getSplitSurfaceModeStorageKey } from '@/config/surface-mode-config';

function Probe({ worktreeId, splitCount }: { worktreeId: string; splitCount: number }) {
  const modes = useSplitSurfaceModes(worktreeId, splitCount);
  return <div data-testid="modes">{modes.join(',')}</div>;
}

function modes(): string {
  return screen.getByTestId('modes').textContent ?? '';
}

describe('[#2259] useSplitSurfaceModes', () => {
  beforeEach(() => {
    window.localStorage.clear();
    // The config module fires a background settings fetch on read; keep it off
    // the network and out of the test's way.
    global.fetch = vi.fn(() =>
      Promise.resolve({ ok: true, json: async () => ({}) }),
    ) as unknown as typeof fetch;
    window.history.replaceState({}, '', '/');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it('defaults every split to the terminal surface with nothing persisted', () => {
    render(<Probe worktreeId="w-1" splitCount={3} />);
    expect(modes()).toBe('terminal,terminal,terminal');
  });

  it('reads what each split persisted', () => {
    window.localStorage.setItem(getSplitSurfaceModeStorageKey('w-1', 0), 'chat');
    window.localStorage.setItem(getSplitSurfaceModeStorageKey('w-1', 1), 'terminal');
    render(<Probe worktreeId="w-1" splitCount={2} />);
    expect(modes()).toBe('chat,terminal');
  });

  it('applies a broadcast change for this worktree', () => {
    render(<Probe worktreeId="w-1" splitCount={2} />);
    act(() => {
      emitSurfaceModeChange({ worktreeId: 'w-1', splitIndex: 1, mode: 'chat' });
    });
    expect(modes()).toBe('terminal,chat');
  });

  it('ignores a broadcast for a different worktree', () => {
    render(<Probe worktreeId="w-1" splitCount={2} />);
    act(() => {
      emitSurfaceModeChange({ worktreeId: 'w-2', splitIndex: 0, mode: 'chat' });
    });
    expect(modes()).toBe('terminal,terminal');
  });

  it('ignores a broadcast for a split index it does not have', () => {
    render(<Probe worktreeId="w-1" splitCount={1} />);
    act(() => {
      emitSurfaceModeChange({ worktreeId: 'w-1', splitIndex: 2, mode: 'chat' });
    });
    expect(modes()).toBe('terminal');
  });

  it('survives a detail-less event without throwing', () => {
    render(<Probe worktreeId="w-1" splitCount={1} />);
    act(() => {
      window.dispatchEvent(new Event(SURFACE_MODE_CHANGE_EVENT));
    });
    expect(modes()).toBe('terminal');
  });

  it('re-reads storage when the split count grows', () => {
    window.localStorage.setItem(getSplitSurfaceModeStorageKey('w-1', 1), 'chat');
    const { rerender } = render(<Probe worktreeId="w-1" splitCount={1} />);
    expect(modes()).toBe('terminal');
    rerender(<Probe worktreeId="w-1" splitCount={2} />);
    expect(modes()).toBe('terminal,chat');
  });

  it('re-reads storage when the worktree changes', () => {
    window.localStorage.setItem(getSplitSurfaceModeStorageKey('w-2', 0), 'chat');
    const { rerender } = render(<Probe worktreeId="w-1" splitCount={1} />);
    expect(modes()).toBe('terminal');
    rerender(<Probe worktreeId="w-2" splitCount={1} />);
    expect(modes()).toBe('chat');
  });
});
