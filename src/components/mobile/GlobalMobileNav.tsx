/**
 * GlobalMobileNav Component
 *
 * Issue #600: UX refresh - Mobile bottom tab bar.
 * Branches (drawer) | Sessions | Review | Settings | Search
 *
 * Repositories is accessed via Settings > Repositories on mobile.
 * This component is distinct from MobileTabBar (Detail-local nav).
 */

'use client';

import React from 'react';
import { usePathname } from 'next/navigation';
import { TransitionLink } from '@/components/view-transitions/TransitionLink';
import { useTranslations } from 'next-intl';
import { AlignJustify, CircleCheck, Menu, MoreHorizontal, Search } from 'lucide-react';
import { useCommandPalette } from '@/contexts/CommandPaletteContext';
import { useOptionalSidebarContext } from '@/contexts/SidebarContext';
import { AttentionBadgeBubble } from '@/components/layout/AttentionBadge';
import { useAttentionCount } from '@/hooks/useAttentionCount';
import { ATTENTION_REVIEW_HREF } from '@/config/review-config';

/**
 * Mobile navigation tab definition.
 * `labelKey` resolves against the `common` namespace at render time.
 */
interface MobileNavTab {
  labelKey: string;
  href: string;
  isActive: (pathname: string) => boolean;
  icon: React.ReactNode;
  /**
   * Issue #1788: the tab that carries the "N need your attention" bubble.
   * Only Review has one, and only while the count is non-zero.
   */
  showsAttentionBadge?: boolean;
}

/**
 * Mobile navigation tabs - 3 tabs (Repositories is under Settings).
 * Icons: lucide-react at 20px / strokeWidth 2 (see docs/design-system.md).
 */
const MOBILE_NAV_TABS: MobileNavTab[] = [
  { labelKey: 'nav.sessions', href: '/sessions', isActive: (p) => p.startsWith('/sessions'), icon: <AlignJustify size={20} aria-hidden="true" /> },
  { labelKey: 'nav.review', href: '/review', isActive: (p) => p.startsWith('/review'), icon: <CircleCheck size={20} aria-hidden="true" />, showsAttentionBadge: true },
  { labelKey: 'nav.more', href: '/more', isActive: (p) => p.startsWith('/more'), icon: <MoreHorizontal size={20} aria-hidden="true" /> },
];

/**
 * Global mobile bottom navigation bar.
 * Rendered on all pages except /worktrees/:id (which uses MobileTabBar).
 */
export function GlobalMobileNav() {
  const pathname = usePathname();
  const { setOpen } = useCommandPalette();
  const t = useTranslations('commandPalette');
  const tCommon = useTranslations('common');
  // Issue #1788: 0 outside a WorktreesCacheProvider, so the bar still renders
  // (and this component still unit-tests) without one.
  const { count: attentionCount } = useAttentionCount();

  // Issue #2642: the phone's way into the branch list outside /worktrees/*.
  // Optional context so the bar still renders (and unit-tests) without a
  // SidebarProvider; the button is simply absent there.
  const sidebar = useOptionalSidebarContext();

  // Issue #2642: the drawer and this bar are both `fixed z-50`, and this bar
  // comes later in the DOM, so it would paint over the drawer's footer
  // (language / theme / logout). Step aside while the drawer is open; tapping
  // the overlay closes the drawer and brings the bar back.
  if (sidebar?.isMobileDrawerOpen) {
    return null;
  }

  return (
    <nav
      data-testid="global-mobile-nav"
      className="fixed bottom-0 left-0 right-0 z-50 border-t border-border bg-background supports-[backdrop-filter]:bg-background/80 backdrop-blur-md pb-safe"
    >
      <div className="flex items-center justify-around h-14">
        {sidebar && (
          <button
            type="button"
            data-testid="mobile-nav-open-sidebar"
            onClick={sidebar.openMobileDrawer}
            className="flex flex-col items-center justify-center flex-1 h-full text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <Menu size={20} aria-hidden="true" />
            <span className="mt-1 whitespace-nowrap">{tCommon('sidebar.branches')}</span>
          </button>
        )}

        {MOBILE_NAV_TABS.map((tab) => {
          const active = tab.isActive(pathname);
          // Issue #1788: while something needs attention, tapping Review lands
          // on the approval filter rather than the default In Review list —
          // the badge is the reason the user is tapping. Back to the plain tab
          // href at zero, so normal navigation is unchanged.
          const badged = tab.showsAttentionBadge === true && attentionCount > 0;
          return (
            <TransitionLink
              key={tab.href}
              href={badged ? ATTENTION_REVIEW_HREF : tab.href}
              className={`flex flex-col items-center justify-center flex-1 h-full text-xs transition-colors ${
                active
                  ? 'text-accent-600 dark:text-accent-400'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <span className="relative inline-flex">
                {tab.icon}
                {tab.showsAttentionBadge === true && (
                  <AttentionBadgeBubble count={attentionCount} />
                )}
              </span>
              <span className="mt-1 whitespace-nowrap">{tCommon(tab.labelKey)}</span>
            </TransitionLink>
          );
        })}

        {/* Command palette trigger (Issue #1053) */}
        <button
          type="button"
          data-testid="mobile-command-palette-trigger"
          onClick={() => setOpen(true)}
          aria-label={t('mobileTrigger')}
          className="flex flex-col items-center justify-center flex-1 h-full text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <Search size={20} aria-hidden="true" />
          <span className="mt-1 whitespace-nowrap">{t('mobileLabel')}</span>
        </button>
      </div>
    </nav>
  );
}
