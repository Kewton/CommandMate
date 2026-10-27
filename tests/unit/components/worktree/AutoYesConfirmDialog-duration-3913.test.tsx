/**
 * The Auto-Yes confirm dialog offers 1〜24 hours (Issue #3913).
 *
 * 1h / 3h / 8h stay as one-tap presets; "その他" opens a select of every whole
 * hour. Each opening starts at 1h again — the dialog stays mounted inside
 * AutoYesToggle, so the previous choice (say 24h) used to become the next
 * default.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AutoYesConfirmDialog } from '@/components/worktree/AutoYesConfirmDialog';
import { AutoYesToggle } from '@/components/worktree/AutoYesToggle';

const HOUR = 3_600_000;

function chooseOther(hours: number): void {
  fireEvent.click(screen.getByTestId('auto-yes-duration-other'));
  fireEvent.change(screen.getByTestId('auto-yes-duration-select'), { target: { value: String(hours * HOUR) } });
}

describe('[#3913] AutoYesConfirmDialog duration', () => {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the three presets and "その他", with no select until it is chosen', () => {
    render(<AutoYesConfirmDialog isOpen onConfirm={onConfirm} onCancel={onCancel} />);
    for (const h of ['1h', '3h', '8h']) expect(screen.getByTestId(`auto-yes-duration-${h}`)).toBeDefined();
    expect(screen.getByTestId('auto-yes-duration-other').textContent).toBe('autoYes.durationOther');
    expect(screen.queryByTestId('auto-yes-duration-select')).toBeNull();
    expect(screen.getByTestId('auto-yes-long-duration-note').textContent).toBe('autoYes.longDurationNote');
  });

  it('offers every whole hour from 1 to 24 in the select', () => {
    render(<AutoYesConfirmDialog isOpen onConfirm={onConfirm} onCancel={onCancel} />);
    fireEvent.click(screen.getByTestId('auto-yes-duration-other'));
    const values = Array.from(
      (screen.getByTestId('auto-yes-duration-select') as HTMLSelectElement).options,
      (o) => Number(o.value),
    );
    expect(values).toEqual(Array.from({ length: 24 }, (_, i) => (i + 1) * HOUR));
  });

  it.each([5, 24])('confirms %ih chosen under "その他"', (hours) => {
    render(<AutoYesConfirmDialog isOpen onConfirm={onConfirm} onCancel={onCancel} />);
    chooseOther(hours);
    expect(screen.getByTestId('auto-yes-duration-other').className).toContain('border-accent-600');
    expect(screen.getByTestId('auto-yes-duration-1h').className).not.toContain('border-accent-600');

    fireEvent.click(screen.getByTestId('confirm-button'));
    expect(onConfirm).toHaveBeenCalledWith(hours * HOUR, undefined);
  });

  it('goes back and forth between a preset and "その他"', () => {
    render(<AutoYesConfirmDialog isOpen onConfirm={onConfirm} onCancel={onCancel} />);
    chooseOther(24);
    fireEvent.click(screen.getByTestId('auto-yes-duration-3h'));
    expect(screen.queryByTestId('auto-yes-duration-select')).toBeNull();
    expect(screen.getByTestId('auto-yes-duration-3h').className).toContain('border-accent-600');

    chooseOther(5);
    fireEvent.click(screen.getByTestId('confirm-button'));
    expect(onConfirm).toHaveBeenCalledWith(5 * HOUR, undefined);
  });

  it('starts at 1h again on every opening', () => {
    const { rerender } = render(<AutoYesConfirmDialog isOpen onConfirm={onConfirm} onCancel={onCancel} />);
    chooseOther(24);
    rerender(<AutoYesConfirmDialog isOpen={false} onConfirm={onConfirm} onCancel={onCancel} />);
    rerender(<AutoYesConfirmDialog isOpen onConfirm={onConfirm} onCancel={onCancel} />);

    expect(screen.queryByTestId('auto-yes-duration-select')).toBeNull();
    expect(screen.getByTestId('auto-yes-duration-1h').className).toContain('border-accent-600');
    fireEvent.click(screen.getByTestId('confirm-button'));
    expect(onConfirm).toHaveBeenCalledWith(HOUR, undefined);
  });

  it('through AutoYesToggle: cancel after choosing 24h, reopen, and 1h is what is posted', async () => {
    const onToggle = vi.fn().mockResolvedValue(undefined);
    render(<AutoYesToggle enabled={false} expiresAt={null} onToggle={onToggle} />);

    fireEvent.click(screen.getByRole('switch'));
    chooseOther(24);
    fireEvent.click(screen.getByText('common.cancel'));

    fireEvent.click(screen.getByRole('switch'));
    fireEvent.click(screen.getByTestId('confirm-button'));
    await waitFor(() => expect(onToggle).toHaveBeenCalledWith({ enabled: true, duration: HOUR, stopPattern: undefined }));
  });
});
