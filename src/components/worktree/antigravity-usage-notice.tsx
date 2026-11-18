/**
 * AntigravityUsageNotice (Issue #4438)
 *
 * The note shown where an antigravity instance is added (the header "+" form and the
 * roster editor, PC and phone). Google Antigravity Additional Terms §6 and the
 * official FAQ restrict using Antigravity on a consumer plan through third-party
 * software or agents; this says so, with the two links from the tool policy.
 *
 * Guidance only: it never blocks the add. What must be refused is refused by the
 * server (#4436). The declaration is a server environment variable, so its state is
 * not shown and cannot be changed here.
 *
 * Issue #4456: `compact` (the composer) caps the body's height and scrolls it, so
 * in a narrow pane (the 3-way split) the notice does not push the input box out
 * of view; the headline and Close stay outside the scrolling part.
 */

'use client';

import React, { memo } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle } from 'lucide-react';
import {
  ANTIGRAVITY_FAQ_URL,
  ANTIGRAVITY_TERMS_CHECKED_AT,
  ANTIGRAVITY_TERMS_URL,
  USAGE_DECLARATION_ENV,
} from '@/lib/tool-policy/policy';

export const ANTIGRAVITY_NOTICE_TEST_ID = 'antigravity-usage-notice';

/** The `worktree` namespace keys the notice reads. */
export const ANTIGRAVITY_NOTICE_KEYS = {
  headline: 'antigravityNotice.title',
  body: 'antigravityNotice.body',
  unconfirmed: 'antigravityNotice.unconfirmed',
  declaration: 'antigravityNotice.declaration',
  asOf: 'antigravityNotice.asOf',
  terms: 'antigravityNotice.terms',
  faq: 'antigravityNotice.faq',
  dismiss: 'antigravityNotice.dismiss',
} as const;

export interface AntigravityUsageNoticeProps {
  /** Close the notice (it is not shown again in this browser). */
  onDismiss: () => void;
  className?: string;
  /** Issue #4456: cap the body's height (scrolls) — for the composer, above the input box. */
  compact?: boolean;
}

export const AntigravityUsageNotice = memo(function AntigravityUsageNotice({
  onDismiss,
  className = '',
  compact = false,
}: AntigravityUsageNoticeProps) {
  const t = useTranslations('worktree');
  const linkClass = 'underline text-accent-700 dark:text-accent-300 hover:text-accent-800';
  return (
    <div
      role="note"
      aria-label={t(ANTIGRAVITY_NOTICE_KEYS.headline)}
      data-testid={ANTIGRAVITY_NOTICE_TEST_ID}
      className={`rounded-md border border-input bg-warning-subtle p-3 text-xs text-foreground space-y-1.5 ${className}`}
    >
      <p className="flex items-center gap-1.5 font-medium">
        <AlertTriangle className="w-3.5 h-3.5 shrink-0 text-warning" aria-hidden="true" />
        {t(ANTIGRAVITY_NOTICE_KEYS.headline)}
      </p>
      <div
        data-testid={`${ANTIGRAVITY_NOTICE_TEST_ID}-body`}
        className={compact ? 'space-y-1.5 max-h-24 overflow-y-auto overscroll-contain pr-1' : 'space-y-1.5'}
      >
        <p className="break-words">{t(ANTIGRAVITY_NOTICE_KEYS.body)}</p>
        <p className="break-words">{t(ANTIGRAVITY_NOTICE_KEYS.unconfirmed)}</p>
        <p className="break-words">{t(ANTIGRAVITY_NOTICE_KEYS.declaration, { env: USAGE_DECLARATION_ENV })}</p>
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <a href={ANTIGRAVITY_TERMS_URL} target="_blank" rel="noopener noreferrer" className={linkClass}>
            {t(ANTIGRAVITY_NOTICE_KEYS.terms)}
          </a>
          <a href={ANTIGRAVITY_FAQ_URL} target="_blank" rel="noopener noreferrer" className={linkClass}>
            {t(ANTIGRAVITY_NOTICE_KEYS.faq)}
          </a>
          <span className="text-muted-foreground">{t(ANTIGRAVITY_NOTICE_KEYS.asOf, { date: ANTIGRAVITY_TERMS_CHECKED_AT })}</span>
        </p>
      </div>
      <div className="flex justify-end">
        <button
          type="button"
          onClick={onDismiss}
          data-testid={`${ANTIGRAVITY_NOTICE_TEST_ID}-dismiss`}
          className="px-2 py-1 text-xs rounded-md bg-muted hover:bg-muted/80 text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t(ANTIGRAVITY_NOTICE_KEYS.dismiss)}
        </button>
      </div>
    </div>
  );
});

export default AntigravityUsageNotice;
