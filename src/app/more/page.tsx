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
import { Card } from '@/components/ui';
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
              className="block"
              data-testid="more-link-repositories"
            >
              <Card hover className="transition-colors hover:border-accent-300 dark:hover:border-accent-700">
                <div className="text-sm font-medium text-gray-900 dark:text-gray-100">Repositories</div>
                <div className="text-xs text-gray-500 dark:text-gray-400">Manage repositories and worktrees</div>
              </Card>
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
          <Card>
            <div className="text-sm text-gray-600 dark:text-gray-400">
              CommandMate - A local control plane for agent CLIs.
            </div>
          </Card>
        </div>
      </div>
    </AppShell>
  );
}
