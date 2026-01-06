/**
 * Worktree Detail Page
 * Displays detailed information about a specific worktree
 */

'use client';

import { useParams } from 'next/navigation';
import { MainLayout } from '@/components/layout';
import { WorktreeDetailRefactored } from '@/components/worktree/WorktreeDetailRefactored';

export default function WorktreeDetailPage() {
  const params = useParams();
  const worktreeId = params.id as string;

  return (
    <MainLayout>
      <WorktreeDetailRefactored worktreeId={worktreeId} />
    </MainLayout>
  );
}
