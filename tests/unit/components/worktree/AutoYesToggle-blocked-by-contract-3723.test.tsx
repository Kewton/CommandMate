/**
 * AutoYesToggle says when the contract keeps Auto-Yes from answering (Issue #3723).
 *
 * The switch stays ON — the instance IS armed, and turning it off must keep
 * working — and a label beside it says the contract (`autoYes.mode: off`) is
 * holding it. Without `blockedByContract` the toggle renders what it did.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AutoYesToggle, type AutoYesToggleParams } from '@/components/worktree/AutoYesToggle';
import jaAutoYes from '../../../../locales/ja/autoYes.json';
import enAutoYes from '../../../../locales/en/autoYes.json';

const baseProps = {
  expiresAt: Date.now() + 3_600_000,
  onToggle: vi.fn<(params: AutoYesToggleParams) => Promise<void>>().mockResolvedValue(undefined),
  lastAutoResponse: null,
};

describe('[#3723] AutoYesToggle blockedByContract', () => {
  it('shows the contract label while ON and blocked, with the switch still ON', () => {
    render(<AutoYesToggle {...baseProps} enabled blockedByContract />);

    expect(screen.getByTestId('auto-yes-blocked-by-contract').textContent).toBe('autoYes.blockedByContract');
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true');
  });

  it('turning it off still works while blocked', () => {
    const onToggle = vi.fn<(params: AutoYesToggleParams) => Promise<void>>().mockResolvedValue(undefined);
    render(<AutoYesToggle {...baseProps} onToggle={onToggle} enabled blockedByContract />);

    fireEvent.click(screen.getByRole('switch'));

    expect(onToggle).toHaveBeenCalledWith({ enabled: false });
  });

  it('shows nothing extra without the flag (negative control)', () => {
    render(<AutoYesToggle {...baseProps} enabled />);

    expect(screen.queryByTestId('auto-yes-blocked-by-contract')).toBeNull();
  });

  it('shows nothing while OFF, even with the flag', () => {
    render(<AutoYesToggle {...baseProps} enabled={false} expiresAt={null} blockedByContract />);

    expect(screen.queryByTestId('auto-yes-blocked-by-contract')).toBeNull();
  });

  it('both dictionaries name the contract and mode: off', () => {
    expect(jaAutoYes.blockedByContract).toBe('契約で停止中（mode: off）');
    expect(enAutoYes.blockedByContract).toContain('mode: off');
    expect(jaAutoYes.blockedByContractTitle).toContain('autoYes.mode: off');
    expect(enAutoYes.blockedByContractTitle).toContain('autoYes.mode: off');
  });
});
