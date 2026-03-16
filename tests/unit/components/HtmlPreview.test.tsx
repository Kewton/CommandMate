/**
 * Unit Tests for HtmlPreview Component - postMessage link handling
 *
 * Issue #505: HTML preview link navigation via postMessage
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, cleanup } from '@testing-library/react';
import { HtmlPreview } from '@/components/worktree/HtmlPreview';

// Mock window.confirm for interactive mode
const confirmSpy = vi.spyOn(window, 'confirm');

describe('HtmlPreview - postMessage link handling', () => {
  const defaultProps = {
    worktreeId: 'test-wt',
    filePath: 'docs/index.html',
    htmlContent: '<html><body><a href="./readme.md">link</a></body></html>',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    confirmSpy.mockReturnValue(true);
  });

  afterEach(() => {
    cleanup();
  });

  /** Helper to switch to interactive mode */
  function switchToInteractive() {
    const interactiveButton = screen.getByText('Interactive');
    act(() => {
      interactiveButton.click();
    });
  }

  it('should listen for postMessage in interactive mode', () => {
    const onOpenFile = vi.fn();
    const addEventSpy = vi.spyOn(window, 'addEventListener');

    render(<HtmlPreview {...defaultProps} onOpenFile={onOpenFile} />);
    switchToInteractive();

    expect(addEventSpy).toHaveBeenCalledWith(
      'message',
      expect.any(Function),
    );
  });

  it('should call onOpenFile for relative path postMessage', () => {
    const onOpenFile = vi.fn();
    render(<HtmlPreview {...defaultProps} onOpenFile={onOpenFile} />);
    switchToInteractive();

    act(() => {
      const event = new MessageEvent('message', {
        data: { type: 'commandmate:link-click', href: './readme.md' },
        origin: 'null',
      });
      window.dispatchEvent(event);
    });

    expect(onOpenFile).toHaveBeenCalledWith('docs/readme.md');
  });

  it('should open external link via window.open for external postMessage', () => {
    const windowOpen = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<HtmlPreview {...defaultProps} />);
    switchToInteractive();

    act(() => {
      const event = new MessageEvent('message', {
        data: { type: 'commandmate:link-click', href: 'https://example.com' },
        origin: 'null',
      });
      window.dispatchEvent(event);
    });

    expect(windowOpen).toHaveBeenCalledWith(
      'https://example.com',
      '_blank',
      'noopener,noreferrer',
    );
  });

  it('should ignore postMessage with wrong origin [DR1-007]', () => {
    const onOpenFile = vi.fn();
    render(<HtmlPreview {...defaultProps} onOpenFile={onOpenFile} />);
    switchToInteractive();

    act(() => {
      const event = new MessageEvent('message', {
        data: { type: 'commandmate:link-click', href: './readme.md' },
        origin: 'https://evil.com',
      });
      window.dispatchEvent(event);
    });

    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it('should ignore postMessage with wrong type', () => {
    const onOpenFile = vi.fn();
    render(<HtmlPreview {...defaultProps} onOpenFile={onOpenFile} />);
    switchToInteractive();

    act(() => {
      const event = new MessageEvent('message', {
        data: { type: 'other-message', href: './readme.md' },
        origin: 'null',
      });
      window.dispatchEvent(event);
    });

    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it('should not register listener in safe mode', () => {
    const onOpenFile = vi.fn();
    const addEventSpy = vi.spyOn(window, 'addEventListener');
    render(<HtmlPreview {...defaultProps} onOpenFile={onOpenFile} />);

    // In safe mode (default), no message listener should be registered
    const messageListeners = addEventSpy.mock.calls.filter(
      ([type]) => type === 'message',
    );
    expect(messageListeners).toHaveLength(0);
  });

  it('should clean up listener on unmount', () => {
    const removeEventSpy = vi.spyOn(window, 'removeEventListener');
    const onOpenFile = vi.fn();
    const { unmount } = render(
      <HtmlPreview {...defaultProps} onOpenFile={onOpenFile} />,
    );
    switchToInteractive();

    unmount();

    const removedListeners = removeEventSpy.mock.calls.filter(
      ([type]) => type === 'message',
    );
    expect(removedListeners.length).toBeGreaterThan(0);
  });

  it('should reject postMessage with href exceeding 2048 chars [DR4-003]', () => {
    const onOpenFile = vi.fn();
    render(<HtmlPreview {...defaultProps} onOpenFile={onOpenFile} />);
    switchToInteractive();

    act(() => {
      const event = new MessageEvent('message', {
        data: { type: 'commandmate:link-click', href: 'a'.repeat(2049) },
        origin: 'null',
      });
      window.dispatchEvent(event);
    });

    expect(onOpenFile).not.toHaveBeenCalled();
  });
});
