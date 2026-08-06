/**
 * PromptPanel's degraded rendering for a structured prompt (Issue #1725).
 *
 * Backed by the real dictionaries on purpose. The global next-intl mock in
 * `tests/setup.ts` echoes `namespace.key` back and drops interpolation params
 * entirely, so an assertion about the *wording* — and every assertion about a
 * `{command}` placeholder — passes there whether the key exists or not. The one
 * thing this panel has to get right is the sentence telling the user to answer
 * by NUMBER, so it is checked against `locales/en` and `locales/ja` themselves.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const locale = vi.hoisted(() => ({ current: 'en' }));
vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock(() => locale.current);
});

import { PromptPanel } from '@/components/worktree/PromptPanel';
import { buildStructuredPromptData } from '@/lib/session/structured-prompt';

const structuredPrompt = buildStructuredPromptData('wt-1', {
  source: 'notification',
  message: 'Claude needs your permission to use Bash',
  toolName: 'Bash',
});

function renderPanel() {
  return render(
    <PromptPanel
      promptData={structuredPrompt}
      messageId="prompt-1"
      visible
      answering={false}
      onRespond={vi.fn()}
    />,
  );
}

describe('PromptPanel: a dialog nobody could parse (Issue #1725)', () => {
  it('renders the panel rather than leaving the session looking idle', () => {
    locale.current = 'en';
    renderPanel();

    expect(screen.getByTestId('prompt-panel')).toBeInTheDocument();
    expect(screen.getByTestId('unclassified-prompt-notice')).toBeInTheDocument();
  });

  it('offers nothing to click, because there is nothing to click', () => {
    // The Notification payload carries no options (#1721 §5.5). A button here
    // would be a guess about which key it sends.
    locale.current = 'en';
    renderPanel();

    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /yes/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /submit/i })).not.toBeInTheDocument();
  });

  it('shows the agent’s own line verbatim', () => {
    // `message` is display-only prose; `notification_type` is what the server
    // branches on (D3). Showing it is what tells the user which tool is asking.
    locale.current = 'en';
    renderPanel();

    expect(
      screen.getByText('Claude needs your permission to use Bash'),
    ).toBeInTheDocument();
  });

  it('tells the user to answer by NUMBER, in English', () => {
    locale.current = 'en';
    renderPanel();

    const notice = screen.getByTestId('unclassified-prompt-notice');
    expect(notice).toHaveTextContent('option NUMBER');
    // The interpolated command, which the global mock would have dropped.
    expect(notice).toHaveTextContent('commandmate respond [worktree-id] [number]');
    // Issue #1681: "yes"/"no" is not resolved on a numbered dialog.
    expect(notice).toHaveTextContent(/yes/);
  });

  it('tells the user to answer by NUMBER, in Japanese', () => {
    locale.current = 'ja';
    renderPanel();

    const notice = screen.getByTestId('unclassified-prompt-notice');
    expect(notice).toHaveTextContent('番号');
    expect(notice).toHaveTextContent('commandmate respond [worktree-id] [番号]');
  });

  it('does not show the server-built English question in a Japanese UI', () => {
    // `question` exists for `wait` / `capture --prompts`, which have no locale.
    // The panel says the same thing through the dictionary instead.
    locale.current = 'ja';
    renderPanel();

    expect(screen.queryByText(/A dialog is open in wt-1/)).not.toBeInTheDocument();
    expect(
      screen.getByText('ダイアログが開いていますが、選択肢を読み取れませんでした。'),
    ).toBeInTheDocument();
  });
});
