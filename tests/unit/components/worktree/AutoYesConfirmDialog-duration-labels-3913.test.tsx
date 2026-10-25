/**
 * The duration's display name is an ICU message (Issue #3913): ja
 * 「1時間 / 5時間 / 24時間」, en "1 hour / 5 hours / 24 hours", in the
 * description and in the select. Rendered with the REAL next-intl over the
 * REAL dictionaries (tests/setup.ts mocks next-intl and would echo the key).
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';

vi.mock('next-intl', async (importOriginal) => await importOriginal<typeof import('next-intl')>());

import { render, screen, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider, createTranslator } from 'next-intl';
import { AutoYesConfirmDialog } from '@/components/worktree/AutoYesConfirmDialog';
import jaAutoYes from '../../../../locales/ja/autoYes.json';
import enAutoYes from '../../../../locales/en/autoYes.json';
import jaCommon from '../../../../locales/ja/common.json';
import enCommon from '../../../../locales/en/common.json';

const HOUR = 3_600_000;

const CASES = [
  { locale: 'ja', messages: { autoYes: jaAutoYes, common: jaCommon }, labels: ['1時間', '5時間', '24時間'], five: '5時間後に自動でOFFになります。' },
  { locale: 'en', messages: { autoYes: enAutoYes, common: enCommon }, labels: ['1 hour', '5 hours', '24 hours'], five: 'Will automatically turn OFF after 5 hours.' },
] as const;

describe.each(CASES)('[#3913] duration labels in $locale', ({ locale, messages, labels, five }) => {
  it('formats 1 / 5 / 24 hours through the real ICU formatter', () => {
    const t = createTranslator({ locale, messages, namespace: 'autoYes', onError: (e) => { throw e; } });
    expect([1, 5, 24].map((hours) => t('durationHours', { hours }))).toEqual(labels);
  });

  it('shows them in the description and the select', () => {
    render(
      <NextIntlClientProvider locale={locale} messages={messages} onError={(e) => { throw e; }}>
        <AutoYesConfirmDialog isOpen onConfirm={vi.fn()} onCancel={vi.fn()} />
      </NextIntlClientProvider>,
    );
    expect(screen.getByTestId('auto-yes-duration-1h').textContent).toBe(labels[0]);

    fireEvent.click(screen.getByTestId('auto-yes-duration-other'));
    const select = screen.getByTestId('auto-yes-duration-select') as HTMLSelectElement;
    const optionText = (ms: number) => Array.from(select.options).find((o) => Number(o.value) === ms)?.textContent;
    expect([optionText(HOUR), optionText(5 * HOUR), optionText(24 * HOUR)]).toEqual(labels);

    fireEvent.change(select, { target: { value: String(5 * HOUR) } });
    expect(screen.getByText(five)).toBeDefined();
  });
});
