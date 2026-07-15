/**
 * GlobalMobileNav Component
 *
 * Issue #600: UX refresh - Mobile bottom tab bar with 4 tabs.
 * Home | Sessions | Review | More
 *
 * Repositories is accessed via More > Repositories on mobile.
 * This component is distinct from MobileTabBar (Detail-local nav).
 */

'use client';

import React from 'react';
import { usePathname } from 'next/navigation';
import { TransitionLink } from '@/components/view-transitions/TransitionLink';
import { useTranslations } from 'next-intl';
import { Home, MessageSquare, AlignJustify, CircleCheck, MoreHorizontal, Search } from 'lucide-react';
import { useCommandPalette } from '@/contexts/CommandPaletteContext';

/**
 * Mobile navigation tab definition.
 * `labelKey` resolves against the `common` namespace at render time.
 */
interface MobileNavTab {
  labelKey: string;
  href: string;
  isActive: (pathname: string) => boolean;
  icon: React.ReactNode;
}

/**
 * Mobile navigation tabs - 4 tabs (Repositories is under More).
 * Icons: lucide-react at 20px / strokeWidth 2 (see docs/design-system.md).
 */
const MOBILE_NAV_TABS: MobileNavTab[] = [
  { labelKey: 'nav.home', href: '/', isActive: (p) => p === '/', icon: <Home size={20} aria-hidden="true" /> },
  { labelKey: 'nav.chat', href: '/chat', isActive: (p) => p.startsWith('/chat'), icon: <MessageSquare size={20} aria-hidden="true" /> },
  { labelKey: 'nav.sessions', href: '/sessions', isActive: (p) => p.startsWith('/sessions'), icon: <AlignJustify size={20} aria-hidden="true" /> },
  { labelKey: 'nav.review', href: '/review', isActive: (p) => p.startsWith('/review'), icon: <CircleCheck size={20} aria-hidden="true" /> },
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

  return (
    <nav
      data-testid="global-mobile-nav"
      className="fixed bottom-0 left-0 right-0 z-50 border-t border-border bg-background supports-[backdrop-filter]:bg-background/80 backdrop-blur-md pb-safe"
    >
      <div className="flex items-center justify-around h-14">
        {MOBILE_NAV_TABS.map((tab) => {
          const active = tab.isActive(pathname);
          return (
            <TransitionLink
              key={tab.href}
              href={tab.href}
              className={`flex flex-col items-center justify-center flex-1 h-full text-xs transition-colors ${
                active
                  ? 'text-accent-600 dark:text-accent-400'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {tab.icon}
              <span className="mt-1">{tCommon(tab.labelKey)}</span>
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
          <span className="mt-1">{t('mobileLabel')}</span>
        </button>
      </div>
    </nav>
  );
}
