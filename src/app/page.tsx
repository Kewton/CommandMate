/**
 * Home Page (/)
 *
 * Issue #600: UX refresh - Mission Control / Inbox.
 * Issue #1052: Bento-grid dashboard — Session Overview + Recent sessions,
 * ToDo, and compact quick actions arranged in a CSS grid on desktop and a
 * single stacked column on mobile (Tailwind breakpoints, no useIsMobile JS
 * branch).
 * Issue #1072: First-fold reclaim — the stale welcome banner is gone and the
 * tautological "CommandMate" h1 is demoted to a functional "Overview" heading
 * with a live session subline (see HomeHeading). Future announcements should be
 * reintroduced as a version-keyed localStorage Announcement component rather
 * than a hard-coded dismissible banner.
 *
 * Session data is read from the shared worktrees cache
 * (`useWorktreesCacheContext`) instead of a page-local fetch, keeping a single
 * poller against `/api/worktrees` (Issue #709) and adding no new API.
 */

'use client';

import { AppShell } from '@/components/layout';
import { useWorktreesCacheContext } from '@/components/providers/WorktreesCacheProvider';
import { HomeHeading } from '@/components/home/HomeHeading';
import { SessionOverviewTile } from '@/components/home/SessionOverviewTile';
import { TodoWidget } from '@/components/home/TodoWidget';
import { HomeQuickActions } from '@/components/home/HomeQuickActions';

export default function Home() {
  const { worktrees, isLoading } = useWorktreesCacheContext();
  // [Issue #1118] Skeletons only on the very first load; once the cache has
  // data, poll re-fetches keep the rendered content (non-blocking pattern).
  const isFirstLoad = isLoading && worktrees.length === 0;

  return (
    <AppShell>
      <div className="container-custom py-8 overflow-auto h-full">
        {/* Page heading */}
        <HomeHeading worktrees={worktrees} />

        {/* Bento grid: 12-col on desktop, single stacked column on mobile.
            DOM order (mobile stack): Session Overview → ToDo → Quick actions. */}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-12" data-testid="home-bento-grid">
          {/* Session Overview + Recent sessions — large tile */}
          <div className="md:col-span-8">
            <SessionOverviewTile worktrees={worktrees} isLoading={isFirstLoad} />
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
