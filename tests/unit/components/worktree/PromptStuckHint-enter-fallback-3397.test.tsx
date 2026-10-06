/**
 * Issue #3397: the prompt window says "Auto-Yes sent Enter" in place of the
 * direct-input warning when Auto-Yes sent its Enter to that window — on the PC
 * (`PromptPanel`) and on the phone (`MobilePromptSheet`), both through the one
 * `PromptStuckHint`.
 *
 * Three states: the Enter was sent (the line), the Enter had no effect or there
 * is no record (the warning and the link, as before).
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import path from 'node:path';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock(() => 'en');
});

import { PromptStuckHint } from '@/components/worktree/PromptStuckHint';
import { PromptPanel } from '@/components/worktree/PromptPanel';
import { MobilePromptSheet } from '@/components/mobile/MobilePromptSheet';
import type { MultipleChoicePromptData } from '@/types/models';

const PROMPT: MultipleChoicePromptData = {
  type: 'multiple_choice',
  question: 'Which one?',
  status: 'pending',
  options: [
    { number: 1, label: 'A', isDefault: true },
    { number: 2, label: 'B', isDefault: false },
  ],
};

const SENT_TEXT = 'Auto-Yes sent Enter.';

describe('[#3397] PromptStuckHint', () => {
  it('Enter sent to this window: says so, with no warning and no link', () => {
    render(
      <PromptStuckHint answerable={false} autoYesEnterSent onSwitchToDirectInput={vi.fn()} linkClassName="" />,
    );
    expect(screen.getByTestId('prompt-auto-yes-enter-sent').textContent).toBe(SENT_TEXT);
    expect(screen.queryByTestId('prompt-unanswerable-hint')).toBeNull();
    expect(screen.queryByTestId('prompt-stuck-hint-link')).toBeNull();
  });

  it('the Enter had no effect (the record no longer counts as sent): the warning and the link', () => {
    render(
      <PromptStuckHint
        answerable={false}
        autoYesEnterSent={false}
        onSwitchToDirectInput={vi.fn()}
        linkClassName=""
      />,
    );
    expect(screen.queryByTestId('prompt-auto-yes-enter-sent')).toBeNull();
    expect(screen.getByTestId('prompt-unanswerable-hint')).toBeTruthy();
    expect(screen.getByTestId('prompt-stuck-hint-link')).toBeTruthy();
  });

  it('no record: the warning and the link, exactly as before', () => {
    render(<PromptStuckHint answerable={false} onSwitchToDirectInput={vi.fn()} linkClassName="" />);
    expect(screen.queryByTestId('prompt-auto-yes-enter-sent')).toBeNull();
    expect(screen.getByTestId('prompt-unanswerable-hint')).toBeTruthy();
    expect(screen.getByTestId('prompt-stuck-hint-link')).toBeTruthy();
  });

  it('an answerable window is not changed by a stray record', () => {
    const { container } = render(
      <PromptStuckHint answerable autoYesEnterSent onSwitchToDirectInput={vi.fn()} linkClassName="" />,
    );
    expect(container.textContent).toBe('');
  });
});

describe('[#3397] both prompt windows pass the record through', () => {
  it('PC: PromptPanel', () => {
    render(
      <PromptPanel
        promptData={PROMPT}
        messageId="m-1"
        visible
        answering={false}
        onRespond={vi.fn().mockResolvedValue(undefined)}
        answerable={false}
        autoYesEnterSent
        onSwitchToDirectInput={vi.fn()}
      />,
    );
    expect(screen.getByTestId('prompt-auto-yes-enter-sent').textContent).toBe(SENT_TEXT);
    expect(screen.queryByTestId('prompt-stuck-hint-link')).toBeNull();
  });

  it('phone: MobilePromptSheet', () => {
    render(
      <MobilePromptSheet
        promptData={PROMPT}
        visible
        answering={false}
        onRespond={vi.fn().mockResolvedValue(undefined)}
        answerable={false}
        autoYesEnterSent
        onSwitchToDirectInput={vi.fn()}
      />,
    );
    expect(screen.getByTestId('prompt-auto-yes-enter-sent').textContent).toBe(SENT_TEXT);
    expect(screen.queryByTestId('prompt-stuck-hint-link')).toBeNull();
  });

  it.each([
    ['PC', 'pc'],
    ['phone', 'phone'],
  ])('%s without the record still offers direct input', (_label, which) => {
    const common = {
      promptData: PROMPT,
      visible: true,
      answering: false,
      onRespond: vi.fn().mockResolvedValue(undefined),
      answerable: false,
      onSwitchToDirectInput: vi.fn(),
    };
    if (which === 'pc') render(<PromptPanel {...common} messageId="m-1" />);
    else render(<MobilePromptSheet {...common} />);
    expect(screen.queryByTestId('prompt-auto-yes-enter-sent')).toBeNull();
    expect(screen.getByTestId('prompt-stuck-hint-link')).toBeTruthy();
  });
});

describe('[#3397] the wording', () => {
  const ROOT = path.resolve(__dirname, '../../../..');
  const read = (lang: string) =>
    JSON.parse(readFileSync(path.join(ROOT, 'locales', lang, 'worktree.json'), 'utf8')) as {
      promptResponse: Record<string, string>;
    };

  it('is in both ja and en', () => {
    expect(read('en').promptResponse.autoYesEnterSent).toBe(SENT_TEXT);
    expect(read('ja').promptResponse.autoYesEnterSent).toBe('Auto-Yes が Enter を送りました。');
  });
});
