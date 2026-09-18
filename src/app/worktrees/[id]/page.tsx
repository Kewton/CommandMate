/**
 * Worktree Detail Page
 * Displays detailed information about a specific worktree
 *
 * Issue #2643: 開いたブランチを記録する（`/` がここへ戻すため）。
 */

'use client';

import { useEffect } from 'react';
import { useParams } from 'next/navigation';
import { WorktreeDetailRefactored } from '@/components/worktree/WorktreeDetailRefactored';
import { writeLastOpenedWorktreeId } from '@/lib/last-opened-worktree';

export default function WorktreeDetailPage() {
  const params = useParams();
  const worktreeId = params.id as string;

  useEffect(() => {
    writeLastOpenedWorktreeId(worktreeId);
  }, [worktreeId]);

  return (
    <WorktreeDetailRefactored worktreeId={worktreeId} />
  );
}
