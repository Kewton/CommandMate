/**
 * "N need your attention" — the global badge (Issue #1788).
 *
 * Two shapes over one number ({@link useAttentionCount}): a labelled pill in the
 * sidebar header on desktop, and a count bubble on the mobile nav's Review tab.
 * Both link to {@link ATTENTION_REVIEW_HREF}, the Review screen's `approval`
 * filter, so the badge and the list it opens are the same fact.
 *
 * **Nothing renders at zero.** A badge that reads "0" is chrome the eye learns
 * to skip, which is the opposite of the point.
 *
 * **No hover-only affordance.** The pill's label and the bubble's number are
 * painted at full opacity all the time: an `opacity-0 group-hover:opacity-100`
 * reveal is permanently invisible on a touch device, and the mobile nav is a
 * touch surface by definition.
 *
 * @module components/layout/AttentionBadge
 */

'use client';

import React from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ATTENTION_REVIEW_HREF } from '@/config/review-config';
import { useAttentionCount } from '@/hooks/useAttentionCount';

/**
 * Desktop sidebar pill. Renders `null` when nothing needs attention.
 *
 * Sits in the sidebar header, above the search box and the branch list —
 * deliberately clear of the rows themselves, which Issue #1787 owns.
 */
export function AttentionBadge() {
  const t = useTranslations('common');
  const { count } = useAttentionCount();

  if (count === 0) return null;

  return (
    <Link
      href={ATTENTION_REVIEW_HREF}
      data-testid="attention-badge"
      aria-label={t('attention.badgeLabel', { count })}
      className="mt-2 inline-flex w-full items-center justify-between gap-2 rounded-md
        border border-warning-border bg-warning-subtle px-2 py-1
        text-xs font-medium text-warning-foreground
        transition-colors hover:brightness-105
        focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="min-w-0 truncate">{t('attention.label')}</span>
      <span data-testid="attention-badge-count" className="tabular-nums font-semibold">
        {count}
      </span>
    </Link>
  );
}

/**
 * Mobile count bubble. Absolutely positioned, so its parent must be
 * `relative` — in practice the icon wrapper of the Review tab in
 * `GlobalMobileNav`. Renders `null` when nothing needs attention.
 *
 * Colours are the pill's inverted (`bg-warning-foreground` on
 * `text-warning-subtle`), which resolves to dark-amber-on-cream in light and
 * bright-amber-on-near-black in dark — a solid chip that carries on both nav
 * backgrounds without inventing a token this Issue does not own.
 *
 * Counts above 99 render as `99+` so the bubble cannot grow wide enough to
 * shove the tab label around.
 */
export function AttentionBadgeBubble({ count }: { count: number }) {
  const t = useTranslations('common');

  if (count === 0) return null;

  return (
    <span
      data-testid="attention-badge-bubble"
      role="status"
      aria-label={t('attention.badgeLabel', { count })}
      className="absolute -top-1.5 -right-2.5
        min-w-[1.05rem] rounded-full bg-warning-foreground px-1
        text-[0.625rem] font-bold leading-[1.05rem] text-warning-subtle
        tabular-nums text-center"
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}
