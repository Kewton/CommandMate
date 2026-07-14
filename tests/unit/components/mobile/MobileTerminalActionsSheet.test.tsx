/**
 * Tests for MobileTerminalActionsSheet (Issue #1080)
 *
 * The terminal search + End actions moved off the mobile sticky row into this
 * bottom sheet. "End session" defers confirmation to the caller.
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MobileTerminalActionsSheet } from '@/components/mobile/MobileTerminalActionsSheet';

describe('MobileTerminalActionsSheet', () => {
  const defaultProps = {
    open: true,
    onClose: vi.fn(),
    onSearch: vi.fn(),
    onEnd: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not render when closed', () => {
    render(<MobileTerminalActionsSheet {...defaultProps} open={false} />);
    expect(screen.queryByTestId('mobile-terminal-actions-sheet')).not.toBeInTheDocument();
  });

  it('renders the sheet with search and end actions when open', () => {
    render(<MobileTerminalActionsSheet {...defaultProps} />);
    expect(screen.getByTestId('mobile-terminal-actions-sheet')).toBeInTheDocument();
    expect(screen.getByTestId('actions-sheet-search')).toBeInTheDocument();
    expect(screen.getByTestId('actions-sheet-end')).toBeInTheDocument();
  });

  it('is a bottom sheet anchored to the bottom edge', () => {
    render(<MobileTerminalActionsSheet {...defaultProps} />);
    const sheet = screen.getByTestId('mobile-terminal-actions-sheet');
    expect(sheet.className).toMatch(/fixed/);
    expect(sheet.className).toMatch(/bottom-0/);
    expect(sheet).toHaveAttribute('role', 'dialog');
  });

  it('invokes onSearch then closes when Search is tapped', () => {
    render(<MobileTerminalActionsSheet {...defaultProps} />);
    fireEvent.click(screen.getByTestId('actions-sheet-search'));
    expect(defaultProps.onSearch).toHaveBeenCalledTimes(1);
    expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
  });

  it('invokes onEnd then closes when End session is tapped', () => {
    render(<MobileTerminalActionsSheet {...defaultProps} />);
    fireEvent.click(screen.getByTestId('actions-sheet-end'));
    expect(defaultProps.onEnd).toHaveBeenCalledTimes(1);
    expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
  });

  it('disables End session when endDisabled', () => {
    render(<MobileTerminalActionsSheet {...defaultProps} endDisabled />);
    const endBtn = screen.getByTestId('actions-sheet-end');
    expect(endBtn).toBeDisabled();
    fireEvent.click(endBtn);
    expect(defaultProps.onEnd).not.toHaveBeenCalled();
  });

  it('closes when the overlay is tapped', () => {
    render(<MobileTerminalActionsSheet {...defaultProps} />);
    fireEvent.click(screen.getByTestId('terminal-actions-overlay'));
    expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
  });

  it('closes when Escape is pressed while open', () => {
    render(<MobileTerminalActionsSheet {...defaultProps} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
  });

  it('does not respond to Escape when closed', () => {
    render(<MobileTerminalActionsSheet {...defaultProps} open={false} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(defaultProps.onClose).not.toHaveBeenCalled();
  });

  it('ignores non-Escape keys while open', () => {
    render(<MobileTerminalActionsSheet {...defaultProps} />);
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(defaultProps.onClose).not.toHaveBeenCalled();
  });

  // Issue #1127: focus trap parity with ui/Modal.
  it('moves initial focus to the sheet and traps Tab within it', () => {
    render(<MobileTerminalActionsSheet {...defaultProps} />);
    const sheet = screen.getByTestId('mobile-terminal-actions-sheet');
    expect(document.activeElement).toBe(sheet);

    const buttons = Array.from(sheet.querySelectorAll('button'));
    const first = buttons[0];
    const last = buttons[buttons.length - 1];

    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(first);

    first.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });
});
