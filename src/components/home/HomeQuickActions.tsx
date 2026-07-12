/**
 * HomeQuickActions Component
 *
 * Issue #1052: Home bento grid — compact quick-action tiles (Chat / Sessions /
 * Repositories / Review / More) shrunk into an icon-forward row. Replaces the
 * previous full-width shortcut cards with descriptions.
 */

'use client';

import React from 'react';
import Link from 'next/link';
import { Card } from '@/components/ui';
import { STAGGER_ENTER_CLASS, staggerDelay } from '@/lib/utils/stagger';

interface QuickAction {
  title: string;
  href: string;
  icon: React.ReactNode;
}

const QUICK_ACTIONS: QuickAction[] = [
  {
    title: 'Chat',
    href: '/chat',
    icon: (
      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
      </svg>
    ),
  },
  {
    title: 'Sessions',
    href: '/sessions',
    icon: (
      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h16M4 18h16" />
      </svg>
    ),
  },
  {
    title: 'Repositories',
    href: '/repositories',
    icon: (
      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
      </svg>
    ),
  },
  {
    title: 'Review',
    href: '/review',
    icon: (
      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
  },
  {
    title: 'More',
    href: '/more',
    icon: (
      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
      </svg>
    ),
  },
];

export function HomeQuickActions() {
  return (
    <div
      className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-5"
      data-testid="home-quick-actions"
    >
      {QUICK_ACTIONS.map((action, index) => (
        <Link
          key={action.href}
          href={action.href}
          aria-label={action.title}
          className="group block rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          data-testid={`quick-action-${action.title.toLowerCase()}`}
        >
          <Card
            interactive
            padding="sm"
            style={{ animationDelay: staggerDelay(index) }}
            className={`flex h-full flex-col items-center justify-center gap-1.5 py-3 text-center hover:border-accent-300 dark:hover:border-accent-700 ${STAGGER_ENTER_CLASS}`}
          >
            <span className="text-gray-400 dark:text-gray-500 group-hover:text-accent-600 dark:group-hover:text-accent-400 transition-colors">
              {action.icon}
            </span>
            <span className="text-xs font-medium text-gray-900 dark:text-gray-100">
              {action.title}
            </span>
          </Card>
        </Link>
      ))}
    </div>
  );
}
