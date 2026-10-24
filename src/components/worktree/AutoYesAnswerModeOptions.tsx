/**
 * AutoYesAnswerModeOptions - the two Auto-Yes answer modes as a radio group
 * (Issue #3863): 「質問は推奨で回答（おまかせ）」 (`recommended`) and
 * 「質問は自分で回答（慎重）」 (`careful`), each with its description, and the
 * note that permissions are answered under either.
 *
 * Shared by every place Auto-Yes is turned on with a choice of mode: the
 * confirm dialog behind `AutoYesToggle` and the new-task dialog's Auto-Yes
 * field. The caller owns the value.
 */

'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { AUTO_YES_ANSWER_MODES, type AutoYesAnswerMode } from '@/types/auto-yes-answer-mode';

export interface AutoYesAnswerModeOptionsProps {
  value: AutoYesAnswerMode;
  onChange: (mode: AutoYesAnswerMode) => void;
  /** Prefix of every test id (`<prefix>-<mode>`, `<prefix>-options`, `<prefix>-permission-note`) and of the label's id. */
  idPrefix?: string;
  /** Classes of the heading, so it can match the surrounding labels. */
  labelClassName?: string;
}

export function AutoYesAnswerModeOptions({
  value,
  onChange,
  idPrefix = 'auto-yes-answer-mode',
  labelClassName = 'font-medium mb-2',
}: AutoYesAnswerModeOptionsProps) {
  const t = useTranslations('autoYes');
  const labelId = `${idPrefix}-label`;
  return (
    <div className="text-sm text-foreground">
      <p className={labelClassName} id={labelId}>{t('answerModeLabel')}</p>
      <div
        className="flex flex-col gap-2"
        role="radiogroup"
        aria-labelledby={labelId}
        data-testid={`${idPrefix}-options`}
      >
        {AUTO_YES_ANSWER_MODES.map((mode) => (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={value === mode}
            onClick={() => onChange(mode)}
            className={`w-full py-2 px-3 text-left rounded-md border-2 transition-colors ${
              value === mode
                ? 'border-accent-600 bg-accent-50 dark:bg-accent-900/30 text-accent-700 dark:text-accent-400'
                : 'border-border bg-surface dark:bg-surface-2 text-foreground hover:border-muted-foreground'
            }`}
            style={{ minHeight: '44px' }}
            data-testid={`${idPrefix}-${mode}`}
          >
            <span className="block text-sm font-medium">{t(`answerModes.${mode}`)}</span>
            <span className="block text-xs text-muted-foreground">{t(`answerModeDescriptions.${mode}`)}</span>
          </button>
        ))}
      </div>
      <p className="mt-2 text-xs text-muted-foreground" data-testid={`${idPrefix}-permission-note`}>
        {t('answerModePermissionNote')}
      </p>
    </div>
  );
}
