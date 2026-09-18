/**
 * "N need your attention" — the mobile nav's count bubble (Issue #1788).
 *
 * The number comes from `useAttentionCount`; the Review tab that hosts the
 * bubble links to `ATTENTION_REVIEW_HREF` when it is above zero, so the bubble
 * and the list it opens are the same fact.
 *
 * The desktop sidebar's labelled pill that used to live here was removed in
 * Issue #2644: the count now sits on the sidebar's Review row (`Sidebar.tsx`).
 *
 * **Nothing renders at zero.** A badge that reads "0" is chrome the eye learns
 * to skip, which is the opposite of the point.
 *
 * **No hover-only affordance.** The bubble's number is painted at full opacity
 * all the time: an `opacity-0 group-hover:opacity-100` reveal is permanently
 * invisible on a touch device, and the mobile nav is a touch surface by
 * definition.
 *
 * @module components/layout/AttentionBadge
 */

'use client';

import React from 'react';
import { useTranslations } from 'next-intl';

/**
 * Mobile count bubble. Absolutely positioned, so its parent must be
 * `relative` — in practice the icon wrapper of the Review tab in
 * `GlobalMobileNav`. Renders `null` when nothing needs attention.
 *
 * Colours are the warning tint inverted (`bg-warning-foreground` on
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
