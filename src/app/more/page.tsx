/**
 * More Page (/more)
 *
 * Issue #600: UX refresh - Settings, External Apps, Help, Auth.
 * Contains ExternalAppsManager moved from Home page.
 * On mobile, Repositories is accessible from here.
 */

'use client';

import Link from 'next/link';
import { AppShell } from '@/components/layout';
import { ExternalAppsManager } from '@/components/external-apps';

export default function MorePage() {
  return (
    <AppShell>
      <div className="container-custom py-8 overflow-auto h-full">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-2">More</h1>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            Settings, external apps, and more.
          </p>
        </div>

        {/* Quick Links */}
        <div className="mb-8">
          <h2 className="text-lg font-semibold mb-4 text-gray-900 dark:text-gray-100">Quick Links</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Link
              href="/repositories"
              className="bg-white dark:bg-gray-800 rounded-lg p-4 border border-gray-200 dark:border-gray-700 hover:border-cyan-300 dark:hover:border-cyan-700 transition-colors"
              data-testid="more-link-repositories"
            >
              <div className="text-sm font-medium text-gray-900 dark:text-gray-100">Repositories</div>
              <div className="text-xs text-gray-500 dark:text-gray-400">Manage repositories and worktrees</div>
            </Link>
          </div>
        </div>

        {/* External Apps */}
        <div className="mb-8">
          <h2 className="text-lg font-semibold mb-4 text-gray-900 dark:text-gray-100">External Apps</h2>
          <ExternalAppsManager />
        </div>

        {/* About */}
        <div className="mb-8">
          <h2 className="text-lg font-semibold mb-4 text-gray-900 dark:text-gray-100">About</h2>
          <div className="bg-white dark:bg-gray-800 rounded-lg p-4 border border-gray-200 dark:border-gray-700">
            <div className="text-sm text-gray-600 dark:text-gray-400">
              CommandMate - A local control plane for agent CLIs.
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
