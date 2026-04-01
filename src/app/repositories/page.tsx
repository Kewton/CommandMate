/**
 * Repositories Page (/repositories)
 *
 * Issue #600: UX refresh - Repository management.
 * Uses existing RepositoryManager component directly.
 */

'use client';

import { AppShell } from '@/components/layout';
import { RepositoryManager } from '@/components/repository';

export default function RepositoriesPage() {
  return (
    <AppShell>
      <div className="container-custom py-8 overflow-auto h-full">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-2">Repositories</h1>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            Manage repositories and worktrees.
          </p>
        </div>

        <RepositoryManager />
      </div>
    </AppShell>
  );
}
