/**
 * Issue #4456 item 1: the Auto-Yes refusal notice is the answer to one enabling.
 * Once the state changes by another path (CLI, API, another tab) it is gone, and
 * it does not come back when the switch is OFF again. A refusal given again is
 * shown again (I4).
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AutoYesToggle, type AutoYesToggleParams } from '@/components/worktree/AutoYesToggle';
import { ToolPolicyRefusalError } from '@/lib/tool-policy/refusal-view';

const view = {
  message: 'Refused by default for antigravity (4456).',
  links: { terms: 'https://antigravity.google/terms', faq: 'https://antigravity.google/docs/faq' },
};
const FAR = Date.now() + 60 * 60 * 1000;
const NOTICE = 'auto-yes-tool-policy-refusal';

function enable(): void {
  fireEvent.click(screen.getByRole('switch'));
  fireEvent.click(screen.getByText('autoYes.agreeAndEnable'));
}

function refusing() {
  return vi.fn<(p: AutoYesToggleParams) => Promise<void>>().mockRejectedValue(new ToolPolicyRefusalError(view));
}

describe('AutoYesToggle: the refusal is not shown again after the state changed (#4456)', () => {
  it('turned ON and OFF again by another path: the old refusal does not come back (4456)', async () => {
    const onToggle = refusing();
    const { rerender } = render(
      <AutoYesToggle enabled={false} expiresAt={null} onToggle={onToggle} cliToolName="antigravity" />,
    );
    enable();
    await screen.findByTestId(NOTICE);

    rerender(<AutoYesToggle enabled expiresAt={FAR} onToggle={onToggle} cliToolName="antigravity" />);
    expect(screen.queryByTestId(NOTICE)).toBeNull();
    rerender(<AutoYesToggle enabled={false} expiresAt={null} onToggle={onToggle} cliToolName="antigravity" />);
    expect(screen.queryByTestId(NOTICE)).toBeNull();
  });

  it('the agent of the toggle changed: the refusal of the other agent is gone (4456)', async () => {
    const onToggle = refusing();
    const { rerender } = render(
      <AutoYesToggle enabled={false} expiresAt={null} onToggle={onToggle} cliToolName="antigravity" />,
    );
    enable();
    await screen.findByTestId(NOTICE);
    rerender(<AutoYesToggle enabled={false} expiresAt={null} onToggle={onToggle} cliToolName="claude" />);
    expect(screen.queryByTestId(NOTICE)).toBeNull();
  });

  it('the same refusal again after the state changed is shown again (I4, 4456)', async () => {
    const onToggle = refusing();
    const { rerender } = render(
      <AutoYesToggle enabled={false} expiresAt={null} onToggle={onToggle} cliToolName="antigravity" />,
    );
    enable();
    await screen.findByTestId(NOTICE);
    rerender(<AutoYesToggle enabled expiresAt={FAR} onToggle={onToggle} cliToolName="antigravity" />);
    rerender(<AutoYesToggle enabled={false} expiresAt={null} onToggle={onToggle} cliToolName="antigravity" />);
    expect(screen.queryByTestId(NOTICE)).toBeNull();
    enable();
    expect((await screen.findByTestId(`${NOTICE}-message`)).textContent).toBe(view.message);
  });

  it('nothing changed (re-renders, polls with the same state): the refusal stays (I4, 4456)', async () => {
    const onToggle = refusing();
    const { rerender } = render(
      <AutoYesToggle enabled={false} expiresAt={null} onToggle={onToggle} cliToolName="antigravity" />,
    );
    enable();
    await screen.findByTestId(NOTICE);
    rerender(<AutoYesToggle enabled={false} expiresAt={null} onToggle={onToggle} cliToolName="antigravity" />);
    rerender(<AutoYesToggle enabled={false} expiresAt={null} onToggle={onToggle} cliToolName="antigravity" releasedByRestart />);
    expect(screen.getByTestId(NOTICE)).not.toBeNull();
  });
});
