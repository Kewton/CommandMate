/**
 * CopyButton Component Tests (Issue #981)
 *
 * Covers the shared copy button extracted from AssistantMessageList:
 * - Default / custom label rendering
 * - Custom className passthrough (used for absolute positioning over code)
 * - Clipboard copy on click
 * - Copy -> Copied -> Copy feedback transition (1.5s reset)
 * - Timer cleanup safety on unmount
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { CopyButton } from '@/components/common/CopyButton';

// Hoisted mock for clipboard-utils (vi.mock factory is hoisted above imports)
const { mockCopyToClipboard } = vi.hoisted(() => ({
  mockCopyToClipboard: vi.fn(),
}));

vi.mock('@/lib/clipboard-utils', () => ({
  copyToClipboard: mockCopyToClipboard,
}));

// Must match COPY_FEEDBACK_RESET_SHORT_MS in src/config/ui-feedback-config.ts
const COPY_FEEDBACK_RESET_SHORT_MS = 1500;

describe('CopyButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCopyToClipboard.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders with the default "Copy" label', () => {
    render(<CopyButton text="hello" />);
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
  });

  it('renders a custom label', () => {
    render(<CopyButton text="hello" label="Copy code" />);
    expect(screen.getByRole('button', { name: 'Copy code' })).toBeInTheDocument();
  });

  it('appends a custom className to the button', () => {
    render(<CopyButton text="hello" className="absolute right-2 top-2" />);
    const button = screen.getByRole('button', { name: 'Copy' });
    expect(button).toHaveClass('absolute', 'right-2', 'top-2');
  });

  it('copies the provided text to the clipboard on click', async () => {
    render(<CopyButton text="const x = 1;" />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
    });
    expect(mockCopyToClipboard).toHaveBeenCalledWith('const x = 1;');
  });

  it('shows "Copied" feedback after a successful copy', async () => {
    render(<CopyButton text="hello" />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
    });
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy' })).not.toBeInTheDocument();
  });

  describe('feedback reset timer', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('reverts to "Copy" after the feedback duration', async () => {
      render(<CopyButton text="hello" />);
      await act(async () => {
        fireEvent.click(screen.getByRole('button'));
      });
      expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();

      await act(async () => {
        vi.advanceTimersByTime(COPY_FEEDBACK_RESET_SHORT_MS);
      });
      expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Copied' })).not.toBeInTheDocument();
    });

    it('does not throw when unmounted during feedback (timer cleanup)', async () => {
      const { unmount } = render(<CopyButton text="hello" />);
      await act(async () => {
        fireEvent.click(screen.getByRole('button'));
      });

      expect(() => unmount()).not.toThrow();
      // The cleared timer must not fire a state update after unmount.
      expect(() => {
        vi.advanceTimersByTime(COPY_FEEDBACK_RESET_SHORT_MS);
      }).not.toThrow();
    });
  });
});
