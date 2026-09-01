/**
 * `?view=` deep-link boundary in useWorktreeTabState (Issue #2193).
 *
 * Mirrors `useWorktreeTabState.test.ts`'s treatment of `?pane=`: the raw query
 * value never leaves the hook, and anything that is not a declared SurfaceMode
 * resolves to `'terminal'`.
 *
 * ## Mutation check (acceptance criterion)
 *
 * Replacing `isSurfaceMode` in `src/types/ui-state.ts` with `() => true` must
 * turn this file red — specifically the "invalid", "XSS" and "empty" cases,
 * which would then return the raw string instead of `'terminal'`. That is what
 * distinguishes a real boundary from a test that passes because the fallback is
 * also the default.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const mockSearchParams = new URLSearchParams();
const mockReplace = vi.fn();
vi.mock('next/navigation', () => ({
  useSearchParams: () => mockSearchParams,
  useRouter: () => ({ replace: mockReplace }),
  usePathname: () => '/worktrees/test-id',
}));

import { useWorktreeTabState } from '@/hooks/useWorktreeTabState';

describe('[#2193] useWorktreeTabState ?view= boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParams.delete('pane');
    mockSearchParams.delete('view');
  });

  it('defaults to terminal when ?view= is absent', () => {
    const { result } = renderHook(() => useWorktreeTabState());
    expect(result.current.surfaceMode).toBe('terminal');
  });

  it.each(['terminal', 'chat'] as const)('accepts ?view=%s', (mode) => {
    mockSearchParams.set('view', mode);
    const { result } = renderHook(() => useWorktreeTabState());
    expect(result.current.surfaceMode).toBe(mode);
  });

  it.each([
    ['an unknown mode', 'xterm'],
    ['a pane name', 'history'],
    ['wrong case', 'Chat'],
    ['an empty value', ''],
    ['an XSS attempt', '<script>alert(1)</script>'],
    ['a prototype key', '__proto__'],
  ])('falls back to terminal for %s', (_label, raw) => {
    mockSearchParams.set('view', raw);
    const { result } = renderHook(() => useWorktreeTabState());
    expect(result.current.surfaceMode).toBe('terminal');
  });

  it('composes with ?pane= rather than replacing it', () => {
    mockSearchParams.set('pane', 'files');
    mockSearchParams.set('view', 'chat');
    const { result } = renderHook(() => useWorktreeTabState());
    expect(result.current.activePane).toBe('files');
    expect(result.current.surfaceMode).toBe('chat');
  });

  it('leaves ?view= untouched when only the pane is invalid, and vice versa', () => {
    mockSearchParams.set('pane', 'not-a-pane');
    mockSearchParams.set('view', 'chat');
    const { result } = renderHook(() => useWorktreeTabState());
    expect(result.current.activePane).toBe('terminal');
    expect(result.current.surfaceMode).toBe('chat');
  });

  describe('setSurfaceMode()', () => {
    it('replaces the URL with scroll:false', () => {
      const { result } = renderHook(() => useWorktreeTabState());
      act(() => {
        result.current.setSurfaceMode('chat');
      });
      expect(mockReplace).toHaveBeenCalledWith(
        expect.stringContaining('view=chat'),
        { scroll: false }
      );
    });

    it('keeps an existing ?pane= in the URL it writes', () => {
      mockSearchParams.set('pane', 'files');
      const { result } = renderHook(() => useWorktreeTabState());
      act(() => {
        result.current.setSurfaceMode('chat');
      });
      const [url] = mockReplace.mock.calls[0] as [string];
      expect(url).toContain('pane=files');
      expect(url).toContain('view=chat');
    });

    it('does nothing when the mode is already active', () => {
      // Default is terminal.
      const { result } = renderHook(() => useWorktreeTabState());
      act(() => {
        result.current.setSurfaceMode('terminal');
      });
      expect(mockReplace).not.toHaveBeenCalled();
    });

    it('setPane keeps an existing ?view= in the URL it writes', () => {
      mockSearchParams.set('view', 'chat');
      const { result } = renderHook(() => useWorktreeTabState());
      act(() => {
        result.current.setPane('files');
      });
      const [url] = mockReplace.mock.calls[0] as [string];
      expect(url).toContain('view=chat');
      expect(url).toContain('pane=files');
    });
  });
});
