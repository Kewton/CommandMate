/**
 * WorktreeDetailHeader Component
 *
 * Issue #600: UX refresh - extracted from WorktreeDetailRefactored.tsx
 * Displays Repository name, Branch name, Agent, Status, and Next Action.
 *
 * Visibility rule: All fields are always visible for at-a-glance context.
 */

'use client';

import React, { memo } from 'react';
import { getCliToolDisplayName, type CLIToolType } from '@/lib/cli-tools/types';
import type { SessionStatus } from '@/lib/detection/status-detector';

/**
 * Props for WorktreeDetailHeader component.
 */
export interface WorktreeDetailHeaderProps {
  /** Repository name */
  repositoryName: string;
  /** Branch name */
  branchName: string;
  /** Active CLI tool ID */
  cliToolId: CLIToolType;
  /** Current session status */
  sessionStatus: SessionStatus | null;
  /** Next action display text (from getNextAction()) */
  nextAction: string;
}

/**
 * Status indicator color mapping.
 */
function getStatusColor(status: SessionStatus | null): string {
  switch (status) {
    case 'running':
      return 'bg-green-500';
    case 'waiting':
      return 'bg-yellow-500';
    case 'ready':
      return 'bg-cyan-500';
    case 'idle':
    case null:
      return 'bg-gray-400';
    default: {
      const _exhaustive: never = status;
      void _exhaustive;
      return 'bg-gray-400';
    }
  }
}

/**
 * WorktreeDetailHeader - Displays key worktree context information.
 *
 * All fields (Repository, Branch, Agent, Status, Next Action) are always
 * visible to provide immediate context without requiring user interaction.
 */
export const WorktreeDetailHeader = memo(function WorktreeDetailHeader({
  repositoryName,
  branchName,
  cliToolId,
  sessionStatus,
  nextAction,
}: WorktreeDetailHeaderProps) {
  const statusColor = getStatusColor(sessionStatus);
  const toolName = getCliToolDisplayName(cliToolId);

  return (
    <div
      data-testid="worktree-detail-header"
      className="flex items-center gap-3 px-4 py-2 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700 text-sm overflow-x-auto"
    >
      {/* Repository */}
      <span
        data-testid="header-repo-name"
        className="text-gray-500 dark:text-gray-400 truncate flex-shrink-0"
      >
        {repositoryName}
      </span>

      <span className="text-gray-300 dark:text-gray-600">/</span>

      {/* Branch */}
      <span
        data-testid="header-branch-name"
        className="font-medium text-gray-900 dark:text-gray-100 truncate"
      >
        {branchName}
      </span>

      {/* Agent badge */}
      <span className="px-2 py-0.5 text-xs rounded bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 flex-shrink-0">
        {toolName}
      </span>

      {/* Status indicator */}
      <span className="flex items-center gap-1 flex-shrink-0">
        <span className={`w-2 h-2 rounded-full ${statusColor}`} />
        <span className="text-gray-600 dark:text-gray-400 capitalize">
          {sessionStatus ?? 'idle'}
        </span>
      </span>

      {/* Next action */}
      <span
        data-testid="header-next-action"
        className="ml-auto text-gray-500 dark:text-gray-400 truncate flex-shrink-0"
      >
        {nextAction}
      </span>
    </div>
  );
});
