/**
 * Home Page (/)
 *
 * Issue #600: UX refresh - Mission Control / Inbox.
 * Issue #1052: Bento-grid dashboard — Session Overview + Recent sessions,
 * ToDo, and compact quick actions arranged in a CSS grid on desktop and a
 * single stacked column on mobile (Tailwind breakpoints, no useIsMobile JS
 * branch). The welcome banner stays outside the grid at the top.
 *
 * Session data is read from the shared worktrees cache
 * (`useWorktreesCacheContext`) instead of a page-local fetch, keeping a single
 * poller against `/api/worktrees` (Issue #709) and adding no new API.
 */

'use client';

import { useState, useEffect, useCallback } from 'react';
import { AppShell } from '@/components/layout';
import { Button } from '@/components/ui';
import { useWorktreesCacheContext } from '@/components/providers/WorktreesCacheProvider';
import { SessionOverviewTile } from '@/components/home/SessionOverviewTile';
import { TodoWidget } from '@/components/home/TodoWidget';
import { HomeQuickActions } from '@/components/home/HomeQuickActions';

/**
 * localStorage key for dismissing the welcome banner.
 */
const BANNER_DISMISSED_KEY = 'commandmate-home-banner-dismissed';

export default function Home() {
  const { worktrees } = useWorktreesCacheContext();
  const [bannerDismissed, setBannerDismissed] = useState(true);

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
        {/* Welcome banner (dismissible) — kept outside the bento grid */}
        {!bannerDismissed && (
          <div
            data-testid="welcome-banner"
            className="mb-6 bg-accent-50 dark:bg-accent-900/20 border border-accent-200 dark:border-accent-800 rounded-lg p-4 flex items-start justify-between"
          >
            <div>
              <h2 className="text-sm font-semibold text-accent-800 dark:text-accent-200">
                Welcome to the new CommandMate UI
              </h2>
              <p className="text-sm text-accent-700 dark:text-accent-300 mt-1">
                The interface has been reorganized. Repositories, Sessions, and External Apps now have their own dedicated pages accessible from the navigation.
              </p>
            </div>
            <Button
              variant="ghost"
              onClick={dismissBanner}
              aria-label="Dismiss banner"
              className="ml-4 p-0 text-accent-600 dark:text-accent-400 hover:bg-transparent dark:hover:bg-transparent hover:text-accent-800 dark:hover:text-accent-200"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </Button>
          </div>
        )}

        {/* Page heading */}
        <div className="mb-8">
          <h1 className="mb-2">CommandMate</h1>
          <p className="text-base text-gray-600 dark:text-gray-400">
            A local control plane for agent CLIs — orchestration and visibility on top of Claude Code, Codex, Gemini CLI, and more.
          </p>
        </div>

        {/* Bento grid: 12-col on desktop, single stacked column on mobile.
            DOM order (mobile stack): Session Overview → ToDo → Quick actions. */}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-12" data-testid="home-bento-grid">
          {/* Session Overview + Recent sessions — large tile */}
          <div className="md:col-span-8">
            <SessionOverviewTile worktrees={worktrees} />
          </div>

          {/* ToDo — medium tile */}
          <div className="md:col-span-4">
            <TodoWidget />
          </div>

          {/* Quick actions — compact icon row spanning the full width */}
          <div className="md:col-span-12">
            <HomeQuickActions />
          </div>
        </div>
      </div>
    </AppShell>
  );
}
