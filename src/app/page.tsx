/**
 * Home Page (/)
 *
 * Issue #600: UX refresh - Mission Control / Inbox.
 * Provides session summary and shortcut cards to specialized screens.
 *
 * Previously contained RepositoryManager, WorktreeList, ExternalAppsManager.
 * These have been moved to their respective dedicated pages:
 * - RepositoryManager -> /repositories
 * - WorktreeList -> /sessions
 * - ExternalAppsManager -> /more
 */

'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { AppShell } from '@/components/layout';
import { HomeSessionSummary } from '@/components/home/HomeSessionSummary';
import type { Worktree } from '@/types/models';

/**
 * localStorage key for dismissing the welcome banner.
 */
const BANNER_DISMISSED_KEY = 'commandmate-home-banner-dismissed';

/**
 * Shortcut card data for navigation.
 */
const SHORTCUT_CARDS = [
  {
    title: 'Chat',
    description: 'Talk to a local CLI assistant scoped to a repository',
    href: '/chat',
    icon: (
      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
      </svg>
    ),
  },
  {
    title: 'Sessions',
    description: 'View and manage all worktree sessions',
    href: '/sessions',
    icon: (
      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h16M4 18h16" />
      </svg>
    ),
  },
  {
    title: 'Repositories',
    description: 'Manage repositories and worktrees',
    href: '/repositories',
    icon: (
      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
      </svg>
    ),
  },
  {
    title: 'Review',
    description: 'Review done, approval, and stalled sessions',
    href: '/review',
    icon: (
      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
  },
  {
    title: 'More',
    description: 'Settings, external apps, and help',
    href: '/more',
    icon: (
      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
      </svg>
    ),
  },
];

export default function Home() {
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [bannerDismissed, setBannerDismissed] = useState(true);

  // Load worktrees for session summary
  useEffect(() => {
    async function fetchWorktrees() {
      try {
        const response = await fetch('/api/worktrees');
        if (response.ok) {
          const data = await response.json();
          setWorktrees(data.worktrees ?? []);
        }
      } catch {
        // Silently handle fetch errors on home page
      }
    }
    fetchWorktrees();
  }, []);

  // Check banner dismissed state
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const dismissed = localStorage.getItem(BANNER_DISMISSED_KEY);
      setBannerDismissed(dismissed === 'true');
    }
  }, []);

  const dismissBanner = useCallback(() => {
    setBannerDismissed(true);
    if (typeof window !== 'undefined') {
      localStorage.setItem(BANNER_DISMISSED_KEY, 'true');
    }
  }, []);

  return (
    <AppShell>
      <div className="container-custom py-8 overflow-auto h-full">
        {/* Welcome banner (dismissible) */}
        {!bannerDismissed && (
          <div
            data-testid="welcome-banner"
            className="mb-6 bg-cyan-50 dark:bg-cyan-900/20 border border-cyan-200 dark:border-cyan-800 rounded-lg p-4 flex items-start justify-between"
          >
            <div>
              <h2 className="text-sm font-semibold text-cyan-800 dark:text-cyan-200">
                Welcome to the new CommandMate UI
              </h2>
              <p className="text-sm text-cyan-700 dark:text-cyan-300 mt-1">
                The interface has been reorganized. Repositories, Sessions, and External Apps now have their own dedicated pages accessible from the navigation.
              </p>
            </div>
            <button
              onClick={dismissBanner}
              className="ml-4 text-cyan-600 dark:text-cyan-400 hover:text-cyan-800 dark:hover:text-cyan-200"
              aria-label="Dismiss banner"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        )}

        {/* Page heading */}
        <div className="mb-8">
          <h1 className="mb-2">CommandMate</h1>
          <p className="text-base text-gray-600 dark:text-gray-400">
            A local control plane for agent CLIs — orchestration and visibility on top of Claude Code, Codex, Gemini CLI, and more.
          </p>
        </div>

        {/* Session Summary */}
        <div className="mb-8">
          <h2 className="text-lg font-semibold mb-4 text-gray-900 dark:text-gray-100">Session Overview</h2>
          <HomeSessionSummary worktrees={worktrees} />
        </div>

        {/* Shortcut Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
          {SHORTCUT_CARDS.map((card) => (
            <Link
              key={card.href}
              href={card.href}
              className="bg-white dark:bg-gray-800 rounded-lg p-6 border border-gray-200 dark:border-gray-700 hover:border-cyan-300 dark:hover:border-cyan-700 transition-colors group"
              data-testid={`shortcut-${card.title.toLowerCase()}`}
            >
              <div className="text-gray-400 dark:text-gray-500 group-hover:text-cyan-600 dark:group-hover:text-cyan-400 transition-colors mb-3">
                {card.icon}
              </div>
              <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-1">{card.title}</h3>
              <p className="text-xs text-gray-500 dark:text-gray-400">{card.description}</p>
            </Link>
          ))}
        </div>
      </div>
    </AppShell>
  );
}
