/**
 * Unit Tests for HtmlPreview Component - postMessage link handling
 *
 * Issue #505: HTML preview link navigation via postMessage
 * Issue #1113: interactive-mode confirmation now uses ConfirmDialog (useConfirm)
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { HtmlPreview } from '@/components/worktree/HtmlPreview';
import { ConfirmProvider } from '@/components/ui/ConfirmDialog';

// Issue #1275: this file drives the UI by rendered wording ("Interactive" mode
// button) and asserts the iframe title, so it must resolve keys through the
// real dictionary. The global mock in tests/setup.ts echoes `worktree.<key>`
// back and would keep these assertions green even if the key did not exist.
vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

describe('HtmlPreview - postMessage link handling', () => {
  const defaultProps = {
    worktreeId: 'test-wt',
    filePath: 'docs/index.html',
    htmlContent: '<html><body><a href="./readme.md">link</a></body></html>',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  function renderPreview(ui: React.ReactElement) {
    return render(<ConfirmProvider>{ui}</ConfirmProvider>);
  }

  /** Helper to switch to interactive mode (accepts the ConfirmDialog) */
  async function switchToInteractive() {
    fireEvent.click(screen.getByText('Interactive'));
    fireEvent.click(await screen.findByTestId('confirm-dialog-confirm'));
    await waitFor(() => {
      expect(screen.queryByTestId('confirm-dialog')).toBeNull();
    });
    // Flush the awaited confirm() continuation (setSandboxLevel)
    await act(async () => {});
  }

  it('should listen for postMessage in interactive mode', async () => {
    const onOpenFile = vi.fn();
    const addEventSpy = vi.spyOn(window, 'addEventListener');

    renderPreview(<HtmlPreview {...defaultProps} onOpenFile={onOpenFile} />);
    await switchToInteractive();

    expect(addEventSpy).toHaveBeenCalledWith(
      'message',
      expect.any(Function),
    );
  });

  it('should call onOpenFile for relative path postMessage', async () => {
    const onOpenFile = vi.fn();
    renderPreview(<HtmlPreview {...defaultProps} onOpenFile={onOpenFile} />);
    await switchToInteractive();

    act(() => {
      const event = new MessageEvent('message', {
        data: { type: 'commandmate:link-click', href: './readme.md' },
        origin: 'null',
      });
      window.dispatchEvent(event);
    });

    expect(onOpenFile).toHaveBeenCalledWith('docs/readme.md');
  });

  it('should open external link via window.open for external postMessage', async () => {
    const windowOpen = vi.spyOn(window, 'open').mockImplementation(() => null);
    renderPreview(<HtmlPreview {...defaultProps} />);
    await switchToInteractive();

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

  it('should ignore postMessage with wrong origin [DR1-007]', async () => {
    const onOpenFile = vi.fn();
    renderPreview(<HtmlPreview {...defaultProps} onOpenFile={onOpenFile} />);
    await switchToInteractive();

    act(() => {
      const event = new MessageEvent('message', {
        data: { type: 'commandmate:link-click', href: './readme.md' },
        origin: 'https://evil.com',
      });
      window.dispatchEvent(event);
    });

    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it('should ignore postMessage with wrong type', async () => {
    const onOpenFile = vi.fn();
    renderPreview(<HtmlPreview {...defaultProps} onOpenFile={onOpenFile} />);
    await switchToInteractive();

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
    renderPreview(<HtmlPreview {...defaultProps} onOpenFile={onOpenFile} />);

    // In safe mode (default), no message listener should be registered
    const messageListeners = addEventSpy.mock.calls.filter(
      ([type]) => type === 'message',
    );
    expect(messageListeners).toHaveLength(0);
  });

  it('should clean up listener on unmount', async () => {
    const removeEventSpy = vi.spyOn(window, 'removeEventListener');
    const onOpenFile = vi.fn();
    const { unmount } = renderPreview(
      <HtmlPreview {...defaultProps} onOpenFile={onOpenFile} />,
    );
    await switchToInteractive();

    unmount();

    const removedListeners = removeEventSpy.mock.calls.filter(
      ([type]) => type === 'message',
    );
    expect(removedListeners.length).toBeGreaterThan(0);
  });

  it('should reject postMessage with href exceeding 2048 chars [DR4-003]', async () => {
    const onOpenFile = vi.fn();
    renderPreview(<HtmlPreview {...defaultProps} onOpenFile={onOpenFile} />);
    await switchToInteractive();

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

// Issue #2861: relative <img src> must be inlined as data URIs because srcDoc
// documents have no base URL (about:srcdoc).
describe('HtmlPreview - relative image inlining (Issue #2861)', () => {
  const DATA_URI = 'data:image/png;base64,iVBORw0KGgo=';
  const htmlWithImage =
    '<!DOCTYPE html><html><body><img src="shots/a.png" alt="A"></body></html>';

  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ content: DATA_URI, isImage: true }) })),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('puts the fetched data URI into the iframe srcdoc and keeps Safe sandbox', async () => {
    render(
      <ConfirmProvider>
        <HtmlPreview worktreeId="wt-1" filePath="docs/report/index.html" htmlContent={htmlWithImage} />
      </ConfirmProvider>,
    );

    const iframe = screen.getByTestId('html-iframe-preview');
    await waitFor(() => {
      expect(iframe.getAttribute('srcdoc')).toContain(DATA_URI);
    });
    expect(iframe.getAttribute('srcdoc')).not.toContain('src="shots/a.png"');
    expect(iframe.getAttribute('sandbox')).toBe('');
    expect(fetch).toHaveBeenCalledWith('/api/worktrees/wt-1/files/docs/report/shots/a.png');
  });

  it('keeps the original src in the source view', async () => {
    render(
      <ConfirmProvider>
        <HtmlPreview worktreeId="wt-1" filePath="docs/report/index.html" htmlContent={htmlWithImage} />
      </ConfirmProvider>,
    );
    await waitFor(() => {
      expect(screen.getByTestId('html-iframe-preview').getAttribute('srcdoc')).toContain(DATA_URI);
    });

    fireEvent.click(screen.getByText('Source'));
    const source = screen.getByTestId('html-source-viewer');
    expect(source.textContent).toContain('shots/a.png');
    expect(source.textContent).not.toContain(DATA_URI);
  });
});
