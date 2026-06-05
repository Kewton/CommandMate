/**
 * Unit tests for FullScreenModal (Issue #825)
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';
import { FullScreenModal } from '@/components/common/FullScreenModal';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('FullScreenModal', () => {
  it('renders nothing when closed', () => {
    render(
      <FullScreenModal isOpen={false} onClose={vi.fn()}>
        <p>body</p>
      </FullScreenModal>,
    );
    expect(screen.queryByTestId('full-screen-modal')).toBeNull();
  });

  it('renders title, children, and footer when open', () => {
    render(
      <FullScreenModal isOpen onClose={vi.fn()} title="My Modal" footer={<button>save</button>}>
        <p>body content</p>
      </FullScreenModal>,
    );
    expect(screen.getByTestId('full-screen-modal')).toBeDefined();
    expect(screen.getByText('My Modal')).toBeDefined();
    expect(screen.getByText('body content')).toBeDefined();
    expect(screen.getByTestId('full-screen-modal-footer')).toBeDefined();
  });

  it('omits the footer region when no footer is provided', () => {
    render(
      <FullScreenModal isOpen onClose={vi.fn()} title="No Footer">
        <p>body</p>
      </FullScreenModal>,
    );
    expect(screen.queryByTestId('full-screen-modal-footer')).toBeNull();
  });

  it('calls onClose when the close button is clicked', () => {
    const onClose = vi.fn();
    render(
      <FullScreenModal isOpen onClose={onClose} title="Closable">
        <p>body</p>
      </FullScreenModal>,
    );
    fireEvent.click(screen.getByTestId('full-screen-modal-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when Escape is pressed', () => {
    const onClose = vi.fn();
    render(
      <FullScreenModal isOpen onClose={onClose} title="Escapable">
        <p>body</p>
      </FullScreenModal>,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('hides the close button when showCloseButton is false', () => {
    render(
      <FullScreenModal isOpen onClose={vi.fn()} title="No Close" showCloseButton={false}>
        <p>body</p>
      </FullScreenModal>,
    );
    expect(screen.queryByTestId('full-screen-modal-close')).toBeNull();
  });
});
