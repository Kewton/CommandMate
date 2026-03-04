'use client';

import { useState, useCallback } from 'react';
import { AppShell } from '@/components/layout';
import { WorktreeList } from '@/components/worktree';
import { RepositoryManager } from '@/components/repository';
import { ExternalAppsManager } from '@/components/external-apps';

export default function Home() {
  const [refreshTrigger, setRefreshTrigger] = useState(0);

  const handleRepositoryAdded = useCallback(() => {
    // Trigger worktree list refresh
    setRefreshTrigger((prev) => prev + 1);
  }, []);

  return (
    <AppShell>
      <div className="container-custom py-8 overflow-auto h-full">
        <div className="mb-8">
          <h1 className="mb-2">CommandMate</h1>
          <p className="text-base text-gray-600 dark:text-gray-400">
            Stop managing terminal tabs. Start running issue-driven development.
            <br />
            CommandMate helps you refine issues, run them in parallel, switch agents when needed, and keep work moving wherever you are.
          </p>
        </div>

        {/* Repository Management */}
        <div className="mb-8">
          <RepositoryManager onRepositoryAdded={handleRepositoryAdded} />
        </div>

        {/* Worktree List */}
        <WorktreeList key={refreshTrigger} />

        {/* External Apps Management */}
        <div className="mt-8">
          <ExternalAppsManager />
        </div>
      </div>
    </AppShell>
  );
}
