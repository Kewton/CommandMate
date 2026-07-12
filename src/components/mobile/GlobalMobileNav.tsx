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
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Home, MessageSquare, AlignJustify, CircleCheck, MoreHorizontal } from 'lucide-react';

/**
 * Mobile navigation tab definition.
 */
interface MobileNavTab {
  label: string;
  href: string;
  isActive: (pathname: string) => boolean;
  icon: React.ReactNode;
}

/**
 * Mobile navigation tabs - 4 tabs (Repositories is under More).
 * Icons: lucide-react at 20px / strokeWidth 2 (see docs/design-system.md).
 */
const MOBILE_NAV_TABS: MobileNavTab[] = [
  { label: 'Home', href: '/', isActive: (p) => p === '/', icon: <Home size={20} aria-hidden="true" /> },
  { label: 'Chat', href: '/chat', isActive: (p) => p.startsWith('/chat'), icon: <MessageSquare size={20} aria-hidden="true" /> },
  { label: 'Sessions', href: '/sessions', isActive: (p) => p.startsWith('/sessions'), icon: <AlignJustify size={20} aria-hidden="true" /> },
  { label: 'Review', href: '/review', isActive: (p) => p.startsWith('/review'), icon: <CircleCheck size={20} aria-hidden="true" /> },
  { label: 'More', href: '/more', isActive: (p) => p.startsWith('/more'), icon: <MoreHorizontal size={20} aria-hidden="true" /> },
];

/**
 * Global mobile bottom navigation bar.
 * Rendered on all pages except /worktrees/:id (which uses MobileTabBar).
 */
export function GlobalMobileNav() {
  const pathname = usePathname();

  return (
    <nav
      data-testid="global-mobile-nav"
      className="fixed bottom-0 left-0 right-0 z-50 border-t border-border bg-background supports-[backdrop-filter]:bg-background/80 backdrop-blur-md safe-area-bottom"
    >
      <div className="flex items-center justify-around h-14">
        {MOBILE_NAV_TABS.map((tab) => {
          const active = tab.isActive(pathname);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={`flex flex-col items-center justify-center flex-1 h-full text-xs transition-colors ${
                active
                  ? 'text-accent-600 dark:text-accent-400'
                  : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
              }`}
            >
              {tab.icon}
              <span className="mt-1">{tab.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
