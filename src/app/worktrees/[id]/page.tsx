/**
 * Worktree Detail Page
 * Displays detailed information about a specific worktree
 */

'use client';

import { useParams } from 'next/navigation';
import { AppShell } from '@/components/layout';
import { WorktreeDetailRefactored } from '@/components/worktree/WorktreeDetailRefactored';
import { SidebarProvider } from '@/contexts/SidebarContext';
import { WorktreeSelectionProvider } from '@/contexts/WorktreeSelectionContext';

export default function WorktreeDetailPage() {
  const params = useParams();
  const worktreeId = params.id as string;

  return (
    <SidebarProvider>
      <WorktreeSelectionProvider>
        <AppShell>
          <WorktreeDetailRefactored worktreeId={worktreeId} />
        </AppShell>
      </WorktreeSelectionProvider>
    </SidebarProvider>
  );
}
