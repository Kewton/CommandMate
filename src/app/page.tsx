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
            A local control plane for agent CLIs — orchestration and visibility on top of Claude Code, Codex, Gemini CLI, and more.
            <br />
            CommandMate does not replace tmux, Git worktrees, or your terminal. It makes them easier to manage across sessions and worktrees.
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
