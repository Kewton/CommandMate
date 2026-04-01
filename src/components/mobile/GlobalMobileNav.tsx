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
 * SVG icon components for mobile nav tabs.
 */
const HomeIcon = () => (
  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
  </svg>
);

const SessionsIcon = () => (
  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h16M4 18h16" />
  </svg>
);

const ReviewIcon = () => (
  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
  </svg>
);

const MoreIcon = () => (
  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h.01M12 12h.01M19 12h.01M6 12a1 1 0 11-2 0 1 1 0 012 0zm7 0a1 1 0 11-2 0 1 1 0 012 0zm7 0a1 1 0 11-2 0 1 1 0 012 0z" />
  </svg>
);

/**
 * Mobile navigation tabs - 4 tabs (Repositories is under More).
 */
const MOBILE_NAV_TABS: MobileNavTab[] = [
  { label: 'Home', href: '/', isActive: (p) => p === '/', icon: <HomeIcon /> },
  { label: 'Sessions', href: '/sessions', isActive: (p) => p.startsWith('/sessions'), icon: <SessionsIcon /> },
  { label: 'Review', href: '/review', isActive: (p) => p.startsWith('/review'), icon: <ReviewIcon /> },
  { label: 'More', href: '/more', isActive: (p) => p.startsWith('/more'), icon: <MoreIcon /> },
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
      className="fixed bottom-0 left-0 right-0 bg-white dark:bg-gray-900 border-t border-gray-200 dark:border-gray-700 z-50 safe-area-bottom"
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
                  ? 'text-cyan-600 dark:text-cyan-400'
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
