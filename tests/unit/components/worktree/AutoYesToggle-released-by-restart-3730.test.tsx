/**
 * AutoYesToggle says when a server restart is why Auto-Yes is OFF (Issue #3730).
 *
 * The switch stays OFF — nothing is re-enabled — and a label beside it says the
 * restart released the grant. Turning it on still goes through the confirm
 * dialog as always. Without `releasedByRestart` the toggle renders what it did.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AutoYesToggle, type AutoYesToggleParams } from '@/components/worktree/AutoYesToggle';
import jaAutoYes from '../../../../locales/ja/autoYes.json';
import enAutoYes from '../../../../locales/en/autoYes.json';

const baseProps = {
  expiresAt: null,
  onToggle: vi.fn<(params: AutoYesToggleParams) => Promise<void>>().mockResolvedValue(undefined),
  lastAutoResponse: null,
};

describe('[#3730] AutoYesToggle releasedByRestart', () => {
  it('shows the restart label beside the OFF switch', () => {
    render(<AutoYesToggle {...baseProps} enabled={false} releasedByRestart />);

    const label = screen.getByTestId('auto-yes-released-by-restart');
    expect(label.textContent).toBe('autoYes.releasedByRestart');
    expect(label.getAttribute('title')).toBe('autoYes.releasedByRestartTitle');
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false');
  });

  it('turning it on still asks for confirmation first (nothing re-arms by itself)', () => {
    const onToggle = vi.fn<(params: AutoYesToggleParams) => Promise<void>>().mockResolvedValue(undefined);
    render(<AutoYesToggle {...baseProps} onToggle={onToggle} enabled={false} releasedByRestart />);

    fireEvent.click(screen.getByRole('switch'));

    expect(onToggle).not.toHaveBeenCalled();
  });

  it('negative control: no label without the flag', () => {
    render(<AutoYesToggle {...baseProps} enabled={false} />);
    expect(screen.queryByTestId('auto-yes-released-by-restart')).toBeNull();
  });

  it('negative control: no label while ON, even with the flag', () => {
    render(<AutoYesToggle {...baseProps} enabled expiresAt={Date.now() + 3_600_000} releasedByRestart />);
    expect(screen.queryByTestId('auto-yes-released-by-restart')).toBeNull();
  });

  it('both dictionaries say the restart released it and that it is not turned back on', () => {
    expect(jaAutoYes.releasedByRestart).toBe('再起動で解除');
    expect(jaAutoYes.releasedByRestartTitle).toContain('自動では戻りません');
    expect(enAutoYes.releasedByRestart).toBe('Released by restart');
    expect(enAutoYes.releasedByRestartTitle).toContain('not turned back on automatically');
  });
});
