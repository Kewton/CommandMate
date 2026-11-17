/**
 * AutoYesToggle shows a tool-policy refusal of the enabling beside the switch (Issue #4436).
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AutoYesToggle, type AutoYesToggleParams } from '@/components/worktree/AutoYesToggle';
import { ToolPolicyRefusalError } from '@/lib/tool-policy/refusal-view';

const view = {
  message: 'Refused by default for antigravity under the Google Antigravity terms §6 (consumer plans). Nothing was typed.',
  links: { terms: 'https://antigravity.google/terms', faq: 'https://antigravity.google/docs/faq' },
};

function enable(): void {
  fireEvent.click(screen.getByRole('switch'));
  fireEvent.click(screen.getByText('autoYes.agreeAndEnable'));
}

describe('AutoYesToggle: tool-policy refusal (#4436)', () => {
  it('T3: a refused enabling shows the reason and the FAQ link; the switch stays off', async () => {
    const onToggle = vi.fn<(p: AutoYesToggleParams) => Promise<void>>().mockRejectedValue(new ToolPolicyRefusalError(view));
    render(<AutoYesToggle enabled={false} expiresAt={null} onToggle={onToggle} cliToolName="antigravity" />);
    enable();
    const faq = await screen.findByTestId('auto-yes-tool-policy-refusal-faq');
    expect(faq.getAttribute('href')).toBe(view.links.faq);
    expect(faq.getAttribute('rel')).toBe('noopener noreferrer');
    expect(screen.getByTestId('auto-yes-tool-policy-refusal-terms').getAttribute('href')).toBe(view.links.terms);
    expect(screen.getByTestId('auto-yes-tool-policy-refusal-message').textContent).toBe(view.message);
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false');
  });

  it('T3: the notice goes away when the dialog is opened again', async () => {
    const onToggle = vi.fn<(p: AutoYesToggleParams) => Promise<void>>().mockRejectedValue(new ToolPolicyRefusalError(view));
    render(<AutoYesToggle enabled={false} expiresAt={null} onToggle={onToggle} cliToolName="antigravity" />);
    enable();
    await screen.findByTestId('auto-yes-tool-policy-refusal-faq');
    fireEvent.click(screen.getByRole('switch'));
    expect(screen.queryByTestId('auto-yes-tool-policy-refusal-faq')).toBeNull();
  });

  it('T4: an accepted enabling shows no notice', async () => {
    const onToggle = vi.fn<(p: AutoYesToggleParams) => Promise<void>>().mockResolvedValue(undefined);
    render(<AutoYesToggle enabled={false} expiresAt={null} onToggle={onToggle} cliToolName="claude" />);
    enable();
    await waitFor(() => expect(onToggle).toHaveBeenCalled());
    expect(screen.queryByTestId('auto-yes-tool-policy-refusal')).toBeNull();
  });

  it('T4: another rejection is logged, not shown as a refusal', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onToggle = vi.fn<(p: AutoYesToggleParams) => Promise<void>>().mockRejectedValue(new Error('boom'));
    render(<AutoYesToggle enabled={false} expiresAt={null} onToggle={onToggle} cliToolName="claude" />);
    enable();
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(screen.queryByTestId('auto-yes-tool-policy-refusal')).toBeNull();
    spy.mockRestore();
  });
});
