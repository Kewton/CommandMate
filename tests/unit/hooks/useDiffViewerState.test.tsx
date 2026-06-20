/**
 * Unit tests for useDiffViewerState (Issue #923).
 *
 * Verifies the PC right-pane diff viewer state extracted from
 * useWorktreeDetailController: open/close on PC, and the mobile no-op (mobile
 * renders the diff inline within GitPane instead).
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDiffViewerState } from '@/hooks/useDiffViewerState';

describe('useDiffViewerState (Issue #923)', () => {
  it('starts with no diff open', () => {
    const { result } = renderHook(() => useDiffViewerState(false));

    expect(result.current.diffContent).toBeNull();
    expect(result.current.diffFilePath).toBeNull();
  });

  it('PC: handleDiffSelect sets content and path', () => {
    const { result } = renderHook(() => useDiffViewerState(false));

    act(() => result.current.handleDiffSelect('diff text', 'src/a.ts'));

    expect(result.current.diffContent).toBe('diff text');
    expect(result.current.diffFilePath).toBe('src/a.ts');
  });

  it('PC: handleCloseDiff clears content and path', () => {
    const { result } = renderHook(() => useDiffViewerState(false));

    act(() => result.current.handleDiffSelect('diff text', 'src/a.ts'));
    act(() => result.current.handleCloseDiff());

    expect(result.current.diffContent).toBeNull();
    expect(result.current.diffFilePath).toBeNull();
  });

  it('mobile: handleDiffSelect is a no-op (diff shown inline in GitPane)', () => {
    const { result } = renderHook(() => useDiffViewerState(true));

    act(() => result.current.handleDiffSelect('diff text', 'src/a.ts'));

    expect(result.current.diffContent).toBeNull();
    expect(result.current.diffFilePath).toBeNull();
  });

  it('handleCloseDiff keeps a stable identity across renders', () => {
    const { result, rerender } = renderHook(
      ({ isMobile }: { isMobile: boolean }) => useDiffViewerState(isMobile),
      { initialProps: { isMobile: false } },
    );

    const first = result.current.handleCloseDiff;
    rerender({ isMobile: false });
    expect(result.current.handleCloseDiff).toBe(first);
  });
});
