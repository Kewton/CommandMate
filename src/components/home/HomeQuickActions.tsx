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
import { MessageSquare, AlignJustify, FolderGit2, CircleCheck, MoreHorizontal } from 'lucide-react';
import { Card } from '@/components/ui';
import { STAGGER_ENTER_CLASS, staggerDelay } from '@/lib/utils/stagger';

interface QuickAction {
  title: string;
  href: string;
  icon: React.ReactNode;
}

/** Icons mirror the canonical nav set (lucide-react, 20px / strokeWidth 2). */
const QUICK_ACTIONS: QuickAction[] = [
  {
    title: 'Chat',
    href: '/chat',
    icon: <MessageSquare size={20} aria-hidden="true" />,
  },
  {
    title: 'Sessions',
    href: '/sessions',
    icon: <AlignJustify size={20} aria-hidden="true" />,
  },
  {
    title: 'Repositories',
    href: '/repositories',
    icon: <FolderGit2 size={20} aria-hidden="true" />,
  },
  {
    title: 'Review',
    href: '/review',
    icon: <CircleCheck size={20} aria-hidden="true" />,
  },
  {
    title: 'More',
    href: '/more',
    icon: <MoreHorizontal size={20} aria-hidden="true" />,
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
            <span className="text-muted-foreground group-hover:text-accent-600 dark:group-hover:text-accent-400 transition-colors">
              {action.icon}
            </span>
            <span className="text-xs font-medium text-foreground">
              {action.title}
            </span>
          </Card>
        </Link>
      ))}
    </div>
  );
}
