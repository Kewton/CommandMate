/**
 * Worktree Detail Page
 * Displays detailed information about a specific worktree
 *
 * Issue #2643: 開いたブランチを記録する（`/` がここへ戻すため）。
 */

'use client';

import { useEffect } from 'react';
import { useParams } from 'next/navigation';
import { AppShell } from '@/components/layout';
import { WorktreeDetailRefactored } from '@/components/worktree/WorktreeDetailRefactored';
import { writeLastOpenedWorktreeId } from '@/lib/last-opened-worktree';

export default function WorktreeDetailPage() {
  const params = useParams();
  const worktreeId = params.id as string;

  useEffect(() => {
    writeLastOpenedWorktreeId(worktreeId);
  }, [worktreeId]);

  return (
    <AppShell>
      <WorktreeDetailRefactored worktreeId={worktreeId} />
    </AppShell>
  );
}
