/**
 * GitPane shared primitives (Issue #922)
 *
 * Small presentational atoms and constants shared across the extracted GitPane
 * panels (status / changes / history / branches / stash / danger zone). Moved
 * verbatim out of the former GitPane god-component so each panel file can import
 * them without re-declaring. Behavior is unchanged.
 */

'use client';

import { memo } from 'react';
import { Sparkles } from 'lucide-react';
import type { ChangedFile } from '@/types/git';

// ============================================================================
// Status -> color mapping (Issue #780)
// Exhaustive Record over ChangedFile['status']; untracked/unmerged get distinct
// colors so they never silently fall back to the modified yellow.
// ============================================================================

export const STATUS_TEXT_COLOR: Record<ChangedFile['status'], string> = {
  added: 'text-green-600 dark:text-green-400',
  modified: 'text-yellow-600 dark:text-yellow-400',
  deleted: 'text-red-600 dark:text-red-400',
  renamed: 'text-info',
  untracked: 'text-teal-600 dark:text-teal-400',
  unmerged: 'text-orange-600 dark:text-orange-400',
};

/**
 * Working-tree diff mode for the Changes section (Issue #780). Identifies which
 * git working-tree diff the per-file Diff button should request.
 */
export type ChangesDiffMode = 'staged' | 'unstaged' | 'untracked';

/** Number of diff lines shown in the Changes inline preview (Issue #816, C). */
export const CHANGES_PREVIEW_LINES = 20;

export const RefreshIcon = memo(function RefreshIcon() {
  return (
    <svg
      className="w-4 h-4"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
      />
    </svg>
  );
});

/**
 * "Ask AI" button (Issue #817). Drafts a context-rich prompt into the active CLI
 * tab's MessageInput composer (no auto-send) so the user can review/edit before
 * sending. Presentational only: the call site owns the `onClick` (it builds the
 * prompt from a `git-ai-prompt-templates` builder and closes any open dialog),
 * and gates rendering on whether an `onInsertToMessage` handler is wired.
 */
export const AskAiButton = memo(function AskAiButton({
  onClick,
  disabled = false,
  testId,
  className = '',
}: {
  onClick: () => void;
  disabled?: boolean;
  testId?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded border border-violet-300 dark:border-violet-700 text-violet-700 dark:text-violet-300 hover:bg-violet-50 dark:hover:bg-violet-900/30 disabled:opacity-50 disabled:cursor-not-allowed ${className}`}
      data-testid={testId}
      title="現在の状況を AI チャットに下書きします（自動送信はされません）"
    >
      <Sparkles size={14} aria-hidden="true" />
      Ask AI
    </button>
  );
});

/**
 * Render a single diff line with appropriate color
 */
export const DiffLine = memo(function DiffLine({ line }: { line: string }) {
  let className = 'whitespace-pre font-mono text-xs';

  if (line.startsWith('+') && !line.startsWith('+++')) {
    className += ' text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-900/20';
  } else if (line.startsWith('-') && !line.startsWith('---')) {
    className += ' text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-900/20';
  } else if (line.startsWith('@@')) {
    className += ' text-info';
  } else {
    className += ' text-foreground';
  }

  return <div className={className}>{line}</div>;
});

/**
 * Inline error display for sub-section errors
 */
export const InlineError = memo(function InlineError({ message }: { message: string }) {
  return (
    <div className="px-3 py-2 text-xs text-red-600 dark:text-red-400" role="alert">
      {message}
    </div>
  );
});
