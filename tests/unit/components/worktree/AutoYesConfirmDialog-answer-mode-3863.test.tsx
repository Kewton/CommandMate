/**
 * The Auto-Yes confirm dialog asks how questions are answered (Issue #3863).
 *
 * Two choices — 「質問は推奨で回答（おまかせ）」 (`recommended`, the default) and
 * 「質問は自分で回答（慎重）」 (`careful`) — and a note that permissions are
 * answered under either. The default reaches `onConfirm` as the two-argument
 * call the existing tests pin (an omitted mode is the default); a non-default
 * choice is the third argument.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AutoYesConfirmDialog } from '@/components/worktree/AutoYesConfirmDialog';
import { DEFAULT_AUTO_YES_DURATION } from '@/config/auto-yes-config';
import jaAutoYes from '../../../../locales/ja/autoYes.json';
import enAutoYes from '../../../../locales/en/autoYes.json';

const onConfirm = vi.fn();
const onCancel = vi.fn();

function renderDialog(isOpen = true) {
  return render(<AutoYesConfirmDialog isOpen={isOpen} onConfirm={onConfirm} onCancel={onCancel} />);
}

describe('[#3863] AutoYesConfirmDialog answer mode', () => {
  beforeEach(() => {
    onConfirm.mockReset();
    onCancel.mockReset();
  });

  it('offers the two modes, おまかせ selected by default', () => {
    renderDialog();

    const recommended = screen.getByTestId('auto-yes-answer-mode-recommended');
    const careful = screen.getByTestId('auto-yes-answer-mode-careful');
    expect(recommended.getAttribute('role')).toBe('radio');
    expect(recommended.getAttribute('aria-checked')).toBe('true');
    expect(careful.getAttribute('aria-checked')).toBe('false');
    expect(recommended.textContent).toContain('autoYes.answerModes.recommended');
    expect(careful.textContent).toContain('autoYes.answerModes.careful');
    expect(screen.getByTestId('auto-yes-answer-mode-permission-note').textContent).toBe(
      'autoYes.answerModePermissionNote',
    );
  });

  it('confirming the default passes no mode (negative control: the pinned two-argument call)', () => {
    renderDialog();
    fireEvent.click(screen.getByTestId('confirm-button'));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith(DEFAULT_AUTO_YES_DURATION, undefined);
  });

  it('confirming 慎重 passes careful as the third argument, beside the duration and stop pattern', () => {
    renderDialog();
    fireEvent.click(screen.getByTestId('auto-yes-answer-mode-careful'));
    fireEvent.click(screen.getByTestId('auto-yes-duration-3h'));
    fireEvent.change(screen.getByTestId('stop-pattern-input'), { target: { value: 'rm -rf' } });

    expect(screen.getByTestId('auto-yes-answer-mode-careful').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('auto-yes-answer-mode-recommended').getAttribute('aria-checked')).toBe('false');

    fireEvent.click(screen.getByTestId('confirm-button'));
    expect(onConfirm).toHaveBeenCalledWith(10800000, 'rm -rf', 'careful');
  });

  it('picking 慎重 then おまかせ again confirms the default', () => {
    renderDialog();
    fireEvent.click(screen.getByTestId('auto-yes-answer-mode-careful'));
    fireEvent.click(screen.getByTestId('auto-yes-answer-mode-recommended'));
    fireEvent.click(screen.getByTestId('confirm-button'));

    expect(onConfirm).toHaveBeenCalledWith(DEFAULT_AUTO_YES_DURATION, undefined);
  });

  it('starts from the default again each time it opens', () => {
    const { rerender } = renderDialog();
    fireEvent.click(screen.getByTestId('auto-yes-answer-mode-careful'));

    rerender(<AutoYesConfirmDialog isOpen={false} onConfirm={onConfirm} onCancel={onCancel} />);
    rerender(<AutoYesConfirmDialog isOpen onConfirm={onConfirm} onCancel={onCancel} />);

    expect(screen.getByTestId('auto-yes-answer-mode-recommended').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('auto-yes-answer-mode-careful').getAttribute('aria-checked')).toBe('false');
  });

  it('both dictionaries carry the wording, and say permissions are answered under either', () => {
    expect(jaAutoYes.answerModes.recommended).toBe('質問は推奨で回答（おまかせ）');
    expect(jaAutoYes.answerModes.careful).toBe('質問は自分で回答（慎重）');
    expect(jaAutoYes.answerModePermissionNote).toContain('許可の確認');
    expect(jaAutoYes.answerModePermissionNote).toContain('自動で答えます');
    expect(enAutoYes.answerModes.recommended).toContain('recommended option');
    expect(enAutoYes.answerModes.careful).toContain('yourself');
    expect(enAutoYes.answerModePermissionNote).toContain('Either way');
    expect(enAutoYes.answerModePermissionNote).toContain('answered automatically');
    expect(Object.keys(jaAutoYes.answerModeBadge)).toEqual(Object.keys(enAutoYes.answerModeBadge));
    expect(Object.keys(jaAutoYes.answerModeDescriptions)).toEqual(['recommended', 'careful']);
    expect(Object.keys(enAutoYes.answerModeDescriptions)).toEqual(['recommended', 'careful']);
  });
});
