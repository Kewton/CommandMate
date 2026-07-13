/**
 * Tests for Modal primitive (Issue #1042: cva size variants + cn migration)
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { Modal } from '@/components/ui/Modal';

// [Issue #1050] Motion foundation: data-state + enter animation.
describe('Modal (Issue #1050 motion)', () => {
  afterEach(() => {
    cleanup();
    document.body.style.overflow = 'unset';
  });

  it('exposes data-state="open" and fade+scale enter classes on the panel when open', () => {
    render(
      <Modal isOpen onClose={() => {}} title="Anim">
        <p>content</p>
      </Modal>
    );
    const panel = screen.getByTestId('modal-panel');
    expect(panel).toHaveAttribute('data-state', 'open');
    const cls = panel.className;
    expect(cls).toContain('data-[state=open]:animate-in');
    expect(cls).toContain('data-[state=open]:fade-in-0');
    expect(cls).toContain('data-[state=open]:zoom-in-95');
  });

  it('transitions from an open panel to no panel when closed', () => {
    const { rerender } = render(
      <Modal isOpen onClose={() => {}} title="Anim">
        <p>content</p>
      </Modal>
    );
    expect(screen.getByTestId('modal-panel')).toHaveAttribute('data-state', 'open');

    rerender(
      <Modal isOpen={false} onClose={() => {}} title="Anim">
        <p>content</p>
      </Modal>
    );
    // Closed modals unmount, so the panel (and its data-state) is gone.
    expect(screen.queryByTestId('modal-panel')).toBeNull();
  });
});

afterEach(() => {
  cleanup();
  document.body.style.overflow = 'unset';
});

describe('Modal', () => {
  it('renders nothing when closed', () => {
    render(
      <Modal isOpen={false} onClose={() => {}} title="Hidden">
        <p>content</p>
      </Modal>
    );
    expect(screen.queryByText('Hidden')).toBeNull();
    expect(screen.queryByText('content')).toBeNull();
  });

  it('renders title and children when open', () => {
    render(
      <Modal isOpen onClose={() => {}} title="Viewer">
        <p>content</p>
      </Modal>
    );
    expect(screen.getByText('Viewer')).toBeInTheDocument();
    expect(screen.getByText('content')).toBeInTheDocument();
  });

  it.each([
    ['sm', 'sm:max-w-md'],
    ['md', 'sm:max-w-2xl'],
    ['lg', 'sm:max-w-4xl'],
    ['xl', 'sm:max-w-6xl'],
    ['full', 'sm:max-w-[95vw]'],
  ] as const)('applies the %s size class on the dialog container', (size, expected) => {
    render(
      <Modal isOpen onClose={() => {}} title="Sized" size={size}>
        <p data-testid="body">content</p>
      </Modal>
    );
    // Walk up from content to the sized container (has the max-w-* class).
    const container = document.querySelector(`.${CSS.escape(expected)}`);
    expect(container).not.toBeNull();
  });

  it('calls onClose when the close button is clicked', () => {
    const onClose = vi.fn();
    render(
      <Modal isOpen onClose={onClose} title="Closable">
        <p>content</p>
      </Modal>
    );
    fireEvent.click(screen.getByRole('button'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when Escape is pressed', () => {
    const onClose = vi.fn();
    render(
      <Modal isOpen onClose={onClose} title="Esc">
        <p>content</p>
      </Modal>
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not close on Escape when disableClose is set (Issue #104)', () => {
    const onClose = vi.fn();
    render(
      <Modal isOpen onClose={onClose} title="Locked" disableClose>
        <p>content</p>
      </Modal>
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('hides the close button when showCloseButton is false', () => {
    render(
      <Modal isOpen onClose={() => {}} title="NoClose" showCloseButton={false}>
        <p>content</p>
      </Modal>
    );
    expect(screen.queryByRole('button')).toBeNull();
  });
});
