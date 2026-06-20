/**
 * Tests for GitPaneContext (Issue #922).
 *
 * The ambient config (isMobile / onDiffSelect / onInsertToMessage) the panels
 * read instead of prop-drilling. The consumer hook MUST throw when used outside a
 * provider, and MUST return the provided value inside one.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, renderHook } from '@testing-library/react';
import {
  GitPaneProvider,
  useGitPaneContext,
  type GitPaneContextValue,
} from '@/components/worktree/git/GitPaneContext';

describe('GitPaneContext (Issue #922)', () => {
  it('throws when useGitPaneContext is used outside a provider', () => {
    // Silence the expected React error boundary console noise.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => renderHook(() => useGitPaneContext())).toThrow(
      /must be used within a GitPaneProvider/
    );
    spy.mockRestore();
  });

  it('provides the value to consumers', () => {
    const onDiffSelect = vi.fn();
    const onInsertToMessage = vi.fn();
    const value: GitPaneContextValue = { isMobile: true, onDiffSelect, onInsertToMessage };

    function Consumer() {
      const ctx = useGitPaneContext();
      return (
        <div>
          <span data-testid="is-mobile">{String(ctx.isMobile)}</span>
          <button onClick={() => ctx.onDiffSelect('d', 'f')}>diff</button>
        </div>
      );
    }

    render(
      <GitPaneProvider value={value}>
        <Consumer />
      </GitPaneProvider>
    );

    expect(screen.getByTestId('is-mobile').textContent).toBe('true');
    screen.getByText('diff').click();
    expect(onDiffSelect).toHaveBeenCalledWith('d', 'f');
  });
});
