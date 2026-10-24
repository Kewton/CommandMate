/**
 * AutoYesToggle shows the answer mode while ON and carries the dialog's choice
 * into `onToggle` (Issue #3863).
 *
 * The label is drawn only for a mode the server named: an `answerMode` of
 * undefined (a server older than the field, the Sessions tile's list row) is
 * "unknown" and draws nothing, rather than a confident おまかせ.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AutoYesToggle, type AutoYesToggleParams } from '@/components/worktree/AutoYesToggle';
import { DEFAULT_AUTO_YES_DURATION } from '@/config/auto-yes-config';

function makeOnToggle() {
  return vi.fn<(params: AutoYesToggleParams) => Promise<void>>().mockResolvedValue(undefined);
}

const ON = { enabled: true, expiresAt: Date.now() + 3_600_000, lastAutoResponse: null };

describe('[#3863] AutoYesToggle answer mode label', () => {
  it.each(['recommended', 'careful'] as const)('shows %s while ON', (mode) => {
    render(<AutoYesToggle {...ON} onToggle={makeOnToggle()} answerMode={mode} />);

    const label = screen.getByTestId('auto-yes-answer-mode');
    expect(label.getAttribute('data-answer-mode')).toBe(mode);
    expect(label.textContent).toBe(`autoYes.answerModeBadge.${mode}`);
    expect(label.getAttribute('title')).toBe(`autoYes.answerModeBadgeTitle.${mode}`);
  });

  it('shows nothing for an unknown mode (an older server): not assumed おまかせ', () => {
    render(<AutoYesToggle {...ON} onToggle={makeOnToggle()} />);

    expect(screen.queryByTestId('auto-yes-answer-mode')).toBeNull();
  });

  it('shows nothing while OFF, even with a mode', () => {
    render(<AutoYesToggle enabled={false} expiresAt={null} onToggle={makeOnToggle()} answerMode="careful" />);

    expect(screen.queryByTestId('auto-yes-answer-mode')).toBeNull();
  });

  it('shows nothing once the countdown has run out', () => {
    render(<AutoYesToggle {...ON} expiresAt={Date.now() - 1} onToggle={makeOnToggle()} answerMode="careful" />);

    expect(screen.queryByTestId('auto-yes-answer-mode')).toBeNull();
  });
});

describe('[#3863] AutoYesToggle passes the chosen mode', () => {
  it('慎重 in the dialog reaches onToggle as answerMode: careful', async () => {
    const onToggle = makeOnToggle();
    render(<AutoYesToggle enabled={false} expiresAt={null} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole('switch'));
    fireEvent.click(screen.getByTestId('auto-yes-answer-mode-careful'));
    fireEvent.click(screen.getByTestId('confirm-button'));

    await waitFor(() => {
      expect(onToggle).toHaveBeenCalledWith({
        enabled: true,
        duration: DEFAULT_AUTO_YES_DURATION,
        stopPattern: undefined,
        answerMode: 'careful',
      });
    });
  });

  it('the default leaves answerMode out (negative control: the pinned params)', async () => {
    const onToggle = makeOnToggle();
    render(<AutoYesToggle enabled={false} expiresAt={null} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole('switch'));
    fireEvent.click(screen.getByTestId('confirm-button'));

    await waitFor(() => expect(onToggle).toHaveBeenCalledTimes(1));
    expect(onToggle.mock.calls[0][0]).not.toHaveProperty('answerMode');
  });

  it('turning it off sends no mode', () => {
    const onToggle = makeOnToggle();
    render(<AutoYesToggle {...ON} onToggle={onToggle} answerMode="careful" />);
    fireEvent.click(screen.getByRole('switch'));

    expect(onToggle).toHaveBeenCalledWith({ enabled: false });
  });
});
