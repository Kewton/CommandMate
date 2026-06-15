/**
 * Repositories Page (/repositories)
 *
 * Issue #600: UX refresh - Repository management.
 * Issue #644: Repository list + inline display_name edit.
 *   - refreshKey is incremented when Add/Sync finishes in RepositoryManager
 *     so RepositoryList refetches automatically.
 *   - It is also incremented when a row's display_name is updated so that
 *     other screens reading the same data via worktreeApi can be refreshed
 *     indirectly (via parent refreshKey bump).
 * Issue #880: RepositoryManager (Add Repository / Sync All actions) is placed
 *   ABOVE RepositoryList so the action buttons appear at the top of the page.
 */

'use client';

import { useCallback, useState } from 'react';
import { AppShell } from '@/components/layout';
import { RepositoryList, RepositoryManager } from '@/components/repository';

export default function RepositoriesPage() {
  const [refreshKey, setRefreshKey] = useState(0);

  const handleChanged = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  return (
    <AppShell>
      <div className="container-custom py-8 overflow-auto h-full">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-2">Repositories</h1>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            Manage repositories and worktrees.
          </p>
        </div>

        <div className="space-y-6">
          <RepositoryManager onRepositoryAdded={handleChanged} />
          <RepositoryList refreshKey={refreshKey} onChanged={handleChanged} />
        </div>
      </div>
    </AppShell>
  );
}
